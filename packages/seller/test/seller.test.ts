import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodeHeader, ed25519FromLabel, encodeHeader, HDR_PAYMENT_REQUIRED, HDR_PAYMENT_RESPONSE, HDR_PAYMENT_SIGNATURE, PAYMENT_SCHEME,
  receiptText, REPO_URL, requestCanon, sha256Hex, toHex, verifyBase64, type PaymentRequired, type PaymentResponse, type PaymentSignature,
} from '@certo/core';
import { FakeChain } from '@certo/core/testing';
import { createAnswerBot, MAX_SIGNED_BODY, protect, SCHEME_HINT } from '../src/index.js';

const SELLER = 'chainfacts.test.near';
const BUYER = 'scout.test.near';
const key = ed25519FromLabel('seller-receipt-key');
const chain = new FakeChain();
chain.addSeller(SELLER, toHex(key.publicKey));
chain.addTermsFor(SELLER, 'holders-v1', 'terms');
const buyerChain = chain.as(BUYER);
let mode: 'good' | 'throw' | '503' | 'chunked' | 'big' = 'good';
let calls = 0;

const mw = protect({ contract: chain, seller: SELLER, termsId: 'holders-v1', price: '400000', receiptKey: key, clock: { now: () => 1794300001000, sleep: async () => {} } });
const app = express();
app.all('/v1/holders', mw, (req, res) => {
  calls++;
  if (mode === 'throw') throw new Error('boom');
  if (mode === '503') return void res.status(503).json({ error: 'upstream unavailable' });
  if (mode === 'big') return void res.type('text/plain').send('x'.repeat(MAX_SIGNED_BODY + 1));
  if (mode === 'chunked') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.write('part1,'); res.end('part2'); return; }
  res.json({ token: String(req.query.token), body: req.body });
});
let base = '';
let server: ReturnType<typeof app.listen>;
beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

async function quote(path: string, init: RequestInit = {}) {
  const r = await fetch(base + path, init);
  expect(r.status).toBe(402);
  const pr = decodeHeader<PaymentRequired>(r.headers.get(HDR_PAYMENT_REQUIRED)!);
  return pr.accepts[0]!;
}

async function payAndRetry(path: string, init: RequestInit = {}, paidCanon?: string) {
  const req = await quote(path, init);
  const canon = paidCanon ?? requestCanon(init.method ?? 'GET', path, (init.body as string) ?? '');
  const tx = await buyerChain.pay({ seller: req.extra.seller, quote_id: req.extra.quoteId, terms_id: req.extra.termsId, request_hash: sha256Hex(canon), amount: req.amount });
  const callId = `${req.extra.seller}/${req.extra.quoteId}`;
  const ps: PaymentSignature = { x402Version: 2, accepted: req, payload: { callId, buyer: BUYER, txHash: tx.txHash } };
  const r = await fetch(base + path, { ...init, headers: { ...(init.headers as object), [HDR_PAYMENT_SIGNATURE]: encodeHeader(ps) } });
  return { r, callId, req, ps, canon };
}

function checkReceipt(pr: PaymentResponse, bytes: Buffer, status: number, canon: string) {
  const rc = pr.receipt;
  expect(rc.responseHash).toBe(sha256Hex(bytes));
  expect(rc.statusCode).toBe(status);
  const text = receiptText({ contract: chain.contractId, callId: rc.callId, buyer: BUYER, price: '400000', termsId: 'holders-v1', requestHash: sha256Hex(canon), responseHash: rc.responseHash, statusCode: rc.statusCode, servedAtMs: rc.servedAtMs });
  expect(verifyBase64(text, rc.sig, key.publicKey)).toBe(true);
}

describe('protect()', () => {
  it('answers 402 with an x402-v2-shaped PAYMENT-REQUIRED', async () => {
    const r = await fetch(base + '/v1/holders?token=NEAR&top=5');
    expect(r.status).toBe(402);
    const pr = decodeHeader<PaymentRequired>(r.headers.get(HDR_PAYMENT_REQUIRED)!);
    expect(pr.x402Version).toBe(2);
    expect(pr.resource.url).toMatch(/\/v1\/holders\?token=NEAR&top=5$/);
    expect(pr.accepts[0]).toMatchObject({
      scheme: PAYMENT_SCHEME, network: 'near:sandbox', amount: '400000', asset: chain.tokenId, payTo: chain.contractId, maxTimeoutSeconds: 60,
      extra: { seller: SELLER, termsId: 'holders-v1', windowMs: 120000, feeBps: 100 },
    });
    expect(pr.accepts[0]!.extra.quoteId).toMatch(/^[0-9a-f]{32}$/);
    expect(pr.accepts[0]!.extra.docs).toBe(REPO_URL);
    expect(pr.resource.description).toBe(SCHEME_HINT);
    expect(SCHEME_HINT).toMatch(/certo-bonded.*npx certo call <url>.*certo-mcp/);
    expect(await r.json()).toEqual(pr);
  });

  it('402 → pay → retry → 200 with a receipt over the exact bytes', async () => {
    mode = 'good';
    const { r, callId, canon } = await payAndRetry('/v1/holders?token=NEAR&top=5');
    expect(r.status).toBe(200);
    const bytes = Buffer.from(await r.arrayBuffer());
    expect(JSON.parse(bytes.toString())).toEqual({ token: 'NEAR', body: '' });
    const pr = decodeHeader<PaymentResponse>(r.headers.get(HDR_PAYMENT_RESPONSE)!);
    expect(pr).toMatchObject({ success: true, network: 'near:sandbox', payer: BUYER });
    expect(pr.receipt.callId).toBe(callId);
    expect(r.headers.get('content-encoding')).toBe('identity');
    checkReceipt(pr, bytes, 200, canon);
  });

  it('serves a second request on the same call from cache without re-running the handler', async () => {
    mode = 'good';
    const { r, ps } = await payAndRetry('/v1/holders?token=NEAR&top=5');
    const first = Buffer.from(await r.arrayBuffer());
    const before = calls;
    const r2 = await fetch(base + '/v1/holders?token=NEAR&top=5', { headers: { [HDR_PAYMENT_SIGNATURE]: encodeHeader(ps) } });
    expect(r2.status).toBe(200);
    expect(Buffer.from(await r2.arrayBuffer())).toEqual(first);
    expect(r2.headers.get(HDR_PAYMENT_RESPONSE)).toBe(r.headers.get(HDR_PAYMENT_RESPONSE));
    expect(calls).toBe(before);
  });

  it('refuses a request whose path or body differs from what was paid for', async () => {
    mode = 'good';
    const before = calls;
    const { r } = await payAndRetry('/v1/holders?token=NEO&top=5', {}, requestCanon('GET', '/v1/holders?token=NEAR&top=5'));
    expect(r.status).toBe(402);
    expect((await r.json()).error).toMatch(/differs/);
    const post = await payAndRetry('/v1/holders?token=NEAR', { method: 'POST', body: '{"a":2}' }, requestCanon('POST', '/v1/holders?token=NEAR', '{"a":1}'));
    expect(post.r.status).toBe(402);
    expect(calls).toBe(before);
  });

  it('accepts a POST body that matches and hands the raw body to the handler', async () => {
    mode = 'good';
    const { r } = await payAndRetry('/v1/holders?token=NEAR', { method: 'POST', body: '{"a":1}' });
    expect(r.status).toBe(200);
    expect((await r.json()).body).toBe('{"a":1}');
  });

  it('refuses unpaid, foreign, under-paid and non-open calls', async () => {
    const req = await quote('/v1/holders?token=NEAR&top=5');
    const send = (ps: unknown) => fetch(base + '/v1/holders?token=NEAR&top=5', { headers: { [HDR_PAYMENT_SIGNATURE]: encodeHeader(ps) } });
    // never paid
    let r = await send({ x402Version: 2, accepted: req, payload: { callId: `${SELLER}/${req.extra.quoteId}`, buyer: BUYER, txHash: 'x' } });
    expect((await r.json()).error).toMatch(/not found/);
    // call id for another seller
    r = await send({ x402Version: 2, accepted: req, payload: { callId: `other.near/${req.extra.quoteId}`, buyer: BUYER, txHash: 'x' } });
    expect(r.status).toBe(402);
    // garbage header
    r = await fetch(base + '/v1/holders?token=NEAR&top=5', { headers: { [HDR_PAYMENT_SIGNATURE]: 'not-base64-json' } });
    expect(r.status).toBe(402);
    // under-paid
    const canon = requestCanon('GET', '/v1/holders?token=NEAR&top=5');
    await buyerChain.pay({ seller: SELLER, quote_id: req.extra.quoteId, terms_id: 'holders-v1', request_hash: sha256Hex(canon), amount: '100000' });
    r = await send({ x402Version: 2, accepted: req, payload: { callId: `${SELLER}/${req.extra.quoteId}`, buyer: BUYER, txHash: 'x' } });
    expect((await r.json()).error).toMatch(/less than/);
    // disputed before being served
    const q2 = await quote('/v1/holders?token=NEAR&top=5');
    await buyerChain.pay({ seller: SELLER, quote_id: q2.extra.quoteId, terms_id: 'holders-v1', request_hash: sha256Hex(canon), amount: '400000' });
    await buyerChain.disputeNonDelivery({ call_id: `${SELLER}/${q2.extra.quoteId}`, stake: '20000' });
    r = await send({ x402Version: 2, accepted: q2, payload: { callId: `${SELLER}/${q2.extra.quoteId}`, buyer: BUYER, txHash: 'x' } });
    expect((await r.json()).error).toMatch(/NonDeliveryClaimed/);
  });

  it('signs a receipt for a 503 and for a thrown handler error', async () => {
    mode = '503';
    let x = await payAndRetry('/v1/holders?token=NEAR&top=5');
    expect(x.r.status).toBe(503);
    let bytes = Buffer.from(await x.r.arrayBuffer());
    checkReceipt(decodeHeader<PaymentResponse>(x.r.headers.get(HDR_PAYMENT_RESPONSE)!), bytes, 503, x.canon);

    mode = 'throw';
    x = await payAndRetry('/v1/holders?token=NEAR&top=5');
    expect(x.r.status).toBe(500);
    bytes = Buffer.from(await x.r.arrayBuffer());
    checkReceipt(decodeHeader<PaymentResponse>(x.r.headers.get(HDR_PAYMENT_RESPONSE)!), bytes, 500, x.canon);
  });

  it('handles writeHead + write + end', async () => {
    mode = 'chunked';
    const x = await payAndRetry('/v1/holders?token=NEAR&top=5');
    expect(x.r.status).toBe(200);
    const bytes = Buffer.from(await x.r.arrayBuffer());
    expect(bytes.toString()).toBe('part1,part2');
    expect(x.r.headers.get('content-type')).toBe('text/plain');
    checkReceipt(decodeHeader<PaymentResponse>(x.r.headers.get(HDR_PAYMENT_RESPONSE)!), bytes, 200, x.canon);
  });
});

describe('answer bot', () => {
  it('answers content disputes with 0% and cures non-delivery claims', async () => {
    mode = 'good';
    const a = await payAndRetry('/v1/holders?token=NEAR&top=5');
    await a.r.arrayBuffer();
    const b = await payAndRetry('/v1/holders?token=NEAR&top=1');
    const bBytes = Buffer.from(await b.r.arrayBuffer());
    const rc = decodeHeader<PaymentResponse>(a.r.headers.get(HDR_PAYMENT_RESPONSE)!).receipt;
    await buyerChain.disputeContent({ call_id: a.callId, stake: '20000', offer_commit: 'c', response_hash: rc.responseHash, status_code: 200, served_at_ms: rc.servedAtMs, sig: rc.sig });
    await buyerChain.disputeNonDelivery({ call_id: b.callId, stake: '20000' });
    const actions: string[] = [];
    const bot = createAnswerBot({ chain, store: mw.store, offerBps: 0, onAction: (x) => actions.push(`${x.action}:${x.callId}:${x.error ?? 'ok'}`) });
    await bot.tick();
    await bot.tick(); // idempotent
    expect(actions.sort()).toEqual([`answer:${a.callId}:ok`, `cure:${b.callId}:ok`].sort());
    expect((await chain.getCall(a.callId))!.status).toBe('Answered');
    expect((await chain.getCall(a.callId))!.dispute!.seller_offer_bps).toBe(0);
    expect((await chain.getCall(b.callId))!.status).toBe('Open');
    const cure = chain.log.find((l) => l.method === 'cure')!.args as { response_body: string; response_hash: string; sig: string };
    expect(cure.response_body).toBe(bBytes.toString());
    expect(cure.response_hash).toBe(sha256Hex(bBytes));
    expect(cure.sig).toBe(decodeHeader<PaymentResponse>(b.r.headers.get(HDR_PAYMENT_RESPONSE)!).receipt.sig);
  });
});

describe('size cap and bot retries', () => {
  it('refuses to sign a body larger than the contract can judge: signed 500 instead', async () => {
    mode = 'big';
    const err = console.error;
    const logged: string[] = [];
    console.error = (m: string) => void logged.push(m);
    try {
      const a = await payAndRetry('/v1/holders?token=BIG');
      const bytes = Buffer.from(await a.r.arrayBuffer());
      expect(a.r.status).toBe(500);
      expect(JSON.parse(bytes.toString())).toEqual({ error: `response too large to bond: ${MAX_SIGNED_BODY + 1} bytes > ${MAX_SIGNED_BODY}` });
      checkReceipt(decodeHeader<PaymentResponse>(a.r.headers.get(HDR_PAYMENT_RESPONSE)!), bytes, 500, a.canon);
      expect(logged.join('\n')).toMatch(/exceeds 6144 bytes/);
    } finally {
      console.error = err;
      mode = 'good';
    }
  });

  it('a failed answer is retried on the next tick, and counted once it succeeds', async () => {
    const a = await payAndRetry('/v1/holders?token=RETRY');
    await a.r.arrayBuffer();
    const rc = decodeHeader<PaymentResponse>(a.r.headers.get(HDR_PAYMENT_RESPONSE)!).receipt;
    await buyerChain.disputeContent({ call_id: a.callId, stake: '20000', offer_commit: 'c', response_hash: rc.responseHash, status_code: 200, served_at_ms: rc.servedAtMs, sig: rc.sig });
    let fail = 1;
    const flaky = { getCall: (id: string) => chain.getCall(id), cure: chain.cure.bind(chain),
      answer: async (id: string, bps: number) => { if (fail-- > 0) throw new Error('RPC timeout'); return chain.answer(id, bps); } };
    const store = new Map([[a.callId, mw.store.get(a.callId)!]]);
    const actions: string[] = [];
    const bot = createAnswerBot({ chain: flaky, store, onAction: (x) => actions.push(`${x.action}:${x.error ?? 'ok'}`) });
    await bot.tick();
    expect((await chain.getCall(a.callId))!.status).toBe('Disputed');
    await bot.tick();
    await bot.tick();
    expect(actions).toEqual(['answer:RPC timeout', 'answer:ok']);
    expect((await chain.getCall(a.callId))!.status).toBe('Answered');
  });
});
