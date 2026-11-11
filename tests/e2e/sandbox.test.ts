/**
 * End-to-end tests on a local NEAR sandbox against the committed wasm in
 * `res/`, through the real TS packages: seller middleware and answer bot,
 * buyer SDK, panel service (replay of `fixtures/panel/`) and resolver.
 */
import { readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CertoClient, CertoError, simplePolicy } from '@certo/buyer';
import {
  HDR_PAYMENT_REQUIRED, HDR_PAYMENT_SIGNATURE, JURORS, buildPanelRequestFor, decodeHeader, encodeHeader,
  hasEvent, receiptText, requestCanon, requestHash, type PaymentRequired, type PaymentSignature, type TxResult,
} from '@certo/core';
import { PanelService, ReplayJurors, createPanelApp } from '@certo/panel';
import { choosePanel, demoCases, loadDemo, syntheticJurorsFile } from '../../apps/demo/src/fixtures.js';
import { LocalChain, repoFile } from '../../apps/demo/src/sandbox.js';
import { startDemoSeller, type DemoSeller } from '../../apps/demo/src/seller.js';
import { addSeller, deployMarket, type Market } from '../../apps/demo/src/world.js';

const vectors = JSON.parse(readFileSync(repoFile('fixtures/vectors.json'), 'utf8')) as {
  panel_requests: Array<{ name: string; juror_idx: number; terms_text: string; request_canon: string; response_body: string; buyer_bps: number; seller_bps: number; model: string; body: string }>;
  receipts: { items: Array<{ contract: string; callId: string; buyer: string; price: string; termsId: string; requestHash: string; responseHash: string; statusCode: number; servedAtMs: number; text: string }> };
};

const fx = loadDemo();
const PRICE = fx.price; // 0.40
const BOND = '50000000';
const plan = choosePanel({}); // replay or replay-synthetic, whichever fixtures/panel holds
const VEC_CONTRACTS = [...new Set(vectors.receipts.items.map((r) => r.contract))];
const VEC_SELLERS = [...new Set(vectors.receipts.items.map((r) => r.callId.split('/')[0]!))];
const VEC_BUYERS = [...new Set(vectors.receipts.items.map((r) => r.buyer))];

const SELLERS = ['s-clean', 's-good', 's-bad', 's-err', 's-rule', 's-silent'] as const;
const BUYERS = ['b-clean', 'b-upheld', 'b-rejected', 'b-5xx', 'b-nd', 'b-rule', 'b-mismatch', 'b-body'] as const;

let chain: LocalChain;
let m: Market;
let panelServer: Server;
let panelUrl: string;
const sellers: Record<string, DemoSeller> = {};
const urlOf = (s: string, path = fx.request) => `${sellers[s]!.url}${path}`;

// required fields only: a freshness rule would make the outcome depend on today's date (fixture as_of is fixed)
const RULE_TERMS = { terms_id: 'rules-v1', text: fx.terms.text, required_fields: ['token', 'as_of', 'total_holders', 'holders'], panel: false };
const FULL_PATH = `${fx.request}&full=1`;
const MISSING_FIELD_BODY = '{"token":"NEAR","as_of":1794300196,"total_holders":3208117}';

beforeAll(async () => {
  chain = await LocalChain.start(['mg', 'usdc', 'owner', 'resolver', ...SELLERS, ...BUYERS, ...VEC_CONTRACTS, ...VEC_SELLERS, ...VEC_BUYERS]);
  m = await deployMarket({
    chain, contract: 'mg', token: 'usdc', owner: 'owner', resolver: 'resolver', wasm: 'res/certo.wasm', deployToken: true,
    jurors: plan.jurors, gatewayKey: plan.gatewayKey, acceptGateway: plan.acceptGateway,
  });
  const terms = [{ terms_id: fx.terms.terms_id, text: fx.terms.text, panel: true }];
  const regs = await Promise.all([
    addSeller(m, { id: 's-clean', bond: BOND, terms }),
    addSeller(m, { id: 's-good', bond: BOND, terms }),
    addSeller(m, { id: 's-bad', bond: BOND, terms }),
    addSeller(m, { id: 's-err', bond: BOND, terms }),
    addSeller(m, { id: 's-rule', bond: BOND, terms: [RULE_TERMS] }),
    addSeller(m, { id: 's-silent', bond: BOND, terms }),
    ...BUYERS.map((b) => m.mint(b, '10000000')),
  ]);
  const bodies: Record<string, string> = {
    's-clean': fx.responses.chainfacts, 's-good': fx.responses.chainfacts, 's-bad': fx.responses.cheapfacts, 's-err': fx.responses.chainfacts, 's-rule': MISSING_FIELD_BODY,
  };
  const extra: Record<string, Record<string, string>> = { 's-rule': { [FULL_PATH]: fx.responses.chainfacts } };
  for (const reg of regs.slice(0, 5) as Awaited<ReturnType<typeof addSeller>>[]) {
    sellers[reg.id] = await startDemoSeller({
      id: reg.id, chain: reg.chain, receiptKey: reg.receiptKey, termsId: reg.id === 's-rule' ? 'rules-v1' : fx.terms.terms_id,
      price: PRICE, responses: { [fx.request]: bodies[reg.id]!, ...extra[reg.id] }, behaviour: reg.id === 's-err' ? 'error503' : 'fixture',
    });
  }
  const app = createPanelApp(new PanelService({ chain: m.client('resolver'), jurors: new ReplayJurors(repoFile('fixtures/panel')) }));
  panelServer = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  panelUrl = `http://127.0.0.1:${(panelServer.address() as AddressInfo).port}`;
}, 300_000);

afterAll(async () => {
  for (const s of Object.values(sellers)) await s.kill();
  panelServer?.closeAllConnections();
  panelServer?.close();
  await chain?.stop();
});

const buyer = (id: string, f?: typeof fetch) => new CertoClient({ chain: m.client(id), fetch: f });
const view = () => m.client();
const transfersTo = (tx: TxResult, to: string) => tx.logs
  .filter((l) => l.startsWith('EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer"'))
  .flatMap((l) => (JSON.parse(l.slice(11)) as { data: Array<{ new_owner_id: string; amount: string }> }).data)
  .filter((d) => d.new_owner_id === to);

describe.concurrent('sandbox e2e', () => {
  it('clean call: 402 → pay → retry → signed receipt; seller paid 0.396 in the paying transaction', async () => {
    const before = await m.balance('s-clean');
    const traced = m.client('b-clean');
    let payTx: TxResult | undefined;
    traced.onTx = (method, tx) => { if (method === 'ft_transfer_call(pay)') payTx = tx; };
    const r = await new CertoClient({ chain: traced }).call(urlOf('s-clean'));
    expect(r.status).toBe(200);
    expect(r.body).toBe(fx.responses.chainfacts);
    expect(simplePolicy(r).action).toBe('accept');
    expect(transfersTo(payTx!, 's-clean').map((t) => t.amount)).toEqual(['396000']);
    expect((await m.balance('s-clean')) - before).toBe(396_000n);
    const call = await view().getCall(r.callId);
    expect(call).toMatchObject({ status: 'Open', buyer: 'b-clean', price: PRICE, fee: '4000', request_hash: requestHash(requestCanon('GET', fx.request)) });
  });

  it('upheld content dispute: panel 3–0 for the buyer, refund from the bond, fee steps up', async () => {
    const c = buyer('b-upheld');
    const b0 = await m.balance('b-upheld');
    const r = await c.call(urlOf('s-bad'));
    const decision = simplePolicy(r);
    expect(decision).toMatchObject({ action: 'dispute', offerBps: 10_000 });
    await c.dispute(r, { offerBps: 10_000 });
    await c.waitForStatus(r.callId, ['Answered'], { timeoutMs: 20_000, pollMs: 300 });
    const out = (await c.submitToPanel(panelUrl, r.callId)) as { events: TxResult['events']; sides: string[] };
    expect(out.sides).toEqual(['buyer', 'buyer', 'buyer']);
    const res = out.events.find((e) => e.event === 'dispute_resolved')!.data;
    expect(res).toMatchObject({ tier: 'panel', winner: 'buyer', refund: PRICE, votes: ['buyer', 'buyer', 'buyer'] });
    const s = (await view().getSeller('s-bad'))!;
    expect([s.bond, s.fee_bps, s.lifetime_losses]).toEqual(['49580000', 150, 1]);
    expect(await m.balance('b-upheld')).toBe(b0);
    expect(await view().getCall(r.callId)).toBeNull();
  });

  it('rejected content dispute: panel 0–3, buyer stake to the treasury, buyer record doubles the next stake', async () => {
    const c = buyer('b-rejected');
    const b0 = await m.balance('b-rejected');
    const r = await c.call(urlOf('s-good'));
    expect(simplePolicy(r).action).toBe('accept');
    const d = await c.dispute(r, { offerBps: 10_000 });
    await c.waitForStatus(r.callId, ['Answered'], { timeoutMs: 20_000, pollMs: 300 });
    const out = (await c.submitToPanel(panelUrl, r.callId)) as { events: TxResult['events'] };
    expect(out.events.find((e) => e.event === 'dispute_resolved')!.data).toMatchObject({ winner: 'seller', refund: '0', votes: ['seller', 'seller', 'seller'] });
    expect(b0 - (await m.balance('b-rejected'))).toBe(BigInt(PRICE) + BigInt(d.stake));
    expect(await view().getBuyer('b-rejected')).toMatchObject({ disputes_lost: 1, stake_mult_log2: 1 });
    expect(await c.stakeFor('s-good', PRICE)).toBe('40000');
  });

  it('signed 5xx: claim_error refunds by rule, no stake, no panel', async () => {
    const c = buyer('b-5xx');
    const b0 = await m.balance('b-5xx');
    const r = await c.call(urlOf('s-err'));
    expect([r.status, r.receipt.statusCode]).toEqual([503, 503]);
    expect(simplePolicy(r).action).toBe('claim_error');
    const tx = await c.claimError(r);
    expect(tx.events.find((e) => e.event === 'dispute_resolved')!.data).toMatchObject({ tier: 'rule', reason: 'seller_error', refund: PRICE });
    expect(await m.balance('b-5xx')).toBe(b0);
    expect((await view().getSeller('s-err'))!.bond).toBe('49600000');
  });

  it('non-delivery: seller silent past answer_ms → resolve_default refunds in full, seller pays the ruling fee', async () => {
    const c = m.client('b-nd');
    const b0 = await m.balance('b-nd');
    const quoteId = '0'.repeat(31) + '7';
    const pay = await c.pay({ seller: 's-silent', quote_id: quoteId, terms_id: fx.terms.terms_id, request_hash: requestHash(requestCanon('GET', fx.request)), amount: PRICE });
    expect(hasEvent(pay, 'call_paid')).toBe(true);
    const callId = `s-silent/${quoteId}`;
    const client = new CertoClient({ chain: c });
    await client.claimNonDelivery(callId);
    await expect(c.resolveDefault({ call_id: callId })).rejects.toMatchObject({ code: 'E_TOO_EARLY' });
    const d = (await view().getCall(callId))!.dispute!;
    await chain.advancePast(d.opened_at_ms + (await view().getConfig()).answer_ms);
    const tx = await c.resolveDefault({ call_id: callId });
    expect(tx.events.find((e) => e.event === 'dispute_resolved')!.data).toMatchObject({ tier: 'rule', reason: 'seller_no_answer', refund: PRICE });
    expect(await m.balance('b-nd')).toBe(b0);
    expect((await view().getSeller('s-silent'))!.bond).toBe('49580000');
  });

  it('rule claim: a missing required field is refunded by the contract; an intact body is not', async () => {
    const c = buyer('b-rule');
    const b0 = await m.balance('b-rule');
    const r = await c.call(urlOf('s-rule'));
    const tx = await c.claimRule(r);
    expect(tx.events.find((e) => e.event === 'dispute_resolved')!.data).toMatchObject({ tier: 'rule', reason: 'missing_field:holders', refund: PRICE });
    expect(await m.balance('b-rule')).toBe(b0);
    // a body with every required field breaks no rule: the contract refuses and nothing moves
    const intact = await c.call(urlOf('s-rule', FULL_PATH));
    const b1 = await m.balance('b-rule');
    await expect(c.claimRule(intact)).rejects.toMatchObject({ code: 'E_RULE_NOT_BROKEN' });
    expect(await m.balance('b-rule')).toBe(b1);
    expect((await view().getCall(intact.callId))?.status).toBe('Open');
  });

  it('buyer SDK refuses a response whose bytes differ from the signed receipt, keeping the call id for a claim', async () => {
    const tamper: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (!new Headers(init?.headers).has(HDR_PAYMENT_SIGNATURE)) return res;
      const body = (await res.text()).replace('"NEAR"', '"NEO!"');
      return new Response(body, { status: res.status, headers: res.headers });
    };
    const c = buyer('b-mismatch', tamper);
    const err = await c.call(urlOf('s-good')).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(CertoError);
    expect((err as CertoError).code).toBe('RECEIPT_MISMATCH');
    expect((await view().getCall((err as CertoError).callId!))?.status).toBe('Open');
  });

  it('seller refuses to serve a request body other than the one paid for', async () => {
    const path = fx.request;
    const url = urlOf('s-good', path);
    const paidBody = '{"q":"paid"}';
    const first = await fetch(url, { method: 'POST', body: paidBody });
    expect(first.status).toBe(402);
    const req = decodeHeader<PaymentRequired>(first.headers.get(HDR_PAYMENT_REQUIRED)!).accepts[0]!;
    const c = m.client('b-body');
    const pay = await c.pay({
      seller: 's-good', quote_id: req.extra.quoteId, terms_id: req.extra.termsId, amount: req.amount,
      request_hash: requestHash(requestCanon('POST', path, paidBody)),
    });
    const ps: PaymentSignature = { x402Version: 2, accepted: req, payload: { callId: `s-good/${req.extra.quoteId}`, buyer: 'b-body', txHash: pay.txHash } };
    const other = await fetch(url, { method: 'POST', body: '{"q":"other"}', headers: { [HDR_PAYMENT_SIGNATURE]: encodeHeader(ps) } });
    expect(other.status).toBe(402);
    expect(((await other.json()) as { error: string }).error).toBe('request differs from the one paid for');
    const same = await fetch(url, { method: 'POST', body: paidBody, headers: { [HDR_PAYMENT_SIGNATURE]: encodeHeader(ps) } });
    expect(same.status).toBe(200);
  });
});

describe('encoder agreement (contract views = @certo/core) on every golden vector', () => {
  it('build_panel_request', async () => {
    for (const v of vectors.panel_requests) {
      const onChain = await view().buildPanelRequest({
        juror_idx: v.juror_idx, terms_text: v.terms_text, request_canon: v.request_canon, response_body: v.response_body,
        buyer_bps: v.buyer_bps, seller_bps: v.seller_bps,
      });
      const core = buildPanelRequestFor({
        jurorIndex: v.juror_idx, termsText: v.terms_text, requestCanon: v.request_canon, responseBody: v.response_body,
        buyerOfferBps: v.buyer_bps, sellerOfferBps: v.seller_bps,
      });
      expect(JURORS[v.juror_idx]!.model).toBe(v.model);
      expect(onChain, v.name).toBe(core);
      expect(onChain, v.name).toBe(v.body);
    }
  });

  it('receipt_text (calls created on chain under the vectors\' exact account names)', async () => {
    for (const contract of VEC_CONTRACTS) {
      const items = vectors.receipts.items.filter((r) => r.contract === contract);
      const vm = await deployMarket({
        chain, contract, token: 'usdc', owner: 'owner', resolver: 'resolver', wasm: 'res/certo.wasm', jurors: plan.jurors, gatewayKey: plan.gatewayKey,
      });
      for (const it of items) {
        const [seller, quoteId] = it.callId.split('/') as [string, string];
        if (!(await vm.client().getSeller(seller))) {
          await addSeller(vm, { id: seller, bond: BOND, terms: [] });
        }
        const sc = vm.client(seller);
        if (!(await sc.getTerms(seller, it.termsId))) await sc.addTerms({ terms_id: it.termsId, text: 'vector terms', required_fields: [], as_of_field: null, max_age_s: null, panel: true });
        await vm.mint(it.buyer, it.price);
        await vm.client(it.buyer).pay({ seller, quote_id: quoteId, terms_id: it.termsId, request_hash: it.requestHash, amount: it.price });
        const args = { call_id: it.callId, response_hash: it.responseHash, status_code: it.statusCode, served_at_ms: it.servedAtMs };
        const onChain = await vm.client().receiptText(args);
        expect(onChain).toBe(receiptText(it));
        expect(onChain).toBe(it.text);
      }
    }
  });
});

describe('demo fixtures', () => {
  it('fixtures/demo/cases.jsonl is what apps/demo/write-fixtures.ts derives from demo.json (what `make record` records)', () => {
    const lines = readFileSync(repoFile('fixtures/demo/cases.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual(demoCases());
  });

  it('jurors.synthetic.json matches its seed, and the sandbox contract holds the chosen panel keys', async () => {
    const sf = JSON.parse(readFileSync(repoFile('fixtures/jurors.synthetic.json'), 'utf8'));
    expect(sf).toEqual(syntheticJurorsFile(sf.seed));
    const onChain = await view().getJurors();
    expect(onChain.jurors.map((j) => j.pubkey)).toEqual(plan.jurors.map((j) => j.pubkey));
  });
});
