import express from 'express';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ed25519FromLabel, EVENT_STANDARD, offerCommit, toHex, type Clock } from '@certo/core';
import { FakeChain } from '@certo/core/testing';
import { protect } from '@certo/seller';
import {
  buyerChainFromEnv, CertoClient, CertoError, ConfigError, disputeAndSettle, exampleUrls, FileCallStore, main, NO_PLAYGROUND, runCli,
  simplePolicy, withPlayground, type CallResult,
} from '../src/index.js';

const SELLER = 'cheapfacts.test.near';
const BUYER = 'scout.test.near';
const key = ed25519FromLabel('cheapfacts-receipt');
const chain = new FakeChain();
chain.addSeller(SELLER, toHex(key.publicKey));
chain.addTermsFor(SELLER, 'holders-v1', 'terms');
chain.addSeller('poor.test.near', toHex(key.publicKey), '100000');
chain.addTermsFor('poor.test.near', 'holders-v1', 'terms');
const buyerChain = chain.as(BUYER);

let tamper = false;
const app = express();
// An outer layer that alters the bytes after the seller signed them (a lying proxy).
app.use((_req, res, next) => {
  const end = res.end.bind(res) as (...a: unknown[]) => unknown;
  (res as { end: unknown }).end = (c: unknown, ...rest: unknown[]) =>
    end(tamper && Buffer.isBuffer(c) ? Buffer.from(c.toString().replace('NEAR', 'NEO!')) : c, ...rest);
  next();
});
const mw = protect({ contract: chain, seller: SELLER, termsId: 'holders-v1', price: '400000', receiptKey: key });
app.get('/good', mw, (req, res) => void res.json({ token: req.query.token, as_of: 1 }));
app.get('/wrong', mw, (_req, res) => void res.json({ token: 'NEO', as_of: 1 }));
app.get('/err', mw, (_req, res) => void res.status(503).json({ error: 'down' }));
app.get('/dead', mw, () => { /* never answers */ });
app.get('/plain', (_req, res) => void res.json({ free: true }));
app.get('/poor', protect({ contract: chain, seller: 'poor.test.near', termsId: 'holders-v1', price: '400000', receiptKey: key }), (_q, r) => void r.json({}));
app.get('/badkey', protect({ contract: chain, seller: SELLER, termsId: 'holders-v1', price: '400000', receiptKey: ed25519FromLabel('other') }), (_q, r) => void r.json({}));
app.get('/pricey', protect({ contract: chain, seller: SELLER, termsId: 'holders-v1', price: '1500000', receiptKey: key }), (_q, r) => void r.json({ token: 'X' }));
let panelVerdict: ((callId: string) => unknown) | undefined;
app.post('/cases', express.json(), (req, res) => void res.json(panelVerdict ? panelVerdict(req.body.call_id) : { received: req.body }));

let base = '';
let server: ReturnType<typeof app.listen>;
beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

const client = () => new CertoClient({ chain: buyerChain, deliveryTimeoutMs: 300 });

describe('CertoClient.call', () => {
  it('clean call end to end', async () => {
    const c = client();
    const r = await c.call(`${base}/good?token=NEAR&top=5`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ token: 'NEAR', as_of: 1 });
    expect(r.price).toBe('400000');
    expect(r.requestCanon).toBe('GET\n/good?token=NEAR&top=5\n');
    expect(r.callId.startsWith(`${SELLER}/`)).toBe(true);
    expect((await chain.getCall(r.callId))!.buyer).toBe(BUYER);
    expect(c.calls.get(r.callId)).toBe(r);
    expect(simplePolicy(r)).toMatchObject({ action: 'accept' });
  });

  it('refuses a response whose hash does not match the receipt', async () => {
    tamper = true;
    try {
      const err = await client().call(`${base}/good?token=NEAR`).catch((e) => e);
      expect(err).toBeInstanceOf(CertoError);
      expect(err.code).toBe('RECEIPT_MISMATCH');
      expect(err.callId).toMatch(new RegExp(`^${SELLER}/[0-9a-f]{32}$`));
    } finally {
      tamper = false;
    }
  });

  it('refuses a receipt not signed by the seller key on chain', async () => {
    const err = await client().call(`${base}/badkey`).catch((e) => e);
    expect(err.code).toBe('BAD_RECEIPT_SIG');
  });

  it('refuses before paying: unprotected endpoint, price cap, no capacity, wrong contract', async () => {
    const paysBefore = chain.log.filter((l) => l.method === 'pay').length;
    expect((await client().call(`${base}/plain`).catch((e) => e)).code).toBe('NOT_PROTECTED');
    expect((await client().call(`${base}/good`, { maxPrice: '399999' }).catch((e) => e)).code).toBe('PRICE_TOO_HIGH');
    expect((await client().call(`${base}/poor`).catch((e) => e)).code).toBe('WOULD_NOT_FIT');
    const other = Object.assign(chain.as(BUYER), { contractId: 'evil.near' });
    expect((await new CertoClient({ chain: other }).call(`${base}/good`).catch((e) => e)).code).toBe('WRONG_CONTRACT');
    expect(chain.log.filter((l) => l.method === 'pay').length).toBe(paysBefore);
  });

  it('reports a bounced payment with the contract error code', async () => {
    const bouncing = Object.assign(chain.as(BUYER), {
      pay: async () => ({ txHash: 't', events: [], logs: [], failures: ['Smart contract panicked: E_EXPOSURE'] }),
    });
    const err = await new CertoClient({ chain: bouncing }).call(`${base}/good`).catch((e) => e);
    expect(err.code).toBe('PAY_FAILED');
    expect(err.contractCode).toBe('E_EXPOSURE');
  });

  it('times out on a dead seller and lets the buyer claim non-delivery', async () => {
    const c = client();
    const err = await c.call(`${base}/dead`).catch((e) => e);
    expect(err.code).toBe('TIMEOUT');
    const tx = await c.claimNonDelivery(err.callId);
    expect(tx.events.map((e) => e.event)).toEqual(['dispute_opened']);
    expect((await chain.getCall(err.callId))!.status).toBe('NonDeliveryClaimed');
    expect((await chain.getCall(err.callId))!.dispute!.stake).toBe('20000');
  });
});

describe('disputes and policy', () => {
  it('wrong token → policy disputes at 100% with a sealed offer', async () => {
    const c = client();
    const r = await c.call(`${base}/wrong?token=NEAR&top=5`);
    const d = simplePolicy(r);
    expect(d).toEqual({ action: 'dispute', offerBps: 10000, reason: 'asked for NEAR, got NEO' });
    const rec = await c.dispute(r, { offerBps: 10000 });
    expect(rec.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.commit).toBe(offerCommit(10000, rec.salt));
    const call = (await chain.getCall(r.callId))!;
    expect(call.status).toBe('Disputed');
    expect(call.dispute).toMatchObject({ buyer_commit: rec.commit, response_hash: r.receipt.responseHash, status_code: 200 });
    // second dispute rejected by the contract (modelled as no event)
    await expect(c.dispute(r)).rejects.toThrow(/E_STATUS/);
    // panel submission carries evidence and the reveal
    await chain.answer.call(chain.as(SELLER), r.callId, 0);
    expect((await c.waitForStatus(r.callId, ['Answered'], { pollMs: 1 }))!.status).toBe('Answered');
    const out = (await c.submitToPanel(base, r.callId)) as { received: Record<string, unknown> };
    expect(out.received).toEqual({ call_id: r.callId, buyer_offer_bps: 10000, salt: rec.salt, request_canon: r.requestCanon, response_body: r.body });
  });

  it('signed 503 → policy claims error; claimError sends the receipt fields', async () => {
    const c = client();
    const r = await c.call(`${base}/err?token=NEAR`);
    expect(r.status).toBe(503);
    expect(simplePolicy(r).action).toBe('claim_error');
    const tx = await c.claimError(r);
    expect(tx.events[0]!.data).toMatchObject({ tier: 'rule', reason: 'seller_error' });
    expect(chain.log.at(-1)!.args).toEqual({ call_id: r.callId, response_hash: r.receipt.responseHash, status_code: 503, served_at_ms: r.receipt.servedAtMs, sig: r.receipt.sig });
  });

  it('policy edge cases', () => {
    const mk = (canon: string, body: string, status = 200) => ({ requestCanon: canon, body, status }) as CallResult;
    expect(simplePolicy(mk('GET\n/x\n', '{"token":"A"}')).action).toBe('no_opinion');
    expect(simplePolicy(mk('GET\n/x?token=A\n', 'not json')).action).toBe('no_opinion');
    expect(simplePolicy(mk('GET\n/x?token=A\n', '{}')).action).toBe('dispute');
    expect(simplePolicy(mk('GET\n/x?token=A\n', '{"token":"a"}')).action).toBe('dispute');
    expect(simplePolicy(mk('GET\n/x?token=A\n', '{"token":"A"}', 500)).action).toBe('claim_error');
  });
});

describe('CLI', () => {
  it('call --auto disputes a wrong token; state survives for a later command', async () => {
    const lines: string[] = [];
    const stateDir = mkdtempSync(join(tmpdir(), 'mg-cli-'));
    const deps = { chain: buyerChain, stateDir, out: (l: string) => lines.push(l) };
    expect(await runCli(['call', `${base}/wrong?token=NEAR&top=5`, '--auto'], deps)).toBe(0);
    expect(lines.join('\n')).toMatch(/paid 0\.400000 call .* receipt verified/);
    expect(lines.join('\n')).toMatch(/policy: dispute \(asked for NEAR, got NEO\)/);
    expect(lines.join('\n')).toMatch(/dispute opened tx .* stake 0\.020000, sealed offer 100%/);
    const callId = /call (\S+) tx/.exec(lines[0]!)![1]!;
    await chain.answer.call(chain.as(SELLER), callId, 0);
    lines.length = 0;
    expect(await runCli(['panel', callId, '--panel', base], deps)).toBe(0);
    expect(JSON.parse(lines[0]!).received.call_id).toBe(callId);
    lines.length = 0;
    expect(await runCli(['status', callId], deps)).toBe(0);
    expect(lines[0]).toMatch(/^in_dispute: Answered: waiting for the panel verdict/);
    expect(JSON.parse(lines.slice(1).join('\n')).status).toBe('Answered');
    expect(await runCli(['bogus'], deps)).toBe(2);
    expect(await runCli(['call', `${base}/plain`], deps)).toBe(1);
    expect(lines.at(-1)).toMatch(/error \[NOT_PROTECTED\]/);
  });
});

const resolved = (data: Record<string, unknown>) => ({ standard: EVENT_STANDARD, version: '1.0.0', event: 'dispute_resolved', data });
/** A clock `ahead` ms after the fake chain's time; sleeping advances it. */
const fakeClock = (ahead = 0): Clock => { let t = chain.now + ahead; return { now: () => t, sleep: async (ms) => { t += ms; } }; };

describe('price cap and amounts', () => {
  it('refuses above 1.00 USDC by default, and takes caps in USDC or base units', async () => {
    const before = chain.log.filter((l) => l.method === 'pay').length;
    const err = await client().call(`${base}/pricey`).catch((e) => e);
    expect(err.code).toBe('PRICE_TOO_HIGH');
    expect(err.message).toBe('price 1.500000 USDC is above the cap 1.000000 USDC (CERTO_MAX_PRICE or max_price; "0.50" or "1 USDC" is USDC, a bare integer is base units)');
    expect((await client().call(`${base}/good`, { maxPrice: '0.39' }).catch((e) => e)).code).toBe('PRICE_TOO_HIGH');
    expect(chain.log.filter((l) => l.method === 'pay').length).toBe(before);
    expect((await client().call(`${base}/pricey`, { maxPrice: '1.5 USDC' })).price).toBe('1500000');
    expect((await client().call(`${base}/good`, { maxPrice: '400000' })).price).toBe('400000');
  });

  it('CERTO_MAX_PRICE sets the default cap', async () => {
    process.env.CERTO_MAX_PRICE = '2.00';
    try {
      expect(client().maxPrice).toBe('2000000');
    } finally {
      delete process.env.CERTO_MAX_PRICE;
    }
    expect(client().maxPrice).toBe('1000000');
  });

  it('quote joins the 402 with the seller record and terms, without paying', async () => {
    const before = chain.log.length;
    const q = await client().quote(`${base}/pricey`);
    expect(q).toMatchObject({
      seller: SELLER, price: '1500000', maxPrice: '1000000', withinCap: false, feeBps: 100, windowMs: 120000, disputeStake: '75000',
      termsId: 'holders-v1', terms: { text: 'terms', panel: true }, wouldFit: true,
    });
    expect(q.problems).toEqual([expect.stringMatching(/^PRICE_TOO_HIGH: price 1.500000 USDC/)]);
    expect(q.seller_record).toMatchObject({ lifetime_losses: 0 });
    expect(chain.log.length).toBe(before);
    expect((await client().quote(`${base}/plain`).catch((e) => e)).code).toBe('NOT_PROTECTED');
  });
});

describe('persistence and follow-through', () => {
  it('restart then dispute: a new client on the same store opens, and the panel verdict comes back as the outcome', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'certo-store-'));
    const r = await new CertoClient({ chain: buyerChain, store: new FileCallStore(dir) }).call(`${base}/wrong?token=NEAR`);
    // "restart": a fresh client with nothing in memory
    const c2 = new CertoClient({ chain: buyerChain, store: new FileCallStore(dir), clock: fakeClock(1000) });
    const opened = await disputeAndSettle(c2, r.callId, { maxWaitMs: 0 });
    expect(opened.opened).toMatchObject({ kind: 'content', stake: '20000', sealedOfferPct: 100 });
    expect(opened.progress).toMatchObject({ state: 'waiting', status: 'Disputed' });
    await chain.answer.call(chain.as(SELLER), r.callId, 0);
    panelVerdict = (id) => {
      chain.calls.delete(id);
      return { submitted: true, txHash: 'tx-resolve', mode: 'replay', synthetic: true,
        events: [resolved({ call_id: id, tier: 'panel', winner: 'buyer', votes: ['buyer', 'buyer', 'buyer'], refund: '400000', to_buyer: '420000' })] };
    };
    try {
      // another restart: the salt comes from the store
      const c3 = new CertoClient({ chain: buyerChain, store: new FileCallStore(dir), clock: fakeClock(2000) });
      const done = await disputeAndSettle(c3, r.callId, { panelUrl: base });
      expect(done.opened).toBeUndefined();
      expect(done.progress).toMatchObject({ state: 'final', outcome: {
        result: 'refunded', refund: '400000', stakeBack: '20000', stakeLost: '0', tier: 'panel', winner: 'buyer', tx: 'tx-resolve',
        panel: { mode: 'replay', synthetic: true } } });
      const st = await new CertoClient({ chain: buyerChain, store: new FileCallStore(dir) }).status(r.callId);
      expect(st.state).toBe('refunded');
      expect(st.detail).toBe('refunded: refund 0.400000 USDC, stake back 0.020000, stake lost 0.000000; panel verdict for the buyer (buyer/buyer/buyer)');
    } finally {
      panelVerdict = undefined;
    }
  });

  it('the salt is stored before the dispute transaction is sent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'certo-store-'));
    const store = new FileCallStore(dir);
    let seen: unknown;
    const spy = Object.assign(chain.as(BUYER), { disputeContent: async (a: { call_id: string }) => { seen = store.load(a.call_id)?.dispute; throw new Error('RPC down'); } });
    const c = new CertoClient({ chain: spy, store });
    const r = await c.call(`${base}/wrong?token=NEAR`);
    await expect(c.dispute(r)).rejects.toThrow('RPC down');
    expect(seen).toMatchObject({ kind: 'content', offerBps: 10000, salt: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(store.load(r.callId)!.dispute).toBeUndefined(); // rolled back: no dispute was opened
  });

  it('non-delivery: waits out the seller, calls resolve_default, returns the refund', async () => {
    const calls: string[] = [];
    const ch = Object.assign(chain.as(BUYER), {
      resolveDefault: async (a: { call_id: string }) => {
        calls.push(a.call_id);
        chain.calls.delete(a.call_id);
        return { txHash: 'tx-default', logs: [], failures: [], events: [resolved({ call_id: a.call_id, tier: 'rule', reason: 'seller_no_answer', refund: '400000', ruling_fee: '20000', stake_returned: '20000' })] };
      },
    });
    const c = new CertoClient({ chain: ch, deliveryTimeoutMs: 300, clock: fakeClock() });
    const err = await c.call(`${base}/dead`).catch((e) => e);
    const out = await disputeAndSettle(c, err.callId, { kind: 'non_delivery', pollMs: 1000 });
    expect(out.opened).toMatchObject({ kind: 'non_delivery', stake: '20000' });
    expect(out.progress).toMatchObject({ state: 'final', outcome: { result: 'refunded', refund: '400000', stakeBack: '20000', tier: 'rule', reason: 'seller_no_answer', tx: 'tx-default' } });
    expect(calls).toEqual([err.callId]); // only after the 5 s answer deadline (fake clock advanced by polling)
    expect((await c.status(err.callId)).state).toBe('refunded');
  });

  it('a cured non-delivery claim ends as "cured" with the stake back', async () => {
    const c = new CertoClient({ chain: buyerChain, clock: fakeClock() });
    const r = await c.call(`${base}/good?token=CURE`);
    const opened = await disputeAndSettle(c, r.callId, { kind: 'non_delivery', maxWaitMs: 0 });
    expect(opened.progress).toMatchObject({ state: 'waiting', status: 'NonDeliveryClaimed' });
    const call = chain.calls.get(r.callId)!;
    call.status = 'Open'; call.dispute = null; // what `cure` does
    expect((await disputeAndSettle(c, r.callId)).progress).toMatchObject({ state: 'final', outcome: { result: 'cured', stakeBack: '20000', refund: '0' } });
  });

  it('status tells open, released and never paid apart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'certo-store-'));
    const c = new CertoClient({ chain: buyerChain, store: new FileCallStore(dir), clock: fakeClock() });
    const r = await c.call(`${base}/good?token=S`);
    expect(await c.status(r.callId)).toMatchObject({ state: 'open', detail: expect.stringMatching(/refund window open until .* \(120 s left\)/) });
    chain.calls.delete(r.callId); // swept by `release`
    expect(await c.status(r.callId)).toMatchObject({ state: 'released', detail: expect.stringMatching(/seller kept the payment/) });
    expect(await c.status(`${SELLER}/${'0'.repeat(32)}`)).toMatchObject({ state: 'unknown', detail: expect.stringMatching(/never paid/) });
  });
});

describe('CLI input checks', () => {
  it('rejects bad numbers before touching the chain', async () => {
    const lines: string[] = [];
    const deps = { chain: buyerChain, stateDir: mkdtempSync(join(tmpdir(), 'mg-cli-')), out: (l: string) => lines.push(l) };
    const before = chain.log.length;
    expect(await runCli(['dispute', 'x/1', '--offer', 'abc'], deps)).toBe(2);
    expect(lines.at(-1)).toBe('error: --offer must be a whole number from 0 to 100, got "abc"');
    expect(await runCli(['dispute', 'x/1', '--offer', '150'], deps)).toBe(2);
    expect(await runCli(['dispute', 'x/1', '--kind', 'bogus'], deps)).toBe(2);
    expect(await runCli(['call', `${base}/good`, '--max-price', 'lots'], deps)).toBe(2);
    expect(lines.at(-1)).toMatch(/^error: --max-price: invalid amount "lots"/);
    expect(await runCli(['call'], deps)).toBe(2);
    expect(lines.at(-1)).toBe('error: call needs a URL');
    expect(await runCli(['call', `${base}/pricey`], deps)).toBe(1);
    expect(lines.at(-1)).toMatch(/^error \[PRICE_TOO_HIGH\]: price 1.500000 USDC .*\(price above your cap; nothing was paid/);
    expect(chain.log.length).toBe(before);
  });

  it('quote prints USDC amounts and the terms', async () => {
    const lines: string[] = [];
    expect(await runCli(['quote', `${base}/good`], { chain: buyerChain, stateDir: mkdtempSync(join(tmpdir(), 'mg-cli-')), out: (l) => lines.push(l) })).toBe(0);
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ price_usdc: '0.400000', payable: true, fee_bps: 100, refund_window_s: 120, dispute_stake_usdc: '0.020000', terms_id: 'holders-v1' });
  });
});

describe('configuration', () => {
  it('--playground: reads $CERTO_HOME/playground.env, values in the environment win; missing file → one clear line', () => {
    const home = mkdtempSync(join(tmpdir(), 'certo-home-'));
    expect(() => withPlayground({ CERTO_HOME: home })).toThrow(new ConfigError(NO_PLAYGROUND));
    expect(NO_PLAYGROUND).toBe('no playground running: start one with `make playground` in the certo repo');
    writeFileSync(join(home, 'playground.env'), '# written by make playground\nNEAR_NETWORK=sandbox\nCERTO_CONTRACT=certo.test\nBUYER_ACCOUNT="scout"\nCERTO_EXAMPLE_URLS=cheapfacts=http://127.0.0.1:1/v1/holders?token=NEAR,chainfacts=http://127.0.0.1:2/x\n');
    const env = withPlayground({ CERTO_HOME: home, BUYER_ACCOUNT: 'mine' });
    expect(env).toMatchObject({ NEAR_NETWORK: 'sandbox', CERTO_CONTRACT: 'certo.test', BUYER_ACCOUNT: 'mine' });
    expect(exampleUrls(env)).toEqual([{ name: 'cheapfacts', url: 'http://127.0.0.1:1/v1/holders?token=NEAR' }, { name: 'chainfacts', url: 'http://127.0.0.1:2/x' }]);
  });

  it('missing env names what to set', () => {
    expect(() => buyerChainFromEnv({ CERTO_CONTRACT: 'c' })).toThrow(
      'certo: set CERTO_TOKEN, BUYER_ACCOUNT, BUYER_PRIVATE_KEY (and NEAR_RPC_URL, NEAR_NETWORK), or add --playground to use a sandbox started with `make playground`');
  });

  it('main() prints one line and exits 2 without a stack trace', async () => {
    const err = console.error;
    const lines: unknown[] = [];
    console.error = (...a: unknown[]) => void lines.push(a.join(' '));
    try {
      expect(await main(['status', 'x/1'], {})).toBe(2);
      expect(await main(['--playground', 'status', 'x/1'], { CERTO_HOME: mkdtempSync(join(tmpdir(), 'certo-home-')) })).toBe(2);
    } finally {
      console.error = err;
    }
    expect(lines).toEqual([expect.stringMatching(/^certo: set CERTO_CONTRACT, CERTO_TOKEN, BUYER_ACCOUNT, BUYER_PRIVATE_KEY/), NO_PLAYGROUND]);
  });
});
