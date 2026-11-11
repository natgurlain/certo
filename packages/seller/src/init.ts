import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Account } from '@near-js/accounts';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { ed25519FromSeed, formatUsdc, fromHex, ONE_NEAR, toHex, type CertoChain } from '@certo/core';

/** The only contract methods the answer bot's key may call. */
export const BOT_METHODS = ['answer', 'cure'];
/** Gas allowance of the bot key (0.25 NEAR). */
export const BOT_ALLOWANCE_YOCTO = 250_000_000_000_000_000_000_000n;

/** Adds a function-call key (if missing) for `BOT_METHODS` on the contract; returns the tx hash, or undefined if it existed. */
export type BotKeyAdder = (publicKey: string) => Promise<string | undefined>;

/** `BotKeyAdder` signed with the seller's full-access key (used once, by `seller init`). */
export function nearBotKeyAdder(o: { rpcUrl: string; accountId: string; privateKey: string; contractId: string }): BotKeyAdder {
  const provider = new JsonRpcProvider({ url: o.rpcUrl });
  const account = new Account(o.accountId, provider, KeyPairSigner.fromSecretKey(o.privateKey as KeyPairString));
  return async (publicKey) => {
    const has = await provider.viewAccessKey(o.accountId, publicKey).then(() => true, () => false);
    if (has) return undefined;
    const r = await account.addFunctionCallAccessKey({ publicKey, contractId: o.contractId, methodNames: BOT_METHODS, allowance: BOT_ALLOWANCE_YOCTO });
    return r.transaction_outcome.id;
  };
}

export type InitChain = Pick<
  CertoChain,
  'contractId' | 'tokenId' | 'accountId' | 'network' | 'getConfig' | 'getSeller' | 'getTerms' | 'ftBalanceOf' | 'registerSeller' | 'addTerms' | 'depositBond'
>;

export interface SellerInitOptions {
  /** Bond to deposit, base units. */
  bond: string;
  termsText: string;
  termsId?: string;
  /** Price the snippet quotes, base units (default 0.40 USDC). */
  price?: string;
  windowMs?: number;
  /** Allow content disputes judged by the AI panel (experimental; default false: refunds by rule only). */
  panel?: boolean;
  requiredFields?: string[];
  /** Receipt-key seed file (hex); created with mode 0600 when missing. */
  keyFile: string;
  /** Answer-bot key: a function-call key limited to `answer` and `cure`, kept in `file` (created when missing). */
  botKey?: { file: string; add: BotKeyAdder };
  out?: (line: string) => void;
}

/**
 * `certo seller init`: receipt key, `register_seller` (1 NEAR attached),
 * `add_terms`, bond deposit, then the `protect()` snippet. Steps already done
 * (same key, same terms text) are skipped, so it can be re-run.
 */
export async function sellerInit(chain: InitChain, o: SellerInitOptions): Promise<{ receiptPubkey: string; snippet: string }> {
  const out = o.out ?? ((l: string) => console.log(l));
  const seller = chain.accountId;
  if (!seller) throw new Error('seller init needs a signing account (SELLER_ACCOUNT, SELLER_PRIVATE_KEY)');
  const termsId = o.termsId ?? 'v1';
  const price = o.price ?? '400000';
  const cfg = await chain.getConfig();
  if (Buffer.byteLength(o.termsText) > cfg.max_terms) throw new Error(`terms text is ${Buffer.byteLength(o.termsText)} bytes; the contract allows ${cfg.max_terms}`);
  if (BigInt(o.bond) < BigInt(cfg.min_bond)) throw new Error(`bond ${formatUsdc(o.bond)} USDC is below the contract minimum ${formatUsdc(cfg.min_bond)}`);

  if (!existsSync(o.keyFile)) {
    mkdirSync(dirname(o.keyFile), { recursive: true });
    writeFileSync(o.keyFile, `${toHex(new Uint8Array(randomBytes(32)))}\n`, { mode: 0o600, flag: 'wx' });
    out(`receipt key: generated ${o.keyFile} (keep it secret; it signs your receipts)`);
  } else {
    out(`receipt key: using ${o.keyFile}`);
  }
  const key = ed25519FromSeed(fromHex(readFileSync(o.keyFile, 'utf8').trim()));
  const pub = toHex(key.publicKey);

  const s = await chain.getSeller(seller);
  if (s && s.receipt_pubkey !== pub) throw new Error(`${seller} is already registered with receipt key ${s.receipt_pubkey}; pass --key-file with that key's seed`);
  if (s) {
    out(`register: ${seller} already registered`);
  } else {
    const tx = await chain.registerSeller({ receipt_pubkey: pub, window_ms: o.windowMs ?? 120_000 }, ONE_NEAR);
    out(`register: ${seller} registered, 1 NEAR deposit attached (tx ${tx.txHash})`);
  }

  const t = await chain.getTerms(seller, termsId);
  if (t && t.text !== o.termsText) throw new Error(`terms ${termsId} already exist with other text (terms are immutable); choose another --terms-id`);
  if (t) {
    out(`terms: ${termsId} already published`);
  } else {
    const tx = await chain.addTerms({
      terms_id: termsId, text: o.termsText, required_fields: o.requiredFields ?? [], as_of_field: null, max_age_s: null, panel: o.panel ?? false,
    });
    out(`terms: ${termsId} published, AI panel ${o.panel ? 'on (experimental)' : 'off: refunds by rule only (--panel adds the experimental AI panel)'} (tx ${tx.txHash})`);
  }

  if (BigInt(o.bond) > 0n) {
    const have = await chain.ftBalanceOf(seller);
    if (BigInt(have) < BigInt(o.bond)) throw new Error(`bond needs ${formatUsdc(o.bond)} USDC on ${chain.tokenId}; ${seller} holds ${formatUsdc(have)}`);
    const tx = await chain.depositBond(o.bond);
    out(`bond: deposited ${formatUsdc(o.bond)} USDC (tx ${tx.txHash})`);
  }

  if (o.botKey) {
    if (!existsSync(o.botKey.file)) {
      writeFileSync(o.botKey.file, `${KeyPair.fromRandom('ed25519').toString()}\n`, { mode: 0o600, flag: 'wx' });
    }
    const pk = KeyPair.fromString(readFileSync(o.botKey.file, 'utf8').trim() as KeyPairString).getPublicKey().toString();
    const tx = await o.botKey.add(pk);
    out(`bot key: ${pk} in ${o.botKey.file}: function call only, receiver ${chain.contractId}, methods ${BOT_METHODS.join(', ')}, `
      + `gas allowance ${Number(BOT_ALLOWANCE_YOCTO / 10n ** 21n) / 1000} NEAR, no deposits${tx ? ` (tx ${tx})` : ' (already added)'}`);
  }

  const signer = o.botKey
    ? [
      `const chain = chainFromEnv(process.env); // views only: protect() needs no key`,
      `const bot = chainFromEnv(process.env, { accountId: '${seller}', privateKey: readFileSync('${o.botKey.file}', 'utf8').trim() }); // may call only answer and cure`,
    ]
    : [
      `const chain = chainFromEnv(process.env, { accountId: '${seller}', privateKey: process.env.SELLER_PRIVATE_KEY! });`,
      `const bot = chain;`,
    ];
  const snippet = [
    `import { readFileSync } from 'node:fs';`,
    `import express from 'express';`,
    `import { chainFromEnv, fromHex } from '@certo/core';`,
    `import { createAnswerBot, protect } from '@certo/seller';`,
    ``,
    `// env: NEAR_RPC_URL, NEAR_NETWORK, CERTO_CONTRACT=${chain.contractId}, CERTO_TOKEN=${chain.tokenId}${o.botKey ? '' : ', SELLER_PRIVATE_KEY'}`,
    ...signer,
    `const mw = protect({ contract: chain, seller: '${seller}', termsId: '${termsId}', price: '${price}', // ${formatUsdc(price)} USDC`,
    `  receiptKey: fromHex(readFileSync('${o.keyFile}', 'utf8').trim()) });`,
    `const app = express();`,
    `app.get('/v1/answer', mw, (_req, res) => void res.json({ answer: 42 }));`,
    `app.listen(8080);`,
    `createAnswerBot({ chain: bot, store: mw.store }).start(1000); // answers disputes (offer 0%), cures non-delivery claims`,
  ].join('\n');
  out('');
  out('protect() snippet:');
  out(snippet);
  return { receiptPubkey: pub, snippet };
}
