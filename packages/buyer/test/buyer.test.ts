import express from 'express';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ed25519FromLabel, offerCommit, toHex } from '@certo/core';
import { FakeChain } from '@certo/core/testing';
import { protect } from '@certo/seller';
import { CertoClient, CertoError, runCli, simplePolicy, type CallResult } from '../src/index.js';

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
app.post('/cases', express.json(), (req, res) => void res.json({ received: req.body }));

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
    expect(simplePolicy(mk('GET\n/x\n', '{"token":"A"}')).action).toBe('accept');
    expect(simplePolicy(mk('GET\n/x?token=A\n', 'not json')).action).toBe('accept');
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
    expect(JSON.parse(lines.join('\n')).status).toBe('Answered');
    expect(await runCli(['bogus'], deps)).toBe(2);
    expect(await runCli(['call', `${base}/plain`], deps)).toBe(1);
    expect(lines.at(-1)).toMatch(/error \[NOT_PROTECTED\]/);
  });
});
