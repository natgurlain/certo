/**
 * The four scenes of DESIGN 5.5 on a local sandbox, with the transcript of
 * README step 2 (4.6) and the event feed of `apps/demo/EVENTS.md`.
 * Every amount printed is read from the chain and checked against the
 * expected value; a mismatch fails the scene.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CertoClient, CertoError, simplePolicy, type CallResult } from '@certo/buyer';
import {
  HDR_PAYMENT_SIGNATURE, JURORS, PRODUCT_ID, PRODUCT_NAME, formatUsdc, receiptText, requestHash, sha256Hex, signBase64, toContractBallot,
  type ContractError, type ContractEvent, type PanelRecording, type TxResult,
} from '@certo/core';
import { LiveJurors, PanelService, ReplayJurors, createPanelApp, type CaseOutcome, type JurorSource } from '@certo/panel';
import { Feed } from './feed.js';
import { ForgingJurors } from './forge.js';
import { choosePanel, loadDemo, type PanelPlan } from './fixtures.js';
import { LocalChain, repoFile, SANDBOX_VERSION, WASM } from './sandbox.js';
import { startDemoSeller, type DemoSeller } from './seller.js';
import { feeAfterLoss, jurorsForPlan, ensureDeployed, testnetWorld, type TestnetConfig } from './testnet.js';
import { DEMO_BOND, DEMO_BUYER_FUNDS, addSeller, deployMarket, type DemoWorld, type TracedChain } from './world.js';

export const ACCOUNTS = {
  contract: PRODUCT_ID, token: 'usdc', owner: 'owner', resolver: 'resolver',
  sellers: ['chainfacts', 'cheapfacts'] as const, buyers: ['scout', 'scout-liar'] as const,
  /** Funded buyer left for `make playground` (sandbox only); the scenes never use it. */
  agent: 'agent',
};
/**
 * Scene 5 (sandbox only): the same contract built without the juror-signature check, with
 * its own seller, buyer and resolver (one key per client: shared keys race on nonces).
 */
const UNCHECKED = { contract: 'certo-unchecked', seller: 'unchecked-seller', buyer: 'unchecked-buyer', resolver: 'unchecked-resolver' } as const;
/** Juror whose answer scene 5 edits (Qwen). */
const FORGED_JUROR = 0;
const BOND = DEMO_BOND;
const BUYER_FUNDS = DEMO_BUYER_FUNDS;
const VOTE_GAP_MS = 400;

export interface DemoOptions {
  /** Port of the page and SSE feed (default 4020); null = do not serve. */
  port?: number | null;
  env?: NodeJS.ProcessEnv;
  print?: (line: string) => void;
  /** `sandbox` (default) or `testnet` (needs `testnet`, from `readTestnetConfig`). */
  network?: 'sandbox' | 'testnet';
  testnet?: TestnetConfig;
  /** Fixed HTTP ports of the demo sellers (default: any free port). */
  sellerPorts?: Partial<Record<(typeof ACCOUNTS.sellers)[number], number>>;
}

export interface DemoResult {
  ok: boolean;
  scenesOk: number;
  jurorsVerified: number;
  plan: PanelPlan;
  lines: string[];
  feed: Feed;
  port: number | null;
  elapsedMs: number;
  /** The world the scenes ran on, still running until `shutdown`. */
  world: DemoWorld;
  panelUrl: string;
  /** URL of the demo request at each seller. */
  exampleUrls: Record<string, string>;
  /** Restart the sellers scene 4 stopped (same port, same receipt key), e.g. for `make playground`. */
  reviveSellers(): Promise<void>;
  /** `make playground`: from now on the buyer `agent` (the judge's MCP client) gets a card on the page once it pays. Returns a stop function. */
  watchAgent(): () => void;
  shutdown(opts?: { keepFeed?: boolean }): Promise<void>;
}

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
/** Short juror name for the page: the last word of the model family ("Alibaba Qwen" → "Qwen"). */
export const jurorName = (family: string) => family.split(' ').pop() ?? family;
/** Amount for captions: "0.400000" → "0.40", "0.396000" → "0.396". */
const cap = (x: bigint | string) => { const [i, f = ''] = formatUsdc(x).split('.'); return `${i}.${f.replace(/0+$/, '').padEnd(2, '0')}`; };
const short = (h: string) => `${h.slice(0, 8)}…`;

/** Local sandbox market: genesis accounts, both contracts, two bonded sellers, two funded buyers. */
async function sandboxWorld(plan: PanelPlan, terms: Array<{ terms_id: string; text: string; panel: boolean }>): Promise<DemoWorld> {
  const chain = await LocalChain.start([ACCOUNTS.contract, ACCOUNTS.token, ACCOUNTS.owner, ACCOUNTS.resolver, ...ACCOUNTS.sellers, ...ACCOUNTS.buyers, ACCOUNTS.agent, ...Object.values(UNCHECKED)]);
  try {
    const market = await deployMarket({
      chain, contract: ACCOUNTS.contract, token: ACCOUNTS.token, owner: ACCOUNTS.owner, resolver: ACCOUNTS.resolver,
      wasm: 'res/certo.wasm', deployToken: true, jurors: plan.jurors, gatewayKey: plan.gatewayKey, acceptGateway: plan.acceptGateway,
    });
    const regs = await Promise.all([
      addSeller(market, { id: 'chainfacts', bond: BOND, terms }),
      addSeller(market, { id: 'cheapfacts', bond: BOND, terms }),
      ...[...ACCOUNTS.buyers, ACCOUNTS.agent].map((b) => market.mint(b, BUYER_FUNDS)),
    ]);
    const keys = new Map(regs.filter((r): r is Awaited<ReturnType<typeof addSeller>> => !!r).map((r) => [r.id, r.receiptKey]));
    return {
      network: 'sandbox', contract: market.contract, token: market.token,
      id: (label) => label,
      client: (label, onTx) => market.client(label, onTx),
      balance: (id) => market.balance(id),
      nowMs: () => chain.nowMs(),
      receiptKey: (label) => keys.get(label)!,
      txUrl: () => null,
      stop: () => chain.stop(),
      local: market,
    };
  } catch (e) {
    await chain.stop();
    throw e;
  }
}

class SceneFailure extends Error {}
function expect(cond: boolean, what: string): void {
  if (!cond) throw new SceneFailure(what);
}

/** NEP-141 `ft_transfer` events in a transaction's logs. */
function tokenTransfers(tx: TxResult): Array<{ old_owner_id: string; new_owner_id: string; amount: string }> {
  const out: Array<{ old_owner_id: string; new_owner_id: string; amount: string }> = [];
  for (const l of tx.logs) {
    if (!l.startsWith('EVENT_JSON:')) continue;
    try {
      const e = JSON.parse(l.slice('EVENT_JSON:'.length)) as { standard: string; event: string; data: typeof out };
      if (e.standard === 'nep141' && e.event === 'ft_transfer') out.push(...e.data);
    } catch { /* not an event */ }
  }
  return out;
}

export async function runDemo(o: DemoOptions = {}): Promise<DemoResult> {
  const t0 = Date.now();
  const env = o.env ?? process.env;
  const print = o.print ?? ((l: string) => console.log(l));
  const lines: string[] = [];
  let n = 0;
  const say = (text: string) => { const l = `${String(++n).padStart(2, '0')}  ${text}`; lines.push(l); print(l); };
  const feed = new Feed();

  const network = o.network ?? 'sandbox';
  const testnet = network === 'testnet';
  if (testnet && !o.testnet) throw new Error('network testnet needs a testnet configuration');
  const plan = choosePanel(env);
  const synthetic = plan.mode === 'replay-synthetic';
  const jurorWant = testnet ? jurorsForPlan(plan, env) : null;
  const port = o.port === null ? null : await feed.listen(o.port ?? 4020);
  print(`${PRODUCT_NAME} demo: ${testnet ? `NEAR testnet (RPC ${o.testnet!.rpcUrl})` : `local NEAR sandbox (nearcore ${SANDBOX_VERSION})`}, panel mode ${plan.mode}: ${plan.why}`);
  if (synthetic) print('NOTE: SYNTHETIC panel: juror answers are signed with local TEST keys (fixtures/jurors.synthetic.json), not by NEAR AI. Run `make record` with NEARAI_API_KEY for real ballots.');
  if (port !== null) print(`page and event feed: http://localhost:${port}`);
  else if (o.port !== null) print(`WARNING: port ${o.port ?? 4020} is in use; the page is not served this run (set DEMO_PORT)`);
  feed.emit({ kind: 'mode', panel: plan.mode, network, ...(plan.recordedAt && plan.mode !== 'live' ? { recordedAt: plan.recordedAt } : {}) });
  /** Buyers with a card on the page: the scenes' two, then `agent` once it acts in the playground. */
  const shownBuyers: string[] = [...ACCOUNTS.buyers];
  const emitActors = () => feed.emit({
    kind: 'actors',
    buyers: shownBuyers.map((id) => ({ id, label: id === ACCOUNTS.agent ? 'agent (you)' : id })),
    sellers: ACCOUNTS.sellers.map((id) => ({ id, label: id })),
    // pubkey: the key the contract checks this juror's ballots against (committed in fixtures/), for the page's own check
    jurors: JURORS.map((j, i) => ({ index: j.index, model: j.model, name: jurorName(j.family), family: j.family, pubkey: plan.jurors[i]?.pubkey })),
  });
  emitActors();

  const fx = loadDemo();
  const terms = [{ terms_id: fx.terms.terms_id, text: fx.terms.text, panel: fx.terms.panel }];
  let world: DemoWorld;
  try {
    world = testnet
      ? testnetWorld(o.testnet!, await ensureDeployed(o.testnet!, jurorWant!, print))
      : await sandboxWorld(plan, terms);
  } catch (e) {
    await feed.close();
    throw e;
  }
  const servers: Array<{ close(): Promise<void> }> = [];
  const shutdown = async (opts: { keepFeed?: boolean } = {}) => {
    for (const s of servers.reverse()) await s.close().catch(() => undefined);
    await world.stop();
    if (!opts.keepFeed) await feed.close();
  };
  const labels = new Map([ACCOUNTS.owner, ACCOUNTS.resolver, ...ACCOUNTS.sellers, ...ACCOUNTS.buyers].map((l) => [world.id(l), l] as const));
  /** Demo label of an account id (the feed and the transcript use labels). */
  const labelOf = (accountId: string) => labels.get(accountId) ?? accountId;
  /** Transaction reference for the transcript: an explorer link on testnet, a short hash on the sandbox. */
  const txRef = (h: string) => world.txUrl(h) ?? short(h);
  const txLog: Array<{ signer: string; method: string; hash: string; error?: string }> = [];

  // ---- observers: chain events and state snapshots into the feed
  const viewer: TracedChain = world.client();
  let snapshotQueue = Promise.resolve();
  const lastTx = new Map<string, TxResult>();
  const snapshot = () => {
    snapshotQueue = snapshotQueue.then(async () => {
      const [buyers, sellers] = await Promise.all([
        Promise.all(shownBuyers.map(async (id) => [id, { balance: formatUsdc(await world.balance(world.id(id))) }] as const)),
        Promise.all(ACCOUNTS.sellers.map(async (id) => {
          const s = await viewer.getSeller(world.id(id));
          return [id, {
            balance: formatUsdc(await world.balance(world.id(id))),
            bond: formatUsdc(s?.bond ?? '0'),
            exposed: formatUsdc(s ? BigInt(s.bond) - BigInt(s.free_capacity) : 0n),
            feeBps: s?.fee_bps ?? 0,
            // paid calls this run (the contract's lifetime_calls counts released calls only)
            record: { calls: paidCalls.get(id) ?? 0, losses: s?.lifetime_losses ?? 0 },
          }] as const;
        })),
      ]);
      feed.emit({ kind: 'state', buyers: Object.fromEntries(buyers), sellers: Object.fromEntries(sellers) });
    }).catch(() => undefined);
    return snapshotQueue;
  };
  const paidCalls = new Map<string, number>();
  /** While set, the resolver's transactions reach the feed only when flushed (after the staged votes). */
  let held: Array<() => void> | null = null;
  const onTx = (signer: string) => (method: string, tx: TxResult, err?: ContractError) => {
    lastTx.set(`${signer}:${method}`, tx);
    txLog.push({ signer, method, hash: tx.txHash, ...(err ? { error: err.code ?? err.message } : {}) });
    const publish = () => {
      agentVerdict(tx);
      for (const e of tx.events) {
        if (e.event === 'call_paid') { const s = labelOf(String(e.data.seller)); paidCalls.set(s, (paidCalls.get(s) ?? 0) + 1); }
        feed.emit({ kind: 'chain', event: e.event, data: e.data, txHash: tx.txHash });
      }
      if (err) feed.emit({ kind: 'chain', event: 'tx_failed', data: { method, signer, error: err.code ?? err.message }, txHash: tx.txHash });
      void snapshot();
    };
    if (held && signer === ACCOUNTS.resolver) held.push(publish);
    else publish();
  };

  const clientOf = (id: string) => world.client(id, onTx(id));

  // ---- make playground: the judge's buyer `agent` signs in its own process (certo-mcp), so its steps are seen
  // where they land here: the seller that served it, the answer bot, and the resolver's verdict; its balance is polled
  let watching = false;
  /** The agent's calls this run: seller label and when its dispute was seen. */
  const agentCalls = new Map<string, { seller: string; disputedAt?: number; gone?: boolean }>();
  const showAgent = () => {
    if (shownBuyers.includes(ACCOUNTS.agent)) return;
    shownBuyers.push(ACCOUNTS.agent);
    emitActors();
  };
  const agentPaid = async (seller: string, served: { callId: string; status: number; body: string }) => {
    if (!watching || agentCalls.has(served.callId)) return;
    const call = await viewer.getCall(served.callId).catch(() => null);
    if (call?.buyer !== world.id(ACCOUNTS.agent)) return;
    agentCalls.set(served.callId, { seller });
    showAgent();
    await emitCall(0, ACCOUNTS.agent, seller, { status: served.status, body: served.body } as CallResult, served.callId, mismatchOf(served.body));
    feed.emit({ kind: 'log', actor: ACCOUNTS.agent, text: `paid ${cap(call.price)} to ${seller}: HTTP ${served.status}` });
    await snapshot();
  };
  const agentAnswered = async (callId: string) => {
    const a = agentCalls.get(callId);
    if (!watching || !a) return;
    const c = await viewer.getCall(callId).catch(() => null);
    if (!c?.dispute) return;
    a.disputedAt = Date.now();
    feed.emit({
      kind: 'dispute', scene: 0, callId, buyer: ACCOUNTS.agent, seller: a.seller, disputeKind: 'content', stake: formatUsdc(c.dispute.stake),
      sellerOfferPct: (c.dispute.seller_offer_bps ?? 0) / 100,
    });
    feed.emit({ kind: 'log', actor: ACCOUNTS.agent, text: `disputed: stake ${cap(c.dispute.stake)}, ${a.seller} offers ${(c.dispute.seller_offer_bps ?? 0) / 100}%` });
  };
  /** A verdict the resolver submitted on one of the agent's calls: the votes, then the result (before the chain events, as EVENTS.md asks). */
  function agentVerdict(tx: TxResult): void {
    const e = tx.events.find((x) => x.event === 'dispute_resolved');
    const callId = String(e?.data.call_id ?? '');
    const a = agentCalls.get(callId);
    if (!watching || !e || !a) return;
    const votes = (tx.events.find((x) => x.event === 'ballots_verified')?.data.votes ?? []) as string[];
    for (const [i, v] of votes.entries()) feed.emit({ kind: 'vote', scene: 0, callId, juror: i, model: JURORS[i]!.model, vote: v, sigVerified: true });
    const refund = String(e.data.refund ?? '0');
    const winner = (e.data.winner as string | undefined) ?? (BigInt(refund) > 0n ? 'buyer' : 'seller');
    const b = votes.filter((v) => v === 'buyer').length;
    feed.emit({
      kind: 'resolved', scene: 0, callId, tier: e.data.tier, winner, refund: formatUsdc(refund),
      ...(votes.length ? { votes: `${b}-${votes.filter((v) => v === 'seller').length}` } : {}), elapsedMs: Date.now() - (a.disputedAt ?? Date.now()),
    });
    agentCalls.delete(callId);
  }
  const watchAgent = () => {
    watching = true;
    let last = '';
    const poll = setInterval(() => {
      void world.balance(world.id(ACCOUNTS.agent)).then(async (bal) => {
        const now = formatUsdc(bal);
        if (last && now !== last && shownBuyers.includes(ACCOUNTS.agent)) await snapshot(); // e.g. a timeout-rule refund the agent sent itself
        last = now;
        for (const [callId, a] of agentCalls) {
          if (await viewer.getCall(callId).catch(() => undefined) !== null) continue;
          // gone twice in a row: by then a verdict of the resolver would have been seen (its transaction lands before its report)
          if (!a.gone) { a.gone = true; continue; }
          agentCalls.delete(callId);
          feed.emit({ kind: 'log', actor: ACCOUNTS.agent, text: a.disputedAt ? `dispute on ${a.seller} settled without the panel (timeout rule)` : `window closed: ${a.seller} kept the payment` });
        }
      }).catch(() => undefined);
    }, 2000);
    return () => { watching = false; clearInterval(poll); };
  };
  if (testnet) {
    const [bonds, funds] = await Promise.all([
      Promise.all(ACCOUNTS.sellers.map(async (s) => formatUsdc((await viewer.getSeller(world.id(s)))?.bond ?? '0'))),
      Promise.all(ACCOUNTS.buyers.map(async (b) => formatUsdc(await world.balance(world.id(b))))),
    ]);
    say(`testnet ready: contract ${world.contract}, token ${world.token} (mock USDC, 6 decimals); sellers chainfacts (${world.id('chainfacts')}) and cheapfacts (${world.id('cheapfacts')}) bonded ${bonds.join(' and ')}; buyers scout (${world.id('scout')}) and scout-liar (${world.id('scout-liar')}) hold ${funds.join(' and ')}`);
  } else {
    say(`sandbox up: contract ${ACCOUNTS.contract}, token ${ACCOUNTS.token} (mock USDC, 6 decimals); sellers chainfacts and cheapfacts bonded ${formatUsdc(BOND)} each; buyers scout and scout-liar hold ${formatUsdc(BUYER_FUNDS)}`);
  }

  // ---- sellers, panel service
  const botLog = (seller: string) => (a: { callId: string; action: string; txHash?: string; error?: string }) => {
    if (a.error) feed.emit({ kind: 'log', actor: seller, text: `${a.action} failed: ${a.error}` });
    else feed.emit({ kind: 'log', actor: seller, text: `${a.action === 'answer' ? 'answered the dispute: offer 0%' : 'cured the claim'} (${short(a.txHash ?? '')})` });
    if (!a.error && a.action === 'answer') void agentAnswered(a.callId);
  };
  const sellers: Record<string, DemoSeller> = {};
  const startSeller = async (label: (typeof ACCOUNTS.sellers)[number], port?: number) => {
    const s = await startDemoSeller({
      id: world.id(label), chain: clientOf(label), receiptKey: world.receiptKey(label), termsId: fx.terms.terms_id, price: fx.price,
      responses: { [fx.request]: fx.responses[label] }, offerBps: 0, onBot: botLog(label), botPollMs: testnet ? 4000 : 400, port,
      onPaid: (served) => void agentPaid(label, served),
    });
    sellers[label] = s;
    servers.push({ close: () => s.kill() });
  };
  for (const label of ACCOUNTS.sellers) await startSeller(label, o.sellerPorts?.[label]);
  const reviveSellers = async () => {
    for (const label of ACCOUNTS.sellers) {
      if (sellers[label]!.alive) continue;
      await startSeller(label, Number(new URL(sellers[label]!.url).port));
      feed.emit({ kind: 'log', actor: label, text: 'process restarted' });
    }
  };
  const source: JurorSource = plan.mode === 'live'
    ? new LiveJurors({ apiKey: env.NEARAI_API_KEY!, baseUrl: env.NEARAI_BASE_URL })
    : new ReplayJurors(repoFile('fixtures/panel'));
  /** Every ballot the panel got, by sha256 of its request body: the vote events carry them for the page's own check. */
  const ballots = new Map<string, PanelRecording>();
  const jurors: JurorSource = {
    mode: source.mode,
    ask: async (model, body) => { const rec = await source.ask(model, body); ballots.set(sha256Hex(body), rec); return rec; },
  };
  const resolverChain = clientOf(ACCOUNTS.resolver); // one client per key: scene 5 submits through it too
  const panelApp = createPanelApp(new PanelService({ chain: resolverChain, jurors }), { mode: plan.mode });
  const panelServer: Server = await new Promise((r) => { const s = panelApp.listen(0, '127.0.0.1', () => r(s)); });
  servers.push({ close: () => new Promise<void>((r) => { panelServer.closeAllConnections(); panelServer.close(() => r()); }) });
  const panelUrl = `http://127.0.0.1:${(panelServer.address() as AddressInfo).port}`;
  say(`demo sellers serve fixed fixture data behind the ${PRODUCT_NAME} middleware; panel service (${plan.mode}${synthetic ? ': answers signed with TEST keys' : ''}) and resolver account '${world.id(ACCOUNTS.resolver)}' running`);
  await snapshot();

  // the buyer's HTTP client; in scene 4 the seller process dies after it was paid, before it delivers
  let killBeforeDelivery: DemoSeller | null = null;
  const buyerFetch: typeof fetch = async (input, init) => {
    const k = killBeforeDelivery;
    if (k && new Headers(init?.headers).has(HDR_PAYMENT_SIGNATURE) && String(input).startsWith(k.url)) {
      killBeforeDelivery = null;
      await k.kill();
      say(`${labelOf(k.id)} process stopped after being paid, before delivering`);
      feed.emit({ kind: 'log', actor: labelOf(k.id), text: 'process stopped' });
    }
    return fetch(input, init);
  };
  const buyer = (id: string) => new CertoClient({ chain: clientOf(id), fetch: buyerFetch });
  const scout = buyer('scout');
  const liar = buyer('scout-liar');
  const urlOf = (s: string) => `${sellers[s]!.url}${fx.request}`;
  const sellerView = async (label: string) => (await viewer.getSeller(world.id(label)))!;
  const bal = (label: string) => world.balance(world.id(label));
  const asked = new URLSearchParams(fx.request.split('?')[1] ?? '').get('token');
  /** The page highlights the `token` field only when it is not the token asked for. */
  const mismatchOf = (body: string): string | undefined => {
    const m = /"token":"([^"]*)"/.exec(body);
    return m && m[1] !== asked ? m[0] : undefined;
  };

  const emitCall = async (scene: number, buyerId: string, sellerId: string, r: CallResult | null, callId: string, highlight?: string) => {
    const [call, sv] = await Promise.all([viewer.getCall(callId), viewer.getSeller(sellerId)]);
    feed.emit({
      kind: 'call', scene, buyer: buyerId, seller: sellerId, request: `GET ${fx.request}`, price: formatUsdc(fx.price), callId,
      status: r ? r.status : null, responsePreview: r ? r.body.slice(0, 300) : '',
      fee: formatUsdc(call?.fee ?? '0'), feeBps: Number(BigInt(call?.fee ?? '0') * 10000n / BigInt(fx.price)), // fee_bps of call_paid (fee is exact at this price)
      windowMs: sv?.window_ms ?? 0, ...(highlight ? { highlight } : {}),
    });
  };
  const verifiedJurors = new Set<number>();
  const flush = () => { const h = held ?? []; held = null; for (const f of h) f(); };

  /** Content dispute → seller's answer → panel → resolve. Returns the panel outcome. */
  const contentDispute = async (scene: number, client: CertoClient, buyerId: string, r: CallResult): Promise<{ outcome: CaseOutcome; stake: string; t: number }> => {
    const t = Date.now();
    const d = await client.dispute(r, { offerBps: 10_000 });
    say(`${buyerId} opened a content dispute: stake ${formatUsdc(d.stake)}, sealed offer (commitment ${short(d.commit)})`);
    const opened = d.tx.events.find((e) => e.event === 'dispute_opened')?.data as { answer_by_ms?: number } | undefined;
    const answerByMs = opened?.answer_by_ms;
    const sellerLabel = labelOf(r.seller);
    feed.emit({ kind: 'dispute', scene, callId: r.callId, buyer: buyerId, seller: sellerLabel, disputeKind: 'content', stake: formatUsdc(d.stake), ...(answerByMs ? { answerByMs } : {}) });
    const answered = await client.waitForStatus(r.callId, ['Answered'], { timeoutMs: testnet ? 90_000 : 20_000, pollMs: testnet ? 1000 : 300 });
    const sellerBps = answered?.dispute?.seller_offer_bps ?? 0;
    say(`${sellerLabel} answered with offer ${sellerBps / 100}%`);
    feed.emit({ kind: 'dispute', scene, callId: r.callId, buyer: buyerId, seller: sellerLabel, disputeKind: 'content', stake: formatUsdc(d.stake), sellerOfferPct: sellerBps / 100 });
    held = [];
    let outcome: CaseOutcome;
    try {
      outcome = (await client.submitToPanel(panelUrl, r.callId)) as CaseOutcome;
    } catch (e) {
      flush();
      throw e;
    }
    feed.emit({
      kind: 'dispute', scene, callId: r.callId, buyer: buyerId, seller: sellerLabel, disputeKind: 'content', stake: formatUsdc(d.stake),
      buyerOfferPct: d.offerBps / 100, sellerOfferPct: sellerBps / 100,
    });
    const bv = outcome.events?.find((e) => e.event === 'ballots_verified') as ContractEvent<{ votes: string[]; kinds: string[] }> | undefined;
    if (!outcome.submitted || !bv) flush();
    expect(outcome.submitted && !!bv, `panel did not resolve on chain (${outcome.reason ?? 'no ballots_verified event'})`);
    // the contract accepted all three signatures in one transaction; the votes are fed one by one so the page can show them in turn
    for (const [i, v] of bv!.data.votes.entries()) {
      verifiedJurors.add(i);
      const rec = ballots.get(outcome.request_sha256s[i] ?? '');
      const b = rec && toContractBallot(rec);
      feed.emit({
        kind: 'vote', scene, callId: r.callId, juror: i, model: JURORS[i]!.model, vote: v, sigVerified: true,
        ...(b ? { requestSha256: outcome.request_sha256s[i], responseBody: b.response_body, signature: b.signature, signatureKind: b.kind } : {}),
      });
      await new Promise((res) => setTimeout(res, VOTE_GAP_MS));
    }
    flush(); // the resolve transaction's events (ballots_verified, dispute_resolved) follow the votes
    say(`panel (${plan.mode}${synthetic ? ', TEST-key signatures' : ''}): ${JURORS.map((j, i) => `${j.model.split('/').pop()} ${bv!.data.votes[i]}`).join(', ')}; contract checked 3 ed25519 signatures over the prompts it rebuilt (tx ${txRef(outcome.txHash ?? '')})`);
    return { outcome, stake: d.stake, t };
  };

  /** `line`: the transcript line; `caption`: the short result the page shows (EVENTS.md, `scene`). */
  const scenes: Array<{ title: string; run: () => Promise<{ line: string; caption: string }> }> = [
    {
      title: 'Honest call: paid in the same transaction',
      run: async () => {
        const before = await bal('chainfacts');
        const s0 = await sellerView('chainfacts');
        say(`scout → chainfacts: GET ${fx.request} (price ${formatUsdc(fx.price)}; 402 quote → pay on chain → retry with proof)`);
        const r = await scout.call(urlOf('chainfacts'));
        const payTx = lastTx.get('scout:ft_transfer_call(pay)')!;
        await emitCall(1, 'scout', 'chainfacts', r, r.callId, mismatchOf(r.body));
        const after = await bal('chainfacts');
        const fee = BigInt(fx.price) * BigInt(s0.fee_bps) / 10000n;
        const net = BigInt(fx.price) - fee;
        const inTx = tokenTransfers(payTx).some((t) => t.new_owner_id === world.id('chainfacts') && BigInt(t.amount) === net);
        expect(after - before === net && (testnet || net === 396_000n), `seller received ${formatUsdc(after - before)}, expected ${testnet ? formatUsdc(net) : '0.396000'}`);
        expect(inTx, 'the payout to the seller is not in the paying transaction');
        const decision = simplePolicy(r);
        expect(decision.action === 'accept', `agent did not accept: ${decision.reason}`);
        say(`delivered ${r.body.length} bytes with a seller-signed receipt; agent: ${decision.reason} → accept`);
        feed.emit({ kind: 'log', actor: 'scout', text: `${decision.reason} → accept` });
        return {
          line: `Scene 1 honest call: scout paid chainfacts ${formatUsdc(fx.price)}, fee ${formatUsdc(fee)} (${pct(s0.fee_bps)}), seller balance +${formatUsdc(net)} in the paying transaction ${txRef(r.payTx)}`,
          caption: `chainfacts got +${cap(net)} in scout's own transaction: nothing held in escrow`,
        };
      },
    },
    {
      title: 'Asked NEAR, got NEO: content dispute, panel 3–0 for the buyer',
      run: async () => {
        const s0 = await sellerView('cheapfacts');
        const b0 = await bal('scout');
        say(`scout → cheapfacts: GET ${fx.request}`);
        const r = await scout.call(urlOf('cheapfacts'));
        const hl = mismatchOf(r.body);
        await emitCall(2, 'scout', 'cheapfacts', r, r.callId, hl);
        const decision = simplePolicy(r);
        expect(decision.action === 'dispute', `agent did not dispute: ${decision.reason}`);
        const logText = `asked NEAR, got ${hl?.split(':')[1]?.replaceAll('"', '') ?? '?'} → claim a refund`;
        say(`agent: ${logText}`);
        feed.emit({ kind: 'log', actor: 'scout', text: logText });
        const { outcome, t } = await contentDispute(2, scout, 'scout', r);
        const res = outcome.events!.find((e) => e.event === 'dispute_resolved')!.data as { winner: string; refund: string; votes: string[] };
        const s1 = await sellerView('cheapfacts');
        const b1 = await bal('scout');
        expect(res.winner === 'buyer' && res.votes.every((v) => v === 'buyer'), `panel votes ${res.votes.join('/')}`);
        expect(BigInt(res.refund) === 400_000n, `refund ${formatUsdc(res.refund)}`);
        expect(BigInt(s0.bond) === 50_000_000n && BigInt(s1.bond) === 49_580_000n, `bond ${formatUsdc(s0.bond)} → ${formatUsdc(s1.bond)}`);
        // a reused testnet seller may already sit in a higher fee tier from an earlier run; the step is what is checked there
        expect((testnet || s0.fee_bps === 100) && s1.fee_bps === feeAfterLoss(s0.fee_bps), `fee ${pct(s0.fee_bps)} → ${pct(s1.fee_bps)}`);
        expect(b1 === b0, `buyer balance ${formatUsdc(b0)} → ${formatUsdc(b1)} (expected unchanged after refund and stake back)`);
        feed.emit({ kind: 'resolved', scene: 2, callId: r.callId, tier: 'panel', winner: 'buyer', refund: formatUsdc(res.refund), votes: '3-0', elapsedMs: Date.now() - t });
        return {
          line: `Scene 2 asked NEAR, got NEO: content dispute, votes ${res.votes.join('/')}, 3 signatures verified by contract${synthetic ? ' (synthetic test keys)' : ''}, refund ${formatUsdc(res.refund)}, bond ${formatUsdc(s0.bond)} → ${formatUsdc(s1.bond)}, fee ${pct(s0.fee_bps)} → ${pct(s1.fee_bps)}`,
          caption: `3–0 for the buyer, 3 signatures checked by the contract: ${cap(res.refund)} back from cheapfacts' bond`,
        };
      },
    },
    {
      title: 'Lying buyer: panel 0–3, stake forfeited',
      run: async () => {
        const s0 = await sellerView('chainfacts');
        const b0 = await bal('scout-liar');
        say(`scout-liar → chainfacts: GET ${fx.request}`);
        const r = await liar.call(urlOf('chainfacts'));
        await emitCall(3, 'scout-liar', 'chainfacts', r, r.callId, mismatchOf(r.body));
        const honest = simplePolicy(r);
        say(`agent scout-liar: ${honest.reason}, disputes anyway (offer 100%)`);
        feed.emit({ kind: 'log', actor: 'scout-liar', text: `${honest.reason}; disputes anyway` });
        const { outcome, stake, t } = await contentDispute(3, liar, 'scout-liar', r);
        const res = outcome.events!.find((e) => e.event === 'dispute_resolved')!.data as { winner: string; refund: string; votes: string[] };
        const s1 = await sellerView('chainfacts');
        const b1 = await bal('scout-liar');
        expect(res.winner === 'seller' && res.votes.every((v) => v === 'seller'), `panel votes ${res.votes.join('/')}`);
        expect(BigInt(res.refund) === 0n, `refund ${formatUsdc(res.refund)}`);
        // on a reused testnet buyer the stake has doubled for each earlier lost dispute (DESIGN 4.5, buyer side)
        expect((testnet || BigInt(stake) === 20_000n) && b0 - b1 === BigInt(fx.price) + BigInt(stake), `liar paid ${formatUsdc(b0 - b1)}, expected price + ${formatUsdc(stake)} stake`);
        expect(s1.bond === s0.bond && s1.fee_bps === s0.fee_bps, `seller bond/fee changed: ${formatUsdc(s0.bond)} → ${formatUsdc(s1.bond)}, ${pct(s0.fee_bps)} → ${pct(s1.fee_bps)}`);
        feed.emit({ kind: 'resolved', scene: 3, callId: r.callId, tier: 'panel', winner: 'seller', refund: formatUsdc(res.refund), votes: '0-3', elapsedMs: Date.now() - t });
        return {
          line: `Scene 3 lying buyer: scout-liar disputed correct data, votes ${res.votes.join('/')}, buyer stake ${formatUsdc(stake)} forfeited; chainfacts bond ${formatUsdc(s1.bond)} unchanged, fee stays ${pct(s1.fee_bps)}`,
          caption: `0–3 for the seller: scout-liar loses its ${cap(stake)} stake; chainfacts keeps bond and fee`,
        };
      },
    },
    {
      title: 'Seller dead: non-delivery refunded by rule',
      run: async () => {
        const s0 = await sellerView('cheapfacts');
        const b0 = await bal('scout');
        const answerMs = (await viewer.getConfig()).answer_ms;
        say(`scout → cheapfacts: GET ${fx.request}`);
        killBeforeDelivery = sellers.cheapfacts!;
        let callId: string;
        try {
          await scout.call(urlOf('cheapfacts'));
          throw new SceneFailure('the dead seller delivered');
        } catch (e) {
          if (!(e instanceof CertoError) || !e.callId) throw e;
          callId = e.callId;
          say(`paid, no delivery (${e.code}) → claim non-delivery`);
          feed.emit({ kind: 'log', actor: 'scout', text: 'paid, nothing delivered → claim non-delivery' });
        }
        await emitCall(4, 'scout', 'cheapfacts', null, callId);
        const t = Date.now();
        const claim = await scout.claimNonDelivery(callId);
        const opened = claim.events.find((e) => e.event === 'dispute_opened')!.data as { stake: string; answer_by_ms?: number };
        const call = await viewer.getCall(callId);
        const answerBy = opened.answer_by_ms ?? (call!.dispute!.opened_at_ms + answerMs);
        say(`non-delivery claim open: stake ${formatUsdc(opened.stake)}; seller has ${answerMs / 1000} s to cure`);
        feed.emit({ kind: 'dispute', scene: 4, callId, buyer: 'scout', seller: 'cheapfacts', disputeKind: 'non_delivery', stake: formatUsdc(opened.stake), answerByMs: answerBy, answerMs });
        let tx: TxResult | undefined;
        for (let i = 0; !tx; i++) {
          const left = Math.max(0, Math.ceil((answerBy - (await world.nowMs())) / 1000));
          feed.emit({ kind: 'log', actor: 'contract', text: left > 0 ? `seller silent, ${left} s left` : 'seller silent, time is up' });
          if (left > 0) { await new Promise((r) => setTimeout(r, Math.min(1000, left * 1000))); continue; }
          try {
            tx = await scout.resolveDefault(callId);
          } catch (e) {
            if ((e as ContractError).code !== 'E_TOO_EARLY' || i > 40) throw e;
            await new Promise((r) => setTimeout(r, 300));
          }
        }
        const res = tx.events.find((e) => e.event === 'dispute_resolved')!.data as { tier: string; reason: string; refund: string };
        const s1 = await sellerView('cheapfacts');
        const b1 = await bal('scout');
        expect(res.tier === 'rule' && res.reason === 'seller_no_answer', `resolved as ${res.tier}/${res.reason}`);
        expect(BigInt(res.refund) === 400_000n, `refund ${formatUsdc(res.refund)}`);
        expect(BigInt(s0.bond) === 49_580_000n && BigInt(s1.bond) === 49_160_000n, `bond ${formatUsdc(s0.bond)} → ${formatUsdc(s1.bond)}`);
        expect(b1 === b0, `buyer balance ${formatUsdc(b0)} → ${formatUsdc(b1)} (expected unchanged)`);
        feed.emit({ kind: 'resolved', scene: 4, callId, tier: 'rule', winner: 'buyer', refund: formatUsdc(res.refund), elapsedMs: Date.now() - t });
        say(`resolve_default by scout: refund ${formatUsdc(res.refund)} + stake back; seller pays the ruling fee (tx ${txRef(tx.txHash)})`);
        expect((testnet || s0.fee_bps === 150) && s1.fee_bps === feeAfterLoss(s0.fee_bps), `fee ${pct(s0.fee_bps)} → ${pct(s1.fee_bps)}`);
        return {
          line: `Scene 4 seller dead: seller did not answer in ${answerMs / 1000} s (${testnet ? 'testnet setting' : 'demo setting; 30 s on testnet'}), refund ${formatUsdc(res.refund)} by rule, no panel, bond ${formatUsdc(s0.bond)} → ${formatUsdc(s1.bond)}, fee ${pct(s0.fee_bps)} → ${pct(s1.fee_bps)} (${testnet ? 'loss recorded' : 'second loss'})`,
          caption: `cheapfacts silent ${answerMs / 1000} s: ${cap(res.refund)} refunded by rule, no panel; fee ${pct(s0.fee_bps)} → ${pct(s1.fee_bps)}`,
        };
      },
    },
  ];

  // Scene 5 needs genesis accounts to deploy a second contract, so it runs on the sandbox only.
  if (world.local) {
    const market = world.local;
    scenes.push({
      title: "We attack our own contract: one byte of a juror's signed answer changed",
      run: async () => {
        // a build of the same contract without guard G1 (juror signature check), ready while the real attack runs
        const weakReady = (async () => {
          const weak = await deployMarket({
            chain: market.chain, contract: UNCHECKED.contract, token: market.token, owner: UNCHECKED.resolver, resolver: UNCHECKED.resolver,
            wasm: WASM.guard(1), jurors: plan.jurors, gatewayKey: plan.gatewayKey, acceptGateway: plan.acceptGateway,
          });
          const [seller] = await Promise.all([
            addSeller(weak, { id: UNCHECKED.seller, bond: '5000000', terms }),
            weak.mint(UNCHECKED.buyer, BUYER_FUNDS),
          ]);
          return { weak, seller };
        })();
        weakReady.catch(() => undefined);
        const forging = new ForgingJurors(jurors, FORGED_JUROR);
        const juror = JURORS[FORGED_JUROR]!;
        say(`scout-liar → chainfacts: GET ${fx.request}, then a content dispute on the correct answer`);
        const r = await liar.call(urlOf('chainfacts'));
        await emitCall(5, 'scout-liar', 'chainfacts', r, r.callId);
        const d = await liar.dispute(r, { offerBps: 10_000 });
        const base = { kind: 'dispute', scene: 5, callId: r.callId, buyer: 'scout-liar', seller: 'chainfacts', disputeKind: 'content', stake: formatUsdc(d.stake) };
        feed.emit(base);
        await liar.waitForStatus(r.callId, ['Answered'], { timeoutMs: 20_000, pollMs: 300 });
        feed.emit({ ...base, sellerOfferPct: 0, buyerOfferPct: d.offerBps / 100 });
        const caseReq = { call_id: r.callId, buyer_offer_bps: d.offerBps, salt: d.salt, request_canon: r.requestCanon, response_body: r.body };

        // the attack on this demo's contract: the recorded ballots, one answer edited, signatures kept
        const err = await new PanelService({ chain: resolverChain, jurors: forging, verifyBallots: false })
          .handleCase(caseReq).then(() => null, (e: unknown) => e as ContractError);
        const edit = `${jurorName(juror.family)}'s answer ${forging.edit?.from} → ${forging.edit?.to}`;
        const code = err?.code ?? err?.message ?? 'accepted';
        say(`attacker changed one byte of ${edit} (signature kept) and submitted resolve: ${PRODUCT_ID} (res/certo.wasm) ${err ? `rejected it with ${code}` : 'ACCEPTED it'}${err?.tx ? ` (tx ${txRef(err.tx.txHash)})` : ''}`);
        feed.emit({
          kind: 'attack', scene: 5, callId: r.callId, juror: FORGED_JUROR, from: forging.edit?.from, to: forging.edit?.to, build: 'real',
          rejected: !!err, ...(err ? { error: code } : {}), votes: forging.sides, ...(err?.tx ? { txHash: err.tx.txHash } : {}),
        });
        expect(code === 'E_BALLOT_SIG', `the real contract answered ${code}, expected E_BALLOT_SIG`);

        // the same attack on the build without the check
        const { weak, seller } = await weakReady;
        const b = weak.client(UNCHECKED.buyer);
        const quote = sha256Hex(`scene5:${r.callId}`).slice(0, 32);
        const callId = `${UNCHECKED.seller}/${quote}`;
        await b.pay({ seller: UNCHECKED.seller, quote_id: quote, terms_id: fx.terms.terms_id, request_hash: requestHash(r.requestCanon), amount: fx.price });
        const receipt = { response_hash: sha256Hex(r.body), status_code: 200, served_at_ms: Date.now() };
        const sig = signBase64(receiptText({
          contract: UNCHECKED.contract, callId, buyer: UNCHECKED.buyer, price: fx.price, termsId: fx.terms.terms_id, requestHash: requestHash(r.requestCanon),
          responseHash: receipt.response_hash, statusCode: receipt.status_code, servedAtMs: receipt.served_at_ms,
        }), seller.receiptKey);
        await b.disputeContent({ call_id: callId, stake: await new CertoClient({ chain: b }).stakeFor(UNCHECKED.seller, fx.price), offer_commit: d.commit, ...receipt, sig });
        await seller.chain.answer(callId, 0);
        const weakOut = await new PanelService({ chain: weak.client(UNCHECKED.resolver), jurors: forging, verifyBallots: false })
          .handleCase({ ...caseReq, call_id: callId });
        const bv = weakOut.events?.find((e) => e.event === 'ballots_verified')?.data as { votes?: string[] } | undefined;
        const votes = bv?.votes ?? [];
        say(`same attack on ${WASM.guard(1)} (signature check compiled out): forged vote counted, votes ${votes.join('/')} (tx ${txRef(weakOut.txHash ?? '')})`);
        feed.emit({ kind: 'attack', scene: 5, callId: r.callId, juror: FORGED_JUROR, from: forging.edit?.from, to: forging.edit?.to, build: 'no-check', rejected: false, votes, winner: weakOut.winner, txHash: weakOut.txHash });
        expect(votes[FORGED_JUROR] === forging.sides[FORGED_JUROR], `the build without the check did not count the forged vote (votes ${votes.join('/')})`);
        return {
          line: `Scene 5 forged vote: one byte of ${edit} changed after signing; ${PRODUCT_ID} rejected it with ${code}; ${WASM.guard(1)} (check compiled out) counted it, votes ${votes.join('/')}`,
          caption: `Forged vote rejected with ${code}; a build without the check counted it`,
        };
      },
    });
  }

  let scenesOk = 0;
  for (const [i, s] of scenes.entries()) {
    feed.emit({ kind: 'scene', n: i + 1, title: s.title, status: 'start' });
    try {
      const { line, caption } = await s.run();
      await snapshot();
      scenesOk++;
      lines.push(line);
      print(line);
      feed.emit({ kind: 'scene', n: i + 1, title: s.title, status: 'ok', line, caption });
    } catch (e) {
      const line = `Scene ${i + 1} FAILED: ${(e as Error).message}`;
      lines.push(line);
      print(line);
      feed.emit({ kind: 'scene', n: i + 1, title: s.title, status: 'fail', line });
      break;
    }
  }
  const ok = scenesOk === scenes.length && verifiedJurors.size === 3;
  const summary = `${ok ? 'DEMO OK' : 'DEMO FAILED'}: ${scenesOk}/${scenes.length} scenes, ${verifiedJurors.size}/3 juror signatures verified on chain${synthetic ? ' (synthetic test keys)' : ''}`;
  if (testnet) {
    print(`testnet transactions of this run (${txLog.length}):`);
    for (const t of txLog) print(`  ${t.signer.padEnd(10)} ${t.method.padEnd(26)} ${world.txUrl(t.hash)}${t.error ? `  (failed: ${t.error})` : ''}`);
  }
  feed.emit({ kind: 'done', ok, summary });
  lines.push(summary);
  print(summary);
  const exampleUrls = Object.fromEntries(ACCOUNTS.sellers.map((s) => [s, urlOf(s)]));
  return { ok, scenesOk, jurorsVerified: verifiedJurors.size, plan, lines, feed, port, elapsedMs: Date.now() - t0, world, panelUrl, exampleUrls, reviveSellers, watchAgent, shutdown };
}
