/**
 * NEAR testnet path of the demo: configuration from the environment / `.env`,
 * a read-only dry run, an idempotent deployment (`scripts/deploy-testnet.ts`)
 * and the `DemoWorld` the runner uses for `make testnet-demo`.
 * See docs/TESTNET.md for the accounts and the steps.
 *
 * Nothing here runs on the sandbox path. The dry run sends only
 * `view_account` queries; `ensureDeployed` signs transactions with the keys
 * from the environment and never reads any other key store.
 */
import { existsSync, readFileSync } from 'node:fs';
import { Account } from '@near-js/accounts';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { actionCreators } from '@near-js/transactions';
import {
  ENV_PREFIX, FEE_BPS, ONE_NEAR, PRODUCT_ID, TGAS, ed25519FromSeed, formatUsdc, sha256, toHex, type Ed25519Key,
} from '@makegood/core';
import { loadDemo, realKeys, syntheticJurorsFile, type PanelPlan } from './fixtures.js';
import { demoConfig, repoFile, WASM, type JurorArg } from './sandbox.js';
import { DEMO_BOND, DEMO_BUYER_FUNDS, TracedChain, type DemoWorld } from './world.js';

export const DEFAULT_RPC = 'https://rpc.testnet.fastnear.com';
export const DEFAULT_EXPLORER = 'https://testnet.nearblocks.io';
/** Seller answer / cure window on testnet (DESIGN 4.2). */
export const TESTNET_ANSWER_MS = 30_000;

export type Role = 'owner' | 'contract' | 'token' | 'resolver' | 'chainfacts' | 'cheapfacts' | 'scout' | 'scout-liar';

interface RoleSpec {
  role: Role;
  idVar: string;
  keyVar: string;
  def: string;
  keyRequired: boolean;
  /** Smallest NEAR balance the dry run accepts for this account. */
  minNear: number;
  what: string;
}

const P = ENV_PREFIX;
export const ROLES: RoleSpec[] = [
  { role: 'owner', idVar: `${P}OWNER`, keyVar: `${P}OWNER_PRIVATE_KEY`, def: `${PRODUCT_ID}.testnet`, keyRequired: false, minNear: 0.1, what: 'contract owner; key only needed to change juror keys (set_jurors)' },
  { role: 'contract', idVar: `${P}CONTRACT`, keyVar: `${P}CONTRACT_PRIVATE_KEY`, def: `v1.${PRODUCT_ID}.testnet`, keyRequired: true, minNear: 5, what: `${PRODUCT_ID} contract (code storage ~3.5 NEAR)` },
  { role: 'token', idVar: `${P}TOKEN`, keyVar: `${P}TOKEN_PRIVATE_KEY`, def: `usdc.${PRODUCT_ID}.testnet`, keyRequired: true, minNear: 2, what: 'mock USDC token (code storage ~1.7 NEAR)' },
  { role: 'resolver', idVar: 'RESOLVER_ACCOUNT', keyVar: 'RESOLVER_PRIVATE_KEY', def: `resolver.${PRODUCT_ID}.testnet`, keyRequired: true, minNear: 0.5, what: 'panel resolver (submits resolve)' },
  { role: 'chainfacts', idVar: 'SELLER_CHAINFACTS_ACCOUNT', keyVar: 'SELLER_CHAINFACTS_PRIVATE_KEY', def: `chainfacts.sellers.${PRODUCT_ID}.testnet`, keyRequired: true, minNear: 1.5, what: 'honest seller (1 NEAR registration deposit)' },
  { role: 'cheapfacts', idVar: 'SELLER_CHEAPFACTS_ACCOUNT', keyVar: 'SELLER_CHEAPFACTS_PRIVATE_KEY', def: `cheapfacts.sellers.${PRODUCT_ID}.testnet`, keyRequired: true, minNear: 1.5, what: 'wrong-token seller (1 NEAR registration deposit)' },
  { role: 'scout', idVar: 'BUYER_SCOUT_ACCOUNT', keyVar: 'BUYER_SCOUT_PRIVATE_KEY', def: `scout.${PRODUCT_ID}.testnet`, keyRequired: true, minNear: 0.5, what: 'buyer agent' },
  { role: 'scout-liar', idVar: 'BUYER_SCOUT_LIAR_ACCOUNT', keyVar: 'BUYER_SCOUT_LIAR_PRIVATE_KEY', def: `scout-liar.${PRODUCT_ID}.testnet`, keyRequired: true, minNear: 0.5, what: 'lying buyer agent' },
];

export interface TestnetAccount {
  accountId: string;
  privateKey?: string;
  /** Public key of `privateKey` (not secret; shown so it can be compared with the wallet). */
  publicKey?: string;
}

export interface TestnetConfig {
  rpcUrl: string;
  explorerUrl: string;
  accounts: Record<Role, TestnetAccount>;
  /** Blocking configuration errors (empty = usable). */
  problems: string[];
  notes: string[];
}

/** Load `.env` at the repository root into `process.env` (existing variables win). */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = repoFile('.env');
  if (!existsSync(path)) return null;
  if (env === process.env) process.loadEnvFile(path);
  else {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && env[m[1]!] === undefined) env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return path;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(b: Uint8Array): string {
  let n = b.length ? BigInt(`0x${toHex(b)}`) : 0n;
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const x of b) { if (x !== 0) break; s = `1${s}`; }
  return s;
}
export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error('not base58');
    n = n * 58n + BigInt(v);
  }
  const hex = n === 0n ? '' : n.toString(16);
  const body = Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  return new Uint8Array([...new Uint8Array(zeros), ...body]);
}

/** NEAR account id rules (nomicon): 2–64 chars, lower-case alphanumeric parts separated by `.`, `-`, `_`. */
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

/** Check an `ed25519:<base58>` NEAR secret key (64 bytes: seed ‖ public key). Returns the public key or an error. */
export function checkSecretKey(v: string): { publicKey: string } | { error: string } {
  if (!v.startsWith('ed25519:')) return { error: 'must start with "ed25519:" (NEAR secret key format)' };
  let raw: Uint8Array;
  try { raw = base58Decode(v.slice(8)); } catch { return { error: 'not base58 after "ed25519:"' }; }
  if (raw.length !== 64) return { error: `decodes to ${raw.length} bytes, expected 64 (seed + public key)` };
  try {
    const pk = KeyPair.fromString(v as KeyPairString).getPublicKey();
    if (toHex(pk.data) !== toHex(raw.slice(32))) return { error: 'the public half does not match the seed' };
    return { publicKey: pk.toString() };
  } catch (e) {
    return { error: `not a usable key (${(e as Error).message})` };
  }
}

/** Read and validate the testnet configuration. No network access. */
export function readTestnetConfig(env: NodeJS.ProcessEnv = process.env): TestnetConfig {
  const problems: string[] = [];
  const notes: string[] = [];
  if (env.NEAR_NETWORK && env.NEAR_NETWORK !== 'testnet') problems.push(`NEAR_NETWORK=${env.NEAR_NETWORK}: this path runs on testnet only (mainnet is out of scope)`);
  const rpcUrl = (env.NEAR_RPC_URL || DEFAULT_RPC).replace(/\/$/, '');
  if (!/^https?:\/\//.test(rpcUrl)) problems.push(`NEAR_RPC_URL=${rpcUrl}: not an http(s) URL`);
  if (/mainnet/i.test(rpcUrl)) problems.push(`NEAR_RPC_URL=${rpcUrl}: looks like a mainnet RPC; use a testnet one`);
  const explorerUrl = (env.NEAR_EXPLORER_URL || DEFAULT_EXPLORER).replace(/\/$/, '');
  const accounts = {} as Record<Role, TestnetAccount>;
  const seen = new Map<string, string>();
  for (const r of ROLES) {
    const accountId = (env[r.idVar] || r.def).trim();
    if (!env[r.idVar]) notes.push(`${r.idVar} not set; using ${accountId}`);
    if (accountId.length < 2 || accountId.length > 64 || !ACCOUNT_RE.test(accountId)) problems.push(`${r.idVar}=${accountId}: not a valid NEAR account id`);
    else if (!accountId.endsWith('.testnet')) problems.push(`${r.idVar}=${accountId}: not a .testnet account`);
    if (seen.has(accountId)) problems.push(`${r.idVar} and ${seen.get(accountId)} are the same account (${accountId}); each role needs its own`);
    seen.set(accountId, r.idVar);
    const key = env[r.keyVar]?.trim();
    const a: TestnetAccount = { accountId };
    if (!key) {
      if (r.keyRequired) problems.push(`${r.keyVar} is empty (key of ${accountId}, ${r.what})`);
      else notes.push(`${r.keyVar} is empty: fine unless the juror keys on the contract must change`);
    } else {
      const k = checkSecretKey(key);
      if ('error' in k) problems.push(`${r.keyVar}: ${k.error}`);
      else { a.privateKey = key; a.publicKey = k.publicKey; }
    }
    accounts[r.role] = a;
  }
  return { rpcUrl, explorerUrl, accounts, problems, notes };
}

async function rpc<T>(url: string, method: string, params: unknown): Promise<{ result?: T; error?: { name?: string; cause?: { name?: string }; message?: string; data?: unknown } }> {
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: PRODUCT_ID, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
  return (await r.json()) as { result?: T; error?: { cause?: { name?: string }; message?: string } };
}

export const NO_CODE_HASH = '11111111111111111111111111111111';
export type AccountState = { exists: false } | { exists: true; amountYocto: bigint; codeHash: string; storageUsage: number };

/** Read-only `view_account` query. */
export async function viewAccount(rpcUrl: string, accountId: string): Promise<AccountState> {
  const j = await rpc<{ amount: string; code_hash: string; storage_usage: number }>(rpcUrl, 'query', { request_type: 'view_account', finality: 'final', account_id: accountId });
  if (j.error) {
    if (j.error.cause?.name === 'UNKNOWN_ACCOUNT') return { exists: false };
    throw new Error(`view_account ${accountId}: ${JSON.stringify(j.error).slice(0, 200)}`);
  }
  const v = j.result!;
  return { exists: true, amountYocto: BigInt(v.amount), codeHash: v.code_hash, storageUsage: v.storage_usage };
}

/** base58(sha256(wasm)): the `code_hash` an account shows after this wasm is deployed. */
export const codeHashOf = (wasm: string) => base58Encode(sha256(readFileSync(repoFile(wasm))));

const near = (yocto: bigint) => `${(Number(yocto / 10n ** 21n) / 1000).toFixed(3)} NEAR`;

/**
 * `--dry-run`: validate `.env`, account names and key formats, and check that
 * the RPC answers and each account exists with enough NEAR. Sends only
 * `view_account` queries. Returns the exit code (0 ready, 2 not ready).
 */
export async function dryRun(cfg: TestnetConfig, print: (l: string) => void = console.log): Promise<number> {
  print(`dry run: no transactions are sent; read-only view_account queries to ${cfg.rpcUrl}`);
  const rows: string[][] = [['role', 'account', 'key', 'on chain']];
  const rpcBad = cfg.problems.some((p) => p.startsWith('NEAR_RPC_URL=') || p.startsWith('NEAR_NETWORK='));
  let rpcOk = !rpcBad;
  let accountProblems = 0;
  const wasmHash: Partial<Record<Role, string>> = { contract: codeHashOf(WASM.makegood), token: codeHashOf(WASM.usdc) };
  for (const r of ROLES) {
    const a = cfg.accounts[r.role];
    const keyCol = a.privateKey ? `ok (${a.publicKey!.slice(0, 16)}…)` : cfg.problems.some((p) => p.startsWith(`${r.keyVar}:`)) ? 'INVALID' : r.keyRequired ? 'MISSING' : 'not set (optional)';
    let chainCol = rpcBad ? 'not queried (RPC setting rejected)' : '-';
    const badId = cfg.problems.some((p) => p.startsWith(`${r.idVar}=`));
    if (badId) chainCol = 'not queried (invalid account id)';
    else if (rpcOk) {
      try {
        const st = await viewAccount(cfg.rpcUrl, a.accountId);
        if (!st.exists) { chainCol = 'UNKNOWN_ACCOUNT (create it, docs/TESTNET.md step 2)'; accountProblems++; } else {
          const low = st.amountYocto < BigInt(Math.round(r.minNear * 1000)) * 10n ** 21n;
          if (low) accountProblems++;
          const code = st.codeHash === NO_CODE_HASH ? 'no code' : st.codeHash === wasmHash[r.role] ? `code = ${r.role === 'contract' ? WASM.makegood : WASM.usdc}` : `other code ${st.codeHash.slice(0, 8)}…`;
          chainCol = `exists, ${near(st.amountYocto)}${low ? ` (LOW: needs ≥ ${r.minNear} NEAR)` : ''}${r.role === 'contract' || r.role === 'token' ? `, ${code}` : ''}`;
          if (wasmHash[r.role] && st.codeHash !== NO_CODE_HASH && st.codeHash !== wasmHash[r.role]) accountProblems++;
        }
      } catch (e) {
        rpcOk = false;
        chainCol = `RPC ERROR: ${(e as Error).message}`;
      }
    }
    rows.push([r.idVar, a.accountId, keyCol, chainCol]);
  }
  const w = rows[0]!.map((_, c) => Math.max(...rows.map((row) => row[c]!.length)));
  for (const [i, row] of rows.entries()) {
    print(row.map((v, c) => v.padEnd(w[c]!)).join('  ').trimEnd());
    if (i === 0) print(w.map((n) => '-'.repeat(n)).join('  '));
  }
  for (const n of cfg.notes) print(`note: ${n}`);
  for (const p of cfg.problems) print(`CONFIG: ${p}`);
  print(`RPC ${cfg.rpcUrl}: ${rpcBad ? 'not queried' : rpcOk ? 'reachable' : 'NOT reachable'}`);
  const ok = rpcOk && cfg.problems.length === 0 && accountProblems === 0;
  print(ok
    ? 'DRY RUN OK: configuration complete, all accounts exist and are funded; `make testnet-demo` will deploy (if needed) and run the scenes'
    : `DRY RUN NOT READY: ${cfg.problems.length} configuration problem(s), ${accountProblems} account problem(s)${rpcOk || rpcBad ? '' : ', RPC unreachable'} (see docs/TESTNET.md)`);
  return ok ? 0 : 2;
}

/** Contract configuration on testnet: the demo's, with the 30 s answer window. */
export function testnetContractConfig(acceptGateway: boolean) {
  return { ...demoConfig(acceptGateway), answer_ms: TESTNET_ANSWER_MS };
}

/**
 * Receipt key of a testnet seller: derived from its NEAR secret key, so it is
 * secret, stable across runs, and needs no extra configuration. (The sandbox
 * uses published test receipt keys.)
 */
export function sellerReceiptKey(nearPrivateKey: string): Ed25519Key {
  return ed25519FromSeed(sha256(`${PRODUCT_ID}-demo-receipt-key:v1:${nearPrivateKey}`));
}

export interface JurorWant {
  kind: 'real' | 'synthetic';
  jurors: JurorArg[];
  gatewayKey: string | null;
  /** `accept_gateway` for a first deployment. */
  acceptGateway: boolean;
  /** Fail if an existing contract does not accept gateway ballots (replay of gateway recordings). */
  requireGateway: boolean;
}

export const SYNTHETIC_BANNER = [
  '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
  '!! SYNTHETIC JUROR KEYS ON TESTNET. The contract is set up with the published TEST keys of',
  '!! fixtures/jurors.synthetic.json. Anyone can sign ballots with them, so anyone can decide',
  '!! panel disputes on this deployment. This shows the on-chain verification path only; it',
  '!! says nothing about NEAR AI. For real jurors: NEARAI_API_KEY in .env, `make record`, then',
  '!! deploy without TESTNET_JURORS=synthetic (a new contract account, or set_jurors as owner).',
  '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
];

/** Juror keys for a deployment chosen by name (`scripts/deploy-testnet.ts --jurors`). */
export function jurorSet(kind: 'real' | 'synthetic', acceptGateway = false): JurorWant {
  if (kind === 'synthetic') {
    const sf = syntheticJurorsFile();
    return {
      kind, acceptGateway, requireGateway: false, gatewayKey: sf.gateway.public_key,
      jurors: sf.jurors.map((j) => ({ model_id: j.model, pubkey: j.public_key, attestation_sha256: j.attestation_sha256 })),
    };
  }
  return { kind, acceptGateway, requireGateway: false, ...realKeys() };
}

/**
 * Juror keys the runner needs for its panel plan. Synthetic keys only with an
 * explicit `TESTNET_JURORS=synthetic`.
 */
export function jurorsForPlan(plan: PanelPlan, env: NodeJS.ProcessEnv = process.env): JurorWant {
  const asked = env.TESTNET_JURORS;
  if (asked && asked !== 'real' && asked !== 'synthetic') throw new Error(`TESTNET_JURORS must be real or synthetic, got ${asked}`);
  if (plan.mode === 'replay-synthetic') {
    if (asked !== 'synthetic') {
      throw new Error('fixtures/panel holds SYNTHETIC ballots (no NEAR AI recording yet). Either record real ones (NEARAI_API_KEY in .env, `make record`) '
        + 'or ask for the published TEST juror keys on testnet explicitly with TESTNET_JURORS=synthetic (anyone can then sign rulings). See docs/TESTNET.md.');
    }
  } else if (asked === 'synthetic') {
    throw new Error(`TESTNET_JURORS=synthetic, but the panel mode is ${plan.mode} (real NEAR AI keys); unset TESTNET_JURORS`);
  }
  return {
    kind: plan.mode === 'replay-synthetic' ? 'synthetic' : 'real',
    jurors: plan.jurors, gatewayKey: plan.gatewayKey, acceptGateway: plan.acceptGateway,
    requireGateway: plan.mode === 'replay' && plan.acceptGateway,
  };
}

export interface Deployed {
  receiptKeys: Record<'chainfacts' | 'cheapfacts', Ed25519Key>;
  txs: Array<{ what: string; hash: string }>;
}

/**
 * Deploy and set up the testnet market, idempotently: deploy + init the token
 * and the contract if their accounts hold no code, check or update the juror
 * keys, register both sellers with their terms, top their bonds up to 50.00
 * and the buyers' balances up to 10.00. Safe to run again; a step that is
 * already done is skipped.
 */
export async function ensureDeployed(cfg: TestnetConfig, want: JurorWant, log: (l: string) => void = console.log): Promise<Deployed> {
  if (cfg.problems.length) throw new Error(`testnet configuration incomplete:\n  ${cfg.problems.join('\n  ')}\n(run with --dry-run; docs/TESTNET.md)`);
  if (want.kind === 'synthetic') for (const l of SYNTHETIC_BANNER) log(l);
  const A = cfg.accounts;
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const txs: Deployed['txs'] = [];
  const link = (h: string) => `${cfg.explorerUrl}/txns/${h}`;
  const note = (what: string, hash: string) => { txs.push({ what, hash }); log(`  ${what}: ${link(hash)}`); };

  // pre-flight (read-only): each account exists and holds the configured key
  for (const r of ROLES) {
    const a = A[r.role];
    if (!a.privateKey) continue;
    const st = await viewAccount(cfg.rpcUrl, a.accountId);
    if (!st.exists) throw new Error(`${a.accountId} (${r.idVar}) does not exist on testnet; create it first (docs/TESTNET.md)`);
    try { await provider.viewAccessKey(a.accountId, a.publicKey!, { finality: 'final' }); } catch {
      throw new Error(`${r.keyVar} (public key ${a.publicKey}) is not an access key of ${a.accountId}`);
    }
  }
  const account = (role: Role) => new Account(A[role].accountId, provider, KeyPairSigner.fromSecretKey(A[role].privateKey! as KeyPairString));
  const client = (role?: Role) => new TracedChain({
    rpcUrl: cfg.rpcUrl, contractId: A.contract.accountId, tokenId: A.token.accountId, network: 'near:testnet',
    ...(role ? { accountId: A[role].accountId, privateKey: A[role].privateKey } : {}),
  });
  const deploy = async (role: 'contract' | 'token', wasm: string, init: Record<string, unknown>) => {
    const st = await viewAccount(cfg.rpcUrl, A[role].accountId);
    const want = codeHashOf(wasm);
    if (st.exists && st.codeHash === want) { log(`${role} ${A[role].accountId}: ${wasm} already deployed`); return false; }
    if (st.exists && st.codeHash !== NO_CODE_HASH) {
      throw new Error(`${A[role].accountId} already holds other code (${st.codeHash}); this script does not upgrade a deployed contract. Use a fresh account for ${role === 'contract' ? `${P}CONTRACT` : `${P}TOKEN`}.`);
    }
    log(`${role} ${A[role].accountId}: deploying ${wasm} and calling new`);
    const out = await account(role).signAndSendTransaction({
      receiverId: A[role].accountId,
      actions: [actionCreators.deployContract(new Uint8Array(readFileSync(repoFile(wasm)))), actionCreators.functionCall('new', init, 100n * TGAS, 0n)],
    });
    note(`deploy ${role}`, out.transaction_outcome.id);
    return true;
  };

  await deploy('token', WASM.usdc, {});
  const fresh = await deploy('contract', WASM.makegood, {
    owner: A.owner.accountId, token: A.token.accountId, resolver: A.resolver.accountId,
    cfg: testnetContractConfig(want.acceptGateway), jurors: want.jurors, gateway_key: want.gatewayKey,
  });

  const viewer = client();
  if (!fresh) {
    const c = await viewer.getConfig();
    const mismatch = (['owner', 'token', 'resolver'] as const).filter((k) => c[k] !== A[k].accountId);
    if (mismatch.length) {
      throw new Error(`${A.contract.accountId} was initialised with another ${mismatch.map((k) => `${k} (${String(c[k])})`).join(', ')}; use a fresh contract account`);
    }
    if (c.answer_ms !== TESTNET_ANSWER_MS) log(`note: contract answer_ms is ${c.answer_ms} ms (testnet setting is ${TESTNET_ANSWER_MS})`);
    const raw = await viewer.view<{ accept_gateway?: boolean }>('get_jurors');
    if (want.requireGateway && raw.accept_gateway !== true) {
      throw new Error('the recordings in fixtures/panel include gateway signatures, but this contract was initialised with accept_gateway=false; deploy to a fresh contract account');
    }
    const onChain = await viewer.getJurors();
    const same = onChain.jurors.length === 3 && want.jurors.every((j, i) => onChain.jurors[i]?.model_id === j.model_id && onChain.jurors[i]?.pubkey === j.pubkey.toLowerCase())
      && (onChain.gateway_key ?? null) === (want.gatewayKey?.toLowerCase() ?? null);
    if (same) log(`contract juror keys (epoch ${onChain.epoch}) match the ${want.kind} set`);
    else {
      if (!A.owner.privateKey) {
        throw new Error(`the juror keys on ${A.contract.accountId} are not the ${want.kind} set. Set ${P}OWNER_PRIVATE_KEY (key of ${A.owner.accountId}) so set_jurors can replace them, or use a fresh contract account.`);
      }
      log(`contract juror keys differ from the ${want.kind} set: set_jurors as ${A.owner.accountId}`);
      const tx = await new TracedChain({
        rpcUrl: cfg.rpcUrl, contractId: A.contract.accountId, tokenId: A.token.accountId, network: 'near:testnet',
        accountId: A.owner.accountId, privateKey: A.owner.privateKey,
      }).call('set_jurors', { jurors: want.jurors, gateway_key: want.gatewayKey }, { gas: 30n * TGAS });
      note('set_jurors', tx.txHash);
    }
  }

  const fx = loadDemo();
  const receiptKeys = {} as Deployed['receiptKeys'];
  for (const role of ['chainfacts', 'cheapfacts'] as const) {
    const id = A[role].accountId;
    const c = client(role);
    const key = sellerReceiptKey(A[role].privateKey!);
    receiptKeys[role] = key;
    let s = await viewer.getSeller(id);
    if (!s) {
      note(`register_seller ${role}`, (await c.registerSeller({ receipt_pubkey: toHex(key.publicKey), window_ms: 120_000 }, ONE_NEAR)).txHash);
      s = (await viewer.getSeller(id))!;
    } else if (s.receipt_pubkey !== toHex(key.publicKey)) {
      throw new Error(`${id} is registered with another receipt key; the key in ${ROLES.find((r) => r.role === role)!.keyVar} changed since registration`);
    } else log(`seller ${role} ${id}: registered`);
    if (!(await viewer.getTerms(id, fx.terms.terms_id))) {
      note(`add_terms ${role}`, (await c.addTerms({ terms_id: fx.terms.terms_id, text: fx.terms.text, required_fields: [], as_of_field: null, max_age_s: null, panel: fx.terms.panel })).txHash);
    }
    const missing = BigInt(DEMO_BOND) - BigInt(s.bond);
    if (missing > 0n) {
      note(`mint ${formatUsdc(missing)} to ${role}`, (await c.call('mint', { account_id: id, amount: missing.toString() }, { receiverId: A.token.accountId, gas: 30n * TGAS })).txHash);
      note(`bond ${formatUsdc(missing)} by ${role}`, (await c.depositBond(missing.toString())).txHash);
    }
    log(`seller ${role} ${id}: bond ${formatUsdc((await viewer.getSeller(id))!.bond)}`);
  }
  for (const role of ['scout', 'scout-liar'] as const) {
    const id = A[role].accountId;
    const missing = BigInt(DEMO_BUYER_FUNDS) - BigInt(await viewer.ftBalanceOf(id));
    if (missing > 0n) note(`mint ${formatUsdc(missing)} to ${role}`, (await client(role).call('mint', { account_id: id, amount: missing.toString() }, { receiverId: A.token.accountId, gas: 30n * TGAS })).txHash);
    log(`buyer ${role} ${id}: ${formatUsdc(await viewer.ftBalanceOf(id))} mock USDC`);
  }
  return { receiptKeys, txs };
}

/** The `DemoWorld` of a deployed testnet market. */
export function testnetWorld(cfg: TestnetConfig, d: Deployed): DemoWorld {
  const A = cfg.accounts;
  const roleOf = (label: string): Role => {
    if (!(label in A)) throw new Error(`no testnet account for demo actor ${label}`);
    return label as Role;
  };
  const provider = new JsonRpcProvider({ url: cfg.rpcUrl });
  const view = (onTx?: TracedChain['onTx']) => new TracedChain({ rpcUrl: cfg.rpcUrl, contractId: A.contract.accountId, tokenId: A.token.accountId, network: 'near:testnet' }, onTx);
  const viewer = view();
  return {
    network: 'testnet', contract: A.contract.accountId, token: A.token.accountId,
    id: (label) => A[roleOf(label)].accountId,
    client: (label, onTx) => {
      if (!label) return view(onTx);
      const a = A[roleOf(label)];
      return new TracedChain({ rpcUrl: cfg.rpcUrl, contractId: A.contract.accountId, tokenId: A.token.accountId, network: 'near:testnet', accountId: a.accountId, privateKey: a.privateKey }, onTx);
    },
    balance: async (accountId) => BigInt(await viewer.ftBalanceOf(accountId)),
    nowMs: async () => {
      const b = await provider.viewBlock({ finality: 'optimistic' });
      return Math.floor(Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n));
    },
    receiptKey: (label) => d.receiptKeys[label as 'chainfacts' | 'cheapfacts'] ?? (() => { throw new Error(`no receipt key for ${label}`); })(),
    txUrl: (h) => `${cfg.explorerUrl}/txns/${h}`,
    stop: async () => undefined,
  };
}

/** Next fee tier after a loss (DESIGN 4.5), for checks that hold on a reused testnet seller. */
export function feeAfterLoss(bps: number): number {
  const i = (FEE_BPS as readonly number[]).indexOf(bps);
  return FEE_BPS[Math.min(i + 1, FEE_BPS.length - 1)]!;
}
