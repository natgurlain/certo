/**
 * The four scenes of DESIGN 5.5 on a local sandbox, with the transcript of
 * README step 2 (4.6) and the event feed of `apps/demo/EVENTS.md`.
 * Every amount printed is read from the chain and checked against the
 * expected value; a mismatch fails the scene.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MakegoodClient, MakegoodError, simplePolicy, type CallResult } from '@makegood/buyer';
import {
  HDR_PAYMENT_SIGNATURE, JURORS, PRODUCT_ID, PRODUCT_NAME, formatUsdc, type ContractError, type ContractEvent, type TxResult,
} from '@makegood/core';
import { LiveJurors, PanelService, ReplayJurors, createPanelApp, type CaseOutcome } from '@makegood/panel';
import { Feed } from './feed.js';
import { choosePanel, loadDemo, type PanelPlan } from './fixtures.js';
import { LocalChain, repoFile, SANDBOX_VERSION } from './sandbox.js';
import { startDemoSeller, type DemoSeller } from './seller.js';
import { feeAfterLoss, jurorsForPlan, ensureDeployed, testnetWorld, type TestnetConfig } from './testnet.js';
import { DEMO_BOND, DEMO_BUYER_FUNDS, addSeller, deployMarket, type DemoWorld, type TracedChain } from './world.js';

export const ACCOUNTS = {
  contract: PRODUCT_ID, token: 'usdc', owner: 'owner', resolver: 'resolver',
  sellers: ['chainfacts', 'cheapfacts'] as const, buyers: ['scout', 'scout-liar'] as const,
};
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
  shutdown(opts?: { keepFeed?: boolean }): Promise<void>;
}

const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
const short = (h: string) => `${h.slice(0, 8)}…`;

/** Local sandbox market: genesis accounts, both contracts, two bonded sellers, two funded buyers. */
async function sandboxWorld(plan: PanelPlan, terms: Array<{ terms_id: string; text: string; panel: boolean }>): Promise<DemoWorld> {
  const chain = await LocalChain.start([ACCOUNTS.contract, ACCOUNTS.token, ACCOUNTS.owner, ACCOUNTS.resolver, ...ACCOUNTS.sellers, ...ACCOUNTS.buyers]);
  try {
    const market = await deployMarket({
      chain, contract: ACCOUNTS.contract, token: ACCOUNTS.token, owner: ACCOUNTS.owner, resolver: ACCOUNTS.resolver,
      wasm: 'res/makegood.wasm', deployToken: true, jurors: plan.jurors, gatewayKey: plan.gatewayKey, acceptGateway: plan.acceptGateway,
    });
    const regs = await Promise.all([
      addSeller(market, { id: 'chainfacts', bond: BOND, terms }),
      addSeller(market, { id: 'cheapfacts', bond: BOND, terms }),
      ...ACCOUNTS.buyers.map((b) => market.mint(b, BUYER_FUNDS)),
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
  feed.emit({
    kind: 'actors',
    buyers: [{ id: 'scout', label: 'Buyer agent scout' }, { id: 'scout-liar', label: 'Buyer agent scout-liar' }],
    sellers: [{ id: 'chainfacts', label: 'chainfacts (honest)' }, { id: 'cheapfacts', label: 'cheapfacts' }],
    jurors: JURORS.map((j) => ({ index: j.index, model: j.model, family: j.family })),
  });

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
        Promise.all(ACCOUNTS.buyers.map(async (id) => [id, { balance: formatUsdc(await world.balance(world.id(id))) }] as const)),
        Promise.all(ACCOUNTS.sellers.map(async (id) => {
          const s = await viewer.getSeller(world.id(id));
          return [id, {
            balance: formatUsdc(await world.balance(world.id(id))),
            bond: formatUsdc(s?.bond ?? '0'),
            exposed: formatUsdc(s ? BigInt(s.bond) - BigInt(s.free_capacity) : 0n),
            feeBps: s?.fee_bps ?? 0,
            record: { calls: s?.lifetime_calls ?? 0, losses: s?.lifetime_losses ?? 0 },
          }] as const;
        })),
      ]);
      feed.emit({ kind: 'state', buyers: Object.fromEntries(buyers), sellers: Object.fromEntries(sellers) });
    }).catch(() => undefined);
    return snapshotQueue;
  };
  const onTx = (signer: string) => (method: string, tx: TxResult, err?: ContractError) => {
    lastTx.set(`${signer}:${method}`, tx);
    txLog.push({ signer, method, hash: tx.txHash, ...(err ? { error: err.code ?? err.message } : {}) });
    for (const e of tx.events) feed.emit({ kind: 'chain', event: e.event, data: e.data, txHash: tx.txHash });
    if (err) feed.emit({ kind: 'chain', event: 'tx_failed', data: { method, signer, error: err.code ?? err.message }, txHash: tx.txHash });
    void snapshot();
  };

  const clientOf = (id: string) => world.client(id, onTx(id));
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
  };
  const sellers: Record<string, DemoSeller> = {};
  for (const label of ACCOUNTS.sellers) {
    const s = await startDemoSeller({
      id: world.id(label), chain: clientOf(label), receiptKey: world.receiptKey(label), termsId: fx.terms.terms_id, price: fx.price,
      responses: { [fx.request]: fx.responses[label] }, offerBps: 0, onBot: botLog(label), botPollMs: testnet ? 1500 : 400,
    });
    sellers[label] = s;
    servers.push({ close: () => s.kill() });
  }
  const jurors = plan.mode === 'live'
    ? new LiveJurors({ apiKey: env.NEARAI_API_KEY!, baseUrl: env.NEARAI_BASE_URL })
    : new ReplayJurors(repoFile('fixtures/panel'));
  const panelApp = createPanelApp(new PanelService({ chain: clientOf(ACCOUNTS.resolver), jurors }), { mode: plan.mode });
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
  const buyer = (id: string) => new MakegoodClient({ chain: clientOf(id), fetch: buyerFetch });
  const scout = buyer('scout');
  const liar = buyer('scout-liar');
  const urlOf = (s: string) => `${sellers[s]!.url}${fx.request}`;
  const sellerView = async (label: string) => (await viewer.getSeller(world.id(label)))!;
  const bal = (label: string) => world.balance(world.id(label));
  const highlightOf = (body: string): string | undefined => /"token":"[^"]*"/.exec(body)?.[0];

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

  /** Content dispute → seller's answer → panel → resolve. Returns the panel outcome. */
  const contentDispute = async (scene: number, client: MakegoodClient, buyerId: string, r: CallResult): Promise<{ outcome: CaseOutcome; stake: string; t: number }> => {
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
    const outcome = (await client.submitToPanel(panelUrl, r.callId)) as CaseOutcome;
    feed.emit({
      kind: 'dispute', scene, callId: r.callId, buyer: buyerId, seller: sellerLabel, disputeKind: 'content', stake: formatUsdc(d.stake),
      buyerOfferPct: d.offerBps / 100, sellerOfferPct: sellerBps / 100,
    });
    const bv = outcome.events?.find((e) => e.event === 'ballots_verified') as ContractEvent<{ votes: string[]; kinds: string[] }> | undefined;
    expect(outcome.submitted && !!bv, `panel did not resolve on chain (${outcome.reason ?? 'no ballots_verified event'})`);
    // the contract accepted all three signatures in one transaction; the votes are fed one by one so the page can show them in turn
    for (const [i, v] of bv!.data.votes.entries()) {
      verifiedJurors.add(i);
      feed.emit({ kind: 'vote', scene, callId: r.callId, juror: i, model: JURORS[i]!.model, vote: v, sigVerified: true });
      await new Promise((res) => setTimeout(res, VOTE_GAP_MS));
    }
    say(`panel (${plan.mode}${synthetic ? ', TEST-key signatures' : ''}): ${JURORS.map((j, i) => `${j.model.split('/').pop()} ${bv!.data.votes[i]}`).join(', ')}; contract checked 3 ed25519 signatures over the prompts it rebuilt (tx ${txRef(outcome.txHash ?? '')})`);
    return { outcome, stake: d.stake, t };
  };

  const scenes: Array<{ title: string; run: () => Promise<string> }> = [
    {
      title: 'Honest call: paid in the same transaction',
      run: async () => {
        const before = await bal('chainfacts');
        const s0 = await sellerView('chainfacts');
        say(`scout → chainfacts: GET ${fx.request} (price ${formatUsdc(fx.price)}; 402 quote → pay on chain → retry with proof)`);
        const r = await scout.call(urlOf('chainfacts'));
        const payTx = lastTx.get('scout:ft_transfer_call(pay)')!;
        await emitCall(1, 'scout', 'chainfacts', r, r.callId, highlightOf(r.body));
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
        return `Scene 1 honest call: scout paid chainfacts ${formatUsdc(fx.price)}, fee ${formatUsdc(fee)} (${pct(s0.fee_bps)}), seller balance +${formatUsdc(net)} in the paying transaction ${txRef(r.payTx)}`;
      },
    },
    {
      title: 'Asked NEAR, got NEO: content dispute, panel 3–0 for the buyer',
      run: async () => {
        const s0 = await sellerView('cheapfacts');
        const b0 = await bal('scout');
        say(`scout → cheapfacts: GET ${fx.request}`);
        const r = await scout.call(urlOf('cheapfacts'));
        const hl = highlightOf(r.body);
        await emitCall(2, 'scout', 'cheapfacts', r, r.callId, hl);
        const decision = simplePolicy(r);
        expect(decision.action === 'dispute', `agent did not dispute: ${decision.reason}`);
        const logText = `asked NEAR, got ${hl?.split(':')[1]?.replaceAll('"', '') ?? '?'} → claim a ${PRODUCT_ID}`;
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
        return `Scene 2 asked NEAR, got NEO: content dispute, votes ${res.votes.join('/')}, 3 signatures verified by contract${synthetic ? ' (synthetic test keys)' : ''}, refund ${formatUsdc(res.refund)}, bond ${formatUsdc(s0.bond)} → ${formatUsdc(s1.bond)}, fee ${pct(s0.fee_bps)} → ${pct(s1.fee_bps)}`;
      },
    },
    {
      title: 'Lying buyer: panel 0–3, stake forfeited',
      run: async () => {
        const s0 = await sellerView('chainfacts');
        const b0 = await bal('scout-liar');
        say(`scout-liar → chainfacts: GET ${fx.request}`);
        const r = await liar.call(urlOf('chainfacts'));
        await emitCall(3, 'scout-liar', 'chainfacts', r, r.callId, highlightOf(r.body));
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
        return `Scene 3 lying buyer: scout-liar disputed correct data, votes ${res.votes.join('/')}, buyer stake ${formatUsdc(stake)} forfeited; chainfacts bond ${formatUsdc(s1.bond)} unchanged, fee stays ${pct(s1.fee_bps)}`;
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
          if (!(e instanceof MakegoodError) || !e.callId) throw e;
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
        feed.emit({ kind: 'dispute', scene: 4, callId, buyer: 'scout', seller: 'cheapfacts', disputeKind: 'non_delivery', stake: formatUsdc(opened.stake), answerByMs: answerBy });
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
        return `Scene 4 seller dead: seller did not answer in ${answerMs / 1000} s (${testnet ? 'testnet setting' : 'demo setting; 30 s on testnet'}), refund ${formatUsdc(res.refund)} by rule, no panel, bond ${formatUsdc(s0.bond)} → ${formatUsdc(s1.bond)}, fee ${pct(s0.fee_bps)} → ${pct(s1.fee_bps)} (${testnet ? 'loss recorded' : 'second loss'})`;
      },
    },
  ];

  let scenesOk = 0;
  for (const [i, s] of scenes.entries()) {
    feed.emit({ kind: 'scene', n: i + 1, title: s.title, status: 'start' });
    try {
      const line = await s.run();
      await snapshot();
      scenesOk++;
      lines.push(line);
      print(line);
      feed.emit({ kind: 'scene', n: i + 1, title: s.title, status: 'ok', line });
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
  return { ok, scenesOk, jurorsVerified: verifiedJurors.size, plan, lines, feed, port, elapsedMs: Date.now() - t0, shutdown };
}
