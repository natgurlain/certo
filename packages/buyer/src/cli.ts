import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chainFromEnv, CLI_NAME, formatUsdc, fromBase64, toBase64, type CertoChain } from '@certo/core';
import { CertoClient, CertoError, type BuyerChain, type CallResult, type DisputeRecord } from './client.js';
import { simplePolicy } from './policy.js';

const USAGE = `usage: ${CLI_NAME} <command> [args]
  call <url> [--method M] [--body B] [--max-price UNITS] [--auto] [--panel URL]
        pay for one protected call; with --auto apply the policy (5xx → claim_error, wrong token → dispute 100%)
  dispute <call_id> [--offer PCT]        content dispute with a sealed offer (default 100)
  panel <call_id> --panel URL            send evidence and the offer reveal to a panel service
  claim-error <call_id>                  rule refund for a signed 5xx receipt
  claim-rule <call_id>                   rule refund for not-JSON / missing field / stale
  non-delivery <call_id>                 non-delivery claim
  resolve-default <call_id>              settle after the seller's clock ran out
  status <call_id>                       on-chain call record
env: NEAR_RPC_URL, CERTO_CONTRACT, CERTO_TOKEN, BUYER_ACCOUNT, BUYER_PRIVATE_KEY, CERTO_STATE_DIR`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

interface Saved { result?: Omit<CallResult, 'bodyBytes'> & { bodyB64: string }; dispute?: Omit<DisputeRecord, 'tx'> }

export interface CliDeps {
  chain: BuyerChain;
  stateDir: string;
  fetch?: typeof fetch;
  out?: (line: string) => void;
}

/** Runs one CLI command; state (results and sealed offers) persists as JSON files in `stateDir`. */
export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const client = new CertoClient({ chain: deps.chain, fetch: deps.fetch });
  mkdirSync(deps.stateDir, { recursive: true });
  const file = (id: string) => join(deps.stateDir, `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  const load = (id: string): Saved => { try { return JSON.parse(readFileSync(file(id), 'utf8')) as Saved; } catch { return {}; } };
  const save = (id: string, s: Saved) => writeFileSync(file(id), JSON.stringify(s, null, 2));
  const restore = (id: string) => {
    const s = load(id);
    if (s.result) client.calls.set(id, { ...s.result, bodyBytes: fromBase64(s.result.bodyB64) });
    if (s.dispute) client.disputes.set(id, { ...s.dispute, tx: { txHash: '', events: [], logs: [], failures: [] } });
  };
  const persist = (id: string) => {
    const r = client.calls.get(id);
    const d = client.disputes.get(id);
    const { bodyBytes, ...rest } = r ?? ({} as CallResult);
    save(id, {
      result: r ? { ...rest, bodyB64: toBase64(bodyBytes) } : undefined,
      dispute: d ? { callId: d.callId, offerBps: d.offerBps, salt: d.salt, commit: d.commit, stake: d.stake } : undefined,
    });
  };

  const [cmd, target, ...rest] = argv;
  try {
    switch (cmd) {
      case 'call': {
        if (!target) throw new Error('call needs a URL');
        const r = await client.call(target, { method: flag(rest, 'method'), body: flag(rest, 'body'), maxPrice: flag(rest, 'max-price') });
        persist(r.callId);
        out(`paid ${formatUsdc(r.price)} call ${r.callId} tx ${r.payTx}; status ${r.status}; receipt verified`);
        out(r.body);
        if (rest.includes('--auto')) {
          const d = simplePolicy(r);
          out(`policy: ${d.action} (${d.reason})`);
          if (d.action === 'claim_error') out(`claim_error tx ${(await client.claimError(r)).txHash}`);
          if (d.action === 'dispute') {
            const rec = await client.dispute(r, { offerBps: d.offerBps });
            persist(r.callId);
            out(`dispute opened tx ${rec.tx.txHash}, stake ${formatUsdc(rec.stake)}, sealed offer ${rec.offerBps / 100}%`);
            const panel = flag(rest, 'panel');
            if (panel) {
              const c = await client.waitForStatus(r.callId, ['Answered']);
              out(`seller answered ${c?.dispute?.seller_offer_bps ?? '?'} bps`);
              out(JSON.stringify(await client.submitToPanel(panel, r.callId)));
            }
          }
        }
        return 0;
      }
      case 'dispute': {
        restore(target!);
        const pct = Number(flag(rest, 'offer') ?? '100');
        const rec = await client.dispute(target!, { offerBps: pct * 100 });
        persist(target!);
        out(`dispute opened tx ${rec.tx.txHash}, stake ${formatUsdc(rec.stake)}, sealed offer ${pct}%`);
        return 0;
      }
      case 'panel': {
        restore(target!);
        const url = flag(rest, 'panel');
        if (!url) throw new Error('--panel URL is required');
        out(JSON.stringify(await client.submitToPanel(url, target!)));
        return 0;
      }
      case 'claim-error': restore(target!); out(`tx ${(await client.claimError(target!)).txHash}`); return 0;
      case 'claim-rule': restore(target!); out(`tx ${(await client.claimRule(target!)).txHash}`); return 0;
      case 'non-delivery': out(`tx ${(await client.claimNonDelivery(target!)).txHash}`); return 0;
      case 'resolve-default': restore(target!); out(`tx ${(await client.resolveDefault(target!)).txHash}`); return 0;
      case 'status': out(JSON.stringify(await deps.chain.getCall(target!), null, 2)); return 0;
      default:
        out(USAGE);
        return cmd ? 2 : 0;
    }
  } catch (e) {
    const code = e instanceof CertoError ? ` [${e.code}${e.callId ? ` call ${e.callId}` : ''}]` : '';
    out(`error${code}: ${(e as Error).message}`);
    return 1;
  }
}

/** Entry point used by `bin/certo.js`: chain from env. */
export async function main(argv = process.argv.slice(2), env = process.env): Promise<number> {
  let chain: CertoChain | undefined;
  const needsChain = argv[0] && argv[0] !== 'help';
  if (needsChain) {
    const accountId = env.BUYER_ACCOUNT;
    const privateKey = env.BUYER_PRIVATE_KEY ?? env.BUYER_SCOUT_PRIVATE_KEY;
    chain = chainFromEnv(env, accountId && privateKey ? { accountId, privateKey } : undefined);
  }
  return runCli(argv, {
    chain: chain as CertoChain,
    stateDir: env.CERTO_STATE_DIR ?? join(homedir(), `.${CLI_NAME}`, 'calls'),
  });
}
