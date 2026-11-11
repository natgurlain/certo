import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chainFromEnv, CLI_NAME, formatUsdc, parseAmountInput } from '@certo/core';
import { nearBotKeyAdder, sellerInit, type BotKeyAdder, type InitChain } from '@certo/seller';
import { CertoClient, CertoError, describeOutcome, type BuyerChain } from './client.js';
import { buyerChainFromEnv, ConfigError, resolveArgs } from './config.js';
import { describeProgress, disputeAndSettle, helpFor, type DisputeKind } from './flow.js';
import { simplePolicy } from './policy.js';
import { certoHome, defaultStateDir, FileCallStore } from './store.js';

const USAGE = `usage: ${CLI_NAME} [--playground] <command> [args]
  quote <url> [--method M] [--body B]   look before paying: price, bond, free capacity, fee, losses, window, terms
  call <url> [--method M] [--body B] [--max-price P] [--auto] [--panel URL] [--wait S]
        pay for one protected call (refused above the cap: CERTO_MAX_PRICE, default 1.00 USDC);
        --auto applies the demo policy (5xx → error claim, wrong token → content dispute) and follows it like dispute
  dispute <call_id> [--kind content|error|rule|non_delivery] [--offer PCT] [--panel URL] [--wait S]
        open a dispute (or continue an open one) and wait up to S seconds (default 90) for the final outcome
  status <call_id>                       open / released / in dispute / refunded / unknown
  seller init --bond B --terms FILE [--terms-id ID] [--price P] [--window S] [--panel] [--key-file F] [--no-bot-key]
        register as a seller (1 NEAR deposit), publish terms, deposit the bond, add the answer bot's function-call key
        (methods answer and cure only), print the protect() snippet; refunds by rule only unless --panel
        (experimental: three AI jurors judge content disputes)
  low level: panel <call_id> --panel URL | claim-error <call_id> | claim-rule <call_id> | non-delivery <call_id> | resolve-default <call_id>
amounts: "0.40" or "1 USDC" is USDC; a bare integer is base units (6 decimals); seller init --bond 50 means 50 USDC
env: NEAR_RPC_URL, NEAR_NETWORK, CERTO_CONTRACT, CERTO_TOKEN, BUYER_ACCOUNT, BUYER_PRIVATE_KEY, CERTO_MAX_PRICE, PANEL_URL,
     CERTO_STATE_DIR (default ~/.certo/calls/<network>/<contract>); seller init: SELLER_ACCOUNT, SELLER_PRIVATE_KEY
--playground loads ~/.certo/playground.env (or $CERTO_HOME/playground.env) written by \`make playground\``;

class UsageError extends Error {}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new UsageError(`--${name} needs a value`);
  return v;
}

function intFlag(args: string[], name: string, def: number, min: number, max: number): number {
  const v = flag(args, name);
  if (v === undefined) return def;
  if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new UsageError(`--${name} must be a whole number from ${min} to ${max}, got "${v}"`);
  return Number(v);
}

function amountFlag(args: string[], name: string): string | undefined {
  const v = flag(args, name);
  if (v === undefined) return undefined;
  try {
    parseAmountInput(v);
  } catch (e) {
    throw new UsageError(`--${name}: ${(e as Error).message}`);
  }
  return v;
}

export interface CliDeps {
  chain: BuyerChain;
  stateDir: string;
  fetch?: typeof fetch;
  out?: (line: string) => void;
  /** Panel URL used when `--panel` is not given (`PANEL_URL`). */
  panelUrl?: string;
  /** Price cap (`CERTO_MAX_PRICE`). */
  maxPrice?: string;
  /** Signing seller chain for `seller init`. */
  sellerChain?: () => InitChain;
  /** Adds the answer bot's function-call key for `seller init` (signed with the seller's full-access key). */
  botKeyAdder?: (contractId: string) => BotKeyAdder;
  /** Where `seller init` keeps the receipt key (`CERTO_HOME`). */
  home?: string;
}

const COMMANDS = ['quote', 'call', 'dispute', 'status', 'panel', 'claim-error', 'claim-rule', 'non-delivery', 'resolve-default'];
/** `help`, or `--help` / `-h` after any command (`certo seller init --help`). */
const wantsHelp = (argv: string[]) => argv[0] === 'help' || argv.some((a) => a === '--help' || a === '-h');

/** `dispute`, and `call --auto`: open (or continue) and follow to the final outcome, printing what happened. */
async function followDispute(client: CertoClient, callId: string, o: Parameters<typeof disputeAndSettle>[2], out: (l: string) => void): Promise<void> {
  const r = await disputeAndSettle(client, callId, o);
  if (r.opened) {
    out(`${r.opened.kind} dispute opened tx ${r.opened.tx}${r.opened.stake ? `, stake ${formatUsdc(r.opened.stake)}` : ''}`
      + `${r.opened.sealedOfferPct !== undefined ? `, sealed offer ${r.opened.sealedOfferPct}%` : ''}`);
  }
  out(describeProgress(r.progress));
}

/** Runs one CLI command; call records and sealed offers persist as JSON files in `stateDir`. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const [cmd, target, ...rest] = argv;
  try {
    if (!cmd || wantsHelp(argv)) { out(USAGE); return 0; }
    if (cmd === 'seller') return await seller(target, rest, deps, out);
    if (!COMMANDS.includes(cmd)) { out(USAGE); return 2; }
    if (!target || target.startsWith('--')) throw new UsageError(`${cmd} needs a ${cmd === 'quote' || cmd === 'call' ? 'URL' : 'call id'}`);
    const client = new CertoClient({ chain: deps.chain, fetch: deps.fetch, maxPrice: deps.maxPrice, store: new FileCallStore(deps.stateDir) });
    switch (cmd) {
      case 'quote': {
        const q = await client.quote(target, { method: flag(rest, 'method'), body: flag(rest, 'body') });
        const s = q.seller_record;
        out(JSON.stringify({
          url: q.url, seller: q.seller, price_usdc: formatUsdc(q.price), max_price_usdc: formatUsdc(q.maxPrice), payable: q.problems.length === 0,
          problems: q.problems, fee_bps: q.feeBps, refund_window_s: q.windowMs / 1000, dispute_stake_usdc: formatUsdc(q.disputeStake),
          bond_usdc: s && formatUsdc(s.bond), free_capacity_usdc: s && formatUsdc(s.free_capacity),
          record: s && { released_calls: s.lifetime_calls, losses: s.lifetime_losses, splits: (s as { splits?: number }).splits ?? 0 }, terms_id: q.termsId, terms: q.terms,
          panel: q.terms ? (q.terms.panel ? 'experimental: three AI jurors judge content disputes' : 'off: refunds by rule only') : undefined,
        }, null, 2));
        return 0;
      }
      case 'call': {
        const r = await client.call(target, { method: flag(rest, 'method'), body: flag(rest, 'body'), maxPrice: amountFlag(rest, 'max-price') });
        out(`paid ${formatUsdc(r.price)} call ${r.callId} tx ${r.payTx}; status ${r.status}; receipt verified`);
        out(r.body);
        if (rest.includes('--auto')) {
          const d = simplePolicy(r);
          out(`policy: ${d.action} (${d.reason})`);
          const follow = { panelUrl: flag(rest, 'panel') ?? deps.panelUrl, maxWaitMs: intFlag(rest, 'wait', 90, 0, 3600) * 1000 };
          if (d.action === 'claim_error') await followDispute(client, r.callId, { ...follow, kind: 'error' }, out);
          if (d.action === 'dispute') await followDispute(client, r.callId, { ...follow, kind: 'content', offerPct: d.offerBps / 100 }, out);
        }
        return 0;
      }
      case 'dispute': {
        const kind = (flag(rest, 'kind') ?? 'content') as DisputeKind;
        if (!['content', 'error', 'rule', 'non_delivery'].includes(kind)) throw new UsageError(`--kind must be content, error, rule or non_delivery, got "${kind}"`);
        const offerPct = intFlag(rest, 'offer', 100, 0, 100);
        const wait = intFlag(rest, 'wait', 90, 0, 3600);
        await followDispute(client, target, { kind, offerPct, panelUrl: flag(rest, 'panel') ?? deps.panelUrl, maxWaitMs: wait * 1000 }, out);
        return 0;
      }
      case 'status': {
        const s = await client.status(target);
        out(s.detail.startsWith(`${s.state}:`) ? s.detail : `${s.state}: ${s.detail}`);
        if (s.call) out(JSON.stringify(s.call, null, 2));
        return 0;
      }
      case 'panel': {
        const url = flag(rest, 'panel');
        if (!url) throw new UsageError('--panel URL is required');
        out(JSON.stringify(await client.submitToPanel(url, target)));
        return 0;
      }
      case 'claim-error': out(`tx ${(await client.claimError(target)).txHash}`); return 0;
      case 'claim-rule': out(`tx ${(await client.claimRule(target)).txHash}`); return 0;
      case 'non-delivery': out(`tx ${(await client.claimNonDelivery(target)).txHash}`); return 0;
      default: {
        const tx = await client.resolveDefault(target);
        const o = (await client.status(target)).outcome;
        out(`tx ${tx.txHash}${o ? `; ${describeOutcome(o)}` : ''}`);
        return 0;
      }
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof ConfigError) { out(`error: ${e.message}`); return 2; }
    const code = e instanceof CertoError ? e.code : undefined;
    const cc = (e as { contractCode?: string; code?: string }).contractCode ?? (e as { code?: string }).code;
    const tag = code ? ` [${code}${(e as CertoError).callId ? ` call ${(e as CertoError).callId}` : ''}]` : '';
    const help = helpFor(code, cc);
    out(`error${tag}: ${(e as Error).message}${help ? ` (${help})` : ''}`);
    return 1;
  }
}

async function seller(sub: string | undefined, rest: string[], deps: CliDeps, out: (l: string) => void): Promise<number> {
  if (sub !== 'init') { out(USAGE); return 2; }
  const bond = flag(rest, 'bond');
  const termsFile = flag(rest, 'terms');
  if (!bond || !termsFile) throw new UsageError('seller init needs --bond AMOUNT (USDC, e.g. 50) and --terms FILE');
  let termsText: string;
  try {
    termsText = readFileSync(termsFile, 'utf8');
  } catch {
    throw new UsageError(`cannot read terms file ${termsFile}`);
  }
  let bondUnits: string;
  try {
    bondUnits = parseAmountInput(/^\d+$/.test(bond) ? `${bond} USDC` : bond); // "--bond 50" means 50 USDC
  } catch (e) {
    throw new UsageError(`--bond: ${(e as Error).message}`);
  }
  const price = amountFlag(rest, 'price');
  const windowMs = intFlag(rest, 'window', 120, 60, 86_400) * 1000;
  if (!deps.sellerChain) throw new ConfigError(`${CLI_NAME}: seller init needs a seller account`);
  const chain = deps.sellerChain();
  await sellerInit(chain, {
    bond: bondUnits, termsText, termsId: flag(rest, 'terms-id'), price: price ? parseAmountInput(price) : undefined, windowMs,
    panel: rest.includes('--panel'),
    keyFile: flag(rest, 'key-file') ?? join(deps.home ?? certoHome(), `seller-${chain.accountId}.receipt-key`), out,
    botKey: deps.botKeyAdder && !rest.includes('--no-bot-key')
      ? { file: join(deps.home ?? certoHome(), `seller-${chain.accountId}.bot-key`), add: deps.botKeyAdder(chain.contractId) }
      : undefined,
  });
  return 0;
}

/** Entry point used by `bin/certo.js`. Configuration errors print one line, no stack trace. */
export async function main(argv = process.argv.slice(2), env0 = process.env): Promise<number> {
  try {
    const { argv: args, env } = resolveArgs(argv, env0);
    const cmd = args[0];
    const needsBuyer = !!cmd && COMMANDS.includes(cmd) && !wantsHelp(args);
    return await runCli(args, {
      chain: (needsBuyer ? buyerChainFromEnv(env) : undefined) as BuyerChain,
      stateDir: defaultStateDir(env),
      panelUrl: env.PANEL_URL,
      maxPrice: env.CERTO_MAX_PRICE,
      home: certoHome(env),
      sellerChain: () => {
        const missing = ['CERTO_CONTRACT', 'CERTO_TOKEN', 'SELLER_ACCOUNT', 'SELLER_PRIVATE_KEY'].filter((k) => !env[k]);
        if (missing.length) throw new ConfigError(`${CLI_NAME} seller init: set ${missing.join(', ')} (and NEAR_RPC_URL, NEAR_NETWORK)`);
        return chainFromEnv(env, { accountId: env.SELLER_ACCOUNT!, privateKey: env.SELLER_PRIVATE_KEY! });
      },
      botKeyAdder: (contractId) => nearBotKeyAdder({
        rpcUrl: env.NEAR_RPC_URL ?? 'https://rpc.testnet.fastnear.com', accountId: env.SELLER_ACCOUNT!, privateKey: env.SELLER_PRIVATE_KEY!, contractId,
      }),
    });
  } catch (e) {
    if (e instanceof ConfigError) { console.error(e.message); return 2; }
    throw e;
  }
}
