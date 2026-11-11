import express from 'express';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildPanelRequestFor, ed25519Sign, fromBase64, JURORS, makeSyntheticBallot, nearaiSignatureText, newSalt, offerCommit,
  sha256Hex, syntheticChatResponse, syntheticJurorKey, toHex, verifyNearAiBallot, verifyRecording, type CallView, type PanelRecording,
} from '@makegood/core';
import {
  createPanelApp, jurorsFromEnv, LiveJurors, PanelMissError, PanelService, RecordingJurors, ReplayJurors, saveRecording,
  type CaseRequest, type PanelChain,
} from '../src/index.js';

const TERMS = 'Returns the top N holders of the token named in the request. Refund: 100 percent for a wrong token.';
const REQ = 'GET\n/v1/holders?token=NEAR&top=5\n';
const RESP = '{"token":"NEO","as_of":1794300000,"holders":[]}';
const instantClock = { now: () => 1794300000000, sleep: async () => {} };

function mockChain(opts: { sellerBps?: number; status?: CallView['status']; buyerBps?: number; salt?: string } = {}) {
  const salt = opts.salt ?? newSalt();
  const resolved: unknown[] = [];
  const call: CallView = {
    buyer: 'scout.test.near', seller: 'cheapfacts.test.near', terms_id: 'holders-v1', price: '400000', fee: '4000', reserve: '420000',
    request_hash: sha256Hex(REQ), paid_at_ms: 0, expires_at_ms: 120000, status: opts.status ?? 'Answered',
    dispute: {
      opened_at_ms: 1, stake: '20000', buyer_commit: offerCommit(opts.buyerBps ?? 10000, salt), response_hash: sha256Hex(RESP),
      status_code: 200, served_at_ms: 1, seller_offer_bps: opts.sellerBps ?? 0, answered_at_ms: 2,
    },
  };
  const chain: PanelChain = {
    getCall: async (id) => (id === 'cheapfacts.test.near/aa' ? call : null),
    getTerms: async () => ({ text: TERMS, required_fields: [], as_of_field: null, max_age_s: null, panel: true }),
    getJurors: async () => ({
      jurors: JURORS.map((j) => ({ model_id: j.model, pubkey: toHex(syntheticJurorKey(j.index).publicKey), attestation_sha256: '00'.repeat(32) })),
      gateway_key: null, epoch: 1,
    }),
    // stands in for the contract view; the service cross-checks it against core
    buildPanelRequest: async (a) => buildPanelRequestFor({
      jurorIndex: a.juror_idx, termsText: a.terms_text, requestCanon: a.request_canon, responseBody: a.response_body,
      buyerOfferBps: a.buyer_bps, sellerOfferBps: a.seller_bps,
    }),
    resolve: async (a) => { resolved.push(a); return { txHash: 'tx-resolve', events: [], logs: [], failures: [] }; },
  };
  const caseReq: CaseRequest = { call_id: 'cheapfacts.test.near/aa', buyer_offer_bps: opts.buyerBps ?? 10000, salt, request_canon: REQ, response_body: RESP };
  return { chain, resolved, caseReq };
}

const bodies = (sellerBps = 0, buyerBps = 10000) => JURORS.map((j) => buildPanelRequestFor({
  jurorIndex: j.index, termsText: TERMS, requestCanon: REQ, responseBody: RESP, buyerOfferBps: buyerBps, sellerOfferBps: sellerBps,
}));

async function fixtureDir(contents: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mg-panel-'));
  const b = bodies();
  for (const j of JURORS) {
    await saveRecording(dir, makeSyntheticBallot({ jurorIndex: j.index, model: j.model, requestBody: b[j.index]!, responseContent: contents[j.index]! }));
  }
  return dir;
}

describe('replay mode', () => {
  it('hit: three recorded ballots → buyer majority → resolve submitted', async () => {
    const { chain, resolved, caseReq } = mockChain();
    const dir = await fixtureDir(['X', 'Y', '<think>wrong token</think> X']); // all three favour the buyer
    const out = await new PanelService({ chain, jurors: new ReplayJurors(dir) }).handleCase(caseReq);
    expect(out).toMatchObject({ tier: 'panel', mode: 'replay', votes: ['X', 'Y', 'X'], sides: ['buyer', 'buyer', 'buyer'], winner: 'buyer', synthetic: true, submitted: true, txHash: 'tx-resolve' });
    expect(out.request_sha256s).toEqual(bodies().map((b) => sha256Hex(b)));
    const args = resolved[0] as { ballots: Array<{ response_body: string; signature: string; kind: string }>; salt: string; buyer_offer_bps: number };
    expect(args.salt).toBe(caseReq.salt);
    expect(args.ballots).toHaveLength(3);
    args.ballots.forEach((b, i) => {
      expect(b.kind).toBe('provider_tee');
      expect(fromBase64(b.signature)).toHaveLength(64);
      const text = nearaiSignatureText('provider_tee', JURORS[i]!.model, sha256Hex(bodies()[i]!), sha256Hex(b.response_body));
      expect(verifyNearAiBallot({ model: JURORS[i]!.model, requestBody: bodies()[i]!, responseBody: b.response_body, signature: { text, signature: toHex(fromBase64(b.signature)), signing_address: toHex(syntheticJurorKey(i).publicKey), signing_algo: 'ed25519', signature_kind: 'provider_tee' } }).ok).toBe(true);
    });
  });

  it('miss: clear message naming the body hash; HTTP 424 from /cases', async () => {
    const { chain, caseReq } = mockChain();
    const dir = mkdtempSync(join(tmpdir(), 'mg-empty-'));
    const svc = new PanelService({ chain, jurors: new ReplayJurors(dir) });
    const err = await svc.handleCase(caseReq).catch((e) => e);
    expect(err).toBeInstanceOf(PanelMissError);
    expect(err.message).toMatch(/^no recording for this case \(sha256 [0-9a-f]{64}\); set NEARAI_API_KEY to ask the live panel$/);
    const app = createPanelApp(svc);
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    try {
      const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/cases`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(caseReq) });
      expect(r.status).toBe(424);
      expect((await r.json()).error).toMatch(/no recording for this case/);
    } finally { server.close(); }
  });

  it('seller majority, and no majority is not submitted', async () => {
    let m = mockChain();
    let out = await new PanelService({ chain: m.chain, jurors: new ReplayJurors(await fixtureDir(['Y', 'X', 'Y'])) }).handleCase(m.caseReq);
    expect(out).toMatchObject({ winner: 'seller', submitted: true });
    m = mockChain();
    out = await new PanelService({ chain: m.chain, jurors: new ReplayJurors(await fixtureDir(['X', 'maybe', ''])) }).handleCase(m.caseReq);
    expect(out).toMatchObject({ votes: ['X', 'abstain', 'abstain'], winner: null, submitted: false });
    expect(m.resolved).toHaveLength(0);
  });

  it('rejects a ballot that does not verify under the on-chain juror key', async () => {
    const { chain, caseReq } = mockChain();
    const dir = await fixtureDir(['X', 'Y', 'X']);
    // re-sign juror 0's file with juror 1's key
    const b = bodies()[0]!;
    const bad = makeSyntheticBallot({ jurorIndex: 1, model: JURORS[0]!.model, requestBody: b, responseContent: 'X' });
    await saveRecording(dir, bad);
    await expect(new PanelService({ chain, jurors: new ReplayJurors(dir) }).handleCase(caseReq)).rejects.toThrow(/expected juror key/);
  });
});

describe('case validation', () => {
  const svc = (o: Parameters<typeof mockChain>[0] = {}) => { const m = mockChain(o); return { m, s: new PanelService({ chain: m.chain, jurors: new ReplayJurors('/nonexistent') }) }; };
  it('wrong reveal, wrong evidence, wrong state, unknown call, bad body', async () => {
    let { m, s } = svc();
    await expect(s.handleCase({ ...m.caseReq, salt: newSalt() })).rejects.toMatchObject({ status: 422, message: /sealed commitment/ });
    await expect(s.handleCase({ ...m.caseReq, buyer_offer_bps: 9000 })).rejects.toMatchObject({ status: 422 });
    await expect(s.handleCase({ ...m.caseReq, response_body: RESP + ' ' })).rejects.toMatchObject({ status: 422, message: /receipt hash/ });
    await expect(s.handleCase({ ...m.caseReq, request_canon: 'GET\n/other\n' })).rejects.toMatchObject({ status: 422, message: /request hash/ });
    await expect(s.handleCase({ ...m.caseReq, call_id: 'x/y' })).rejects.toMatchObject({ status: 404 });
    await expect(s.handleCase({ ...m.caseReq, buyer_offer_bps: 'a' } as never)).rejects.toMatchObject({ status: 400 });
    ({ m, s } = svc({ status: 'Disputed' }));
    await expect(s.handleCase(m.caseReq)).rejects.toMatchObject({ status: 409 });
  });
  it('settlement shortcut: seller offer ≥ buyer offer → no jurors asked, three placeholder ballots', async () => {
    const { m, s } = svc({ sellerBps: 4000, buyerBps: 4000 });
    const out = await s.handleCase(m.caseReq);
    expect(out).toMatchObject({ tier: 'settled', submitted: true, votes: [] });
    expect((m.resolved[0] as { ballots: unknown[] }).ballots).toHaveLength(3);
  });
});

// ---- live mode against a mocked NEAR AI Cloud ----
const seen: Array<{ headers: Record<string, unknown>; body: string }> = [];
let sigMisses = 0;
const responses = new Map<string, { model: string; reqHash: string; raw: string; index: number }>();
const nearai = express();
nearai.post('/v1/chat/completions', express.raw({ type: '*/*' }), (req, res) => {
  const body = (req.body as Buffer).toString('utf8');
  seen.push({ headers: req.headers, body });
  if (req.get('authorization') !== 'Bearer test-key') return void res.status(401).json({ error: 'no key' });
  const parsed = JSON.parse(body) as { model: string; stream: boolean };
  const index = JURORS.findIndex((j) => j.model === parsed.model);
  if (index < 0 || parsed.stream !== false) return void res.status(400).json({ error: 'bad model or stream' });
  const id = `chatcmpl-${index}-${sha256Hex(body).slice(0, 8)}`;
  // pretty-printed on purpose: the signature covers the raw bytes, not a re-serialisation
  const raw = JSON.stringify(JSON.parse(syntheticChatResponse({ chatId: id, model: parsed.model, content: index === 1 ? '<think>\nthe token is NEO\n</think>\n\nY' : 'X' })), null, 1);
  responses.set(id, { model: parsed.model, reqHash: sha256Hex(body), raw, index });
  res.type('application/json').send(raw);
});
nearai.get('/v1/signature/:id', (req, res) => {
  const r = responses.get(req.params.id);
  if (!r || req.query.signing_algo !== 'ed25519' || req.query.model !== r.model) return void res.status(404).json({ error: 'Chat id not found or expired' });
  if (sigMisses-- > 0) return void res.status(404).json({ error: 'Chat id not found or expired' });
  const text = nearaiSignatureText('provider_tee', r.model, r.reqHash, sha256Hex(r.raw));
  const key = syntheticJurorKey(r.index);
  res.json({ text, signature: toHex(ed25519Sign(text, key)), signing_address: toHex(key.publicKey), signing_algo: 'ed25519', signature_kind: 'provider_tee' });
});
let nearaiBase = '';
let nearaiServer: ReturnType<typeof nearai.listen>;
beforeAll(async () => {
  nearaiServer = nearai.listen(0);
  await new Promise((r) => nearaiServer.once('listening', r));
  nearaiBase = `http://127.0.0.1:${(nearaiServer.address() as AddressInfo).port}/v1`;
});
afterAll(() => nearaiServer.close());

describe('live mode (mocked NEAR AI Cloud)', () => {
  it('sends exact bytes with the required headers, fetches signatures with retry, and the ballots verify', async () => {
    seen.length = 0;
    sigMisses = 2;
    const { chain, caseReq, resolved } = mockChain();
    const dir = mkdtempSync(join(tmpdir(), 'mg-rec-'));
    const jurors = new RecordingJurors(new LiveJurors({ apiKey: 'test-key', baseUrl: nearaiBase, clock: instantClock }), dir);
    const out = await new PanelService({ chain, jurors }).handleCase(caseReq);
    expect(out).toMatchObject({ mode: 'live', votes: ['X', 'Y', 'X'], winner: 'buyer', synthetic: false, submitted: true });
    expect(seen).toHaveLength(3);
    for (const s of seen) {
      expect(s.headers['x-no-aliasing']).toBe('true');
      expect(s.headers['accept-encoding']).toBe('identity');
      expect(s.headers['content-type']).toBe('application/json');
    }
    expect(seen.map((s) => s.body).sort()).toEqual([...bodies()].sort());
    // recordings were written and verify offline with core's verifier against the juror keys
    expect(readdirSync(dir).sort()).toEqual(bodies().map((b) => `${sha256Hex(b)}.json`).sort());
    for (const p of jurors.saved) {
      const rec = JSON.parse(await (await import('node:fs/promises')).readFile(p, 'utf8')) as PanelRecording;
      const i = JURORS.findIndex((j) => j.model === rec.model);
      expect(verifyRecording(rec, syntheticJurorKey(i).publicKey).ok).toBe(true);
      expect(Buffer.from(rec.response_body_b64, 'base64').toString()).toContain('\n'); // raw (pretty) bytes kept
    }
    expect((resolved[0] as { ballots: unknown[] }).ballots).toHaveLength(3);
    // and a replay over the recorded files gives the same verdict
    const m2 = mockChain({ salt: caseReq.salt });
    const out2 = await new PanelService({ chain: m2.chain, jurors: new ReplayJurors(dir) }).handleCase(m2.caseReq);
    expect(out2).toMatchObject({ mode: 'replay', votes: out.votes, winner: 'buyer' });
  });

  it('gives up on a missing signature after the configured tries', async () => {
    const live = new LiveJurors({ apiKey: 'test-key', baseUrl: nearaiBase, clock: instantClock, signatureTries: 3 });
    sigMisses = 10;
    await expect(live.ask(JURORS[0]!.model, bodies()[0]!)).rejects.toThrow(/missing after 3 tries/);
    sigMisses = 0;
  });

  it('surfaces HTTP errors from the completion call', async () => {
    const live = new LiveJurors({ apiKey: 'wrong', baseUrl: nearaiBase, clock: instantClock });
    await expect(live.ask(JURORS[0]!.model, bodies()[0]!)).rejects.toThrow(/HTTP 401/);
  });
});

describe('mode selection', () => {
  it('replay is the default without a key', () => {
    expect(jurorsFromEnv({}, '/f').mode).toBe('replay');
    expect(jurorsFromEnv({ NEARAI_API_KEY: 'k' }, '/f').mode).toBe('live');
    expect(jurorsFromEnv({ NEARAI_API_KEY: 'k', PANEL_MODE: 'replay' }, '/f').mode).toBe('replay');
    expect(() => jurorsFromEnv({ PANEL_MODE: 'live' }, '/f')).toThrow(/NEARAI_API_KEY/);
    expect(() => jurorsFromEnv({ PANEL_MODE: 'other' }, '/f')).toThrow();
  });
});
