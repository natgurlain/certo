import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildCase, buildPanelRequest, buildPanelRequestFor, decodePublicKey, decodeSignature, ed25519FromLabel, ed25519FromSeed,
  ed25519Sign, ed25519Verify, esc, feeFor, formatUsdc, fromBase64, fromHex, JURORS, labelsFor, majority, makeSyntheticBallot,
  nearaiSignatureText, offerCommit, parseEvents, parseUsdc, parseVote, parseVoteContent, receiptText, recordingFileName,
  recordingResponseBody, requestCanon, sha256Hex, signBase64, stakeFor, syntheticJurorKey, SYSTEM_PROMPT, toBase64,
  toContractBallot, toHex, toHex32, verifyBase64, verifyNearAiBallot, verifyRecording, voteToSide, base58Encode, base58Decode,
  decodeHeader, encodeHeader, refundFor, errorCode, EVENT_STANDARD, RECEIPT_PREFIX, callIdOf, splitCallId, isQuoteId, newQuoteId,
} from '../src/index.js';
import { generate } from '../scripts/gen-vectors.js';
import { HOLDERS_TERMS, REQ_NEAR_TOP5, RESP_B1_03 } from './cases.js';

const vectors = JSON.parse(readFileSync(new URL('../../../fixtures/vectors.json', import.meta.url), 'utf8'));

describe('golden vectors file', () => {
  it('has the required counts', () => {
    expect(vectors.esc.length).toBeGreaterThanOrEqual(40);
    expect(vectors.panel_requests.length).toBe(6);
    expect(vectors.receipts.items.length).toBeGreaterThanOrEqual(3);
  });
  it('is exactly what the encoders produce today', () => {
    expect(JSON.parse(JSON.stringify(generate()))).toEqual(vectors);
  });
});

describe('esc', () => {
  it.each(vectors.esc.map((v: { name: string; input: string; expected: string }) => [v.name, v.input, v.expected]) as [string, string, string][])(
    '%s',
    (_n, input, expected) => {
      expect(esc(input as string)).toBe(expected);
      // independent oracle: JSON.stringify without the outer quotes
      expect(esc(input as string)).toBe(JSON.stringify(input).slice(1, -1));
    },
  );
  it('uses lower-case hex for \\u escapes', () => {
    expect(esc('\u001f')).toBe('\\u001f');
    expect(esc('\u001b')).toBe('\\u001b');
  });
  it('rejects lone surrogates', () => {
    expect(() => esc('a\ud800b')).toThrow(/surrogate/);
    expect(() => esc('\udc00')).toThrow(/surrogate/);
  });
  it('matches JSON.stringify on every BMP code point except surrogates', () => {
    let s = '';
    for (let c = 0; c < 0xd800; c++) s += String.fromCharCode(c);
    for (let c = 0xe000; c <= 0xffff; c++) s += String.fromCharCode(c);
    expect(esc(s)).toBe(JSON.stringify(s).slice(1, -1));
  });
});

describe('request canon and hashes', () => {
  it.each(vectors.request_canon.map((r: Record<string, string>) => [r.method, r.path, r.body, r.canon, r.sha256]) as string[][] as [string, string, string, string, string][])(
    '%s %s',
    (m, p, b, canon, h) => {
      expect(requestCanon(m as string, p as string, b as string)).toBe(canon);
      expect(sha256Hex(canon as string)).toBe(h);
    },
  );
  it('sha256 of known strings', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('call ids and quote ids', () => {
    const q = newQuoteId();
    expect(isQuoteId(q)).toBe(true);
    expect(isQuoteId(q.toUpperCase())).toBe(false);
    expect(splitCallId(callIdOf('a.b.near', q))).toEqual({ seller: 'a.b.near', quoteId: q });
  });
});

describe('panel request body', () => {
  it.each(vectors.panel_requests.map((p: Record<string, unknown>) => [p.name, p]) as [string, any][])('%s', (_n, p) => {
    const c = p;
    const caseJson = buildCase({ jurorIndex: c.juror_idx, termsText: c.terms_text, requestCanon: c.request_canon, responseBody: c.response_body, buyerOfferBps: c.buyer_bps, sellerOfferBps: c.seller_bps });
    expect(caseJson).toBe(c.case);
    expect(buildPanelRequest(c.model, caseJson)).toBe(c.body);
    expect(sha256Hex(c.body)).toBe(c.body_sha256);
  });

  it('B1-03 body is byte-identical to an independently built expected body', () => {
    // Independent construction with JSON.stringify: object key order is insertion order, no spaces.
    const expectedCase = JSON.stringify({
      terms: HOLDERS_TERMS, request: REQ_NEAR_TOP5, response: RESP_B1_03,
      offer_X: 'refund 100 percent of the price', offer_Y: 'refund 0 percent of the price',
    });
    const expected = JSON.stringify({
      model: 'Qwen/Qwen3.8-27B',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: expectedCase }],
      temperature: 0, seed: 7, max_tokens: 4096, stream: false,
    });
    const got = buildPanelRequestFor({ jurorIndex: 0, termsText: HOLDERS_TERMS, requestCanon: REQ_NEAR_TOP5, responseBody: RESP_B1_03, buyerOfferBps: 10000, sellerOfferBps: 0 });
    expect(got).toBe(expected);
    expect(got).toBe(vectors.panel_requests[0].body);
    // the evidence round-trips intact through the double escaping
    const parsed = JSON.parse(JSON.parse(got).messages[1].content);
    expect(parsed.response).toBe(RESP_B1_03);
  });

  it('juror 1 sees the buyer offer as Y', () => {
    const c = JSON.parse(buildCase({ jurorIndex: 1, termsText: 't', requestCanon: 'r', responseBody: 'b', buyerOfferBps: 10000, sellerOfferBps: 2000 }));
    expect(c.offer_X).toBe('refund 20 percent of the price');
    expect(c.offer_Y).toBe('refund 100 percent of the price');
  });

  it('system prompt is one line', () => {
    expect(SYSTEM_PROMPT.includes('\n')).toBe(false);
    expect(SYSTEM_PROMPT.endsWith('Reply with exactly one character, X or Y, and nothing else.')).toBe(true);
  });
});

describe('juror mapping and majority', () => {
  it('table matches section 4.4', () => {
    expect(JURORS.map((j) => [j.model, j.buyerLabel])).toEqual([
      ['Qwen/Qwen3.8-27B', 'X'], ['z-ai/glm-5.3-flash', 'Y'], ['deepseek-ai/DeepSeek-V4.1-Flash-1017', 'X'],
    ]);
    expect(labelsFor(1)).toEqual({ buyer: 'Y', seller: 'X' });
    expect(() => labelsFor(3)).toThrow();
  });
  it('maps votes to sides', () => {
    expect([voteToSide(0, 'X'), voteToSide(1, 'X'), voteToSide(2, 'X')]).toEqual(['buyer', 'seller', 'buyer']);
    expect([voteToSide(0, 'Y'), voteToSide(1, 'Y'), voteToSide(2, 'abstain')]).toEqual(['seller', 'buyer', 'abstain']);
  });
  it('majority needs two equal votes', () => {
    expect(majority(['buyer', 'buyer', 'seller'])).toBe('buyer');
    expect(majority(['seller', 'abstain', 'seller'])).toBe('seller');
    expect(majority(['buyer', 'abstain', 'abstain'])).toBeNull();
    expect(majority(['buyer', 'seller', 'abstain'])).toBeNull();
  });
});

describe('parseVote', () => {
  it.each(vectors.parse_vote.map((p: Record<string, string>) => [JSON.stringify(p.response_body).slice(0, 60), p.response_body, p.vote]) as [string, string, string][])(
    'vector %s',
    (_n, body, vote) => expect(parseVote(body as string)).toBe(vote),
  );
  it('edge cases', () => {
    expect(parseVoteContent('X')).toBe('X');
    expect(parseVoteContent('  Y  ')).toBe('Y');
    expect(parseVoteContent('<think>long reasoning\nwith X and Y</think>\nY')).toBe('Y');
    expect(parseVoteContent('<think></think>X')).toBe('X');
    expect(parseVoteContent('<think>a</think><think>b</think>X')).toBe('abstain'); // only one block stripped
    expect(parseVoteContent('X <think>a</think>')).toBe('abstain');
    expect(parseVoteContent(' X')).toBe('abstain'); // NBSP is not ASCII whitespace
    expect(parseVoteContent('X\u000b')).toBe('abstain'); // VT is not Rust ascii whitespace
    expect(parseVoteContent('\fX\r')).toBe('X');
    expect(parseVote('{"choices":[{"message":{"content":"X"}}]}')).toBe('X');
    expect(parseVote('{"choices":[{"message":{"content":["X"]}}]}')).toBe('abstain');
    expect(parseVote('{"choices":[{"message":{"reasoning_content":"...","content":"Y"}}]}')).toBe('Y');
    expect(parseVote('[]')).toBe('abstain');
    expect(parseVote('null')).toBe('abstain');
    expect(parseVote('')).toBe('abstain');
  });
});

describe('receipts', () => {
  const key = ed25519FromSeed(fromHex(vectors.receipts.key_seed_hex));
  it('key derivation matches the vector', () => expect(toHex(key.publicKey)).toBe(vectors.receipts.pubkey_hex));
  it.each(vectors.receipts.items.map((r: Record<string, unknown>) => [r.callId, r]) as [string, any][])('%s', (_n, r) => {
    const item = r;
    const text = receiptText(item);
    expect(text).toBe(item.text);
    expect(text.startsWith(RECEIPT_PREFIX + '|')).toBe(true);
    expect(text.split('|')).toHaveLength(10);
    expect(signBase64(text, key)).toBe(item.sig_b64); // ed25519 is deterministic
    expect(verifyBase64(text, item.sig_b64, vectors.receipts.pubkey_hex)).toBe(true);
    expect(verifyBase64(text + 'x', item.sig_b64, vectors.receipts.pubkey_hex)).toBe(false);
  });
});

describe('ed25519 helpers', () => {
  it('RFC 8032 test vector 1', () => {
    const k = ed25519FromSeed(fromHex('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'));
    expect(toHex(k.publicKey)).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    const sig = ed25519Sign(new Uint8Array(), k);
    expect(toHex(sig)).toBe('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
    expect(ed25519Verify(new Uint8Array(), sig, k.publicKey)).toBe(true);
  });
  it('verify never throws on garbage', () => {
    expect(ed25519Verify('m', new Uint8Array(3), new Uint8Array(32))).toBe(false);
    expect(ed25519Verify('m', new Uint8Array(64), new Uint8Array(31))).toBe(false);
    expect(ed25519Verify('m', new Uint8Array(64), new Uint8Array(32))).toBe(false);
  });
  it('decodes keys and signatures in several encodings', () => {
    const k = ed25519FromLabel('x');
    const hex = toHex(k.publicKey);
    expect(toHex(decodePublicKey(hex))).toBe(hex);
    expect(toHex(decodePublicKey('0x' + hex))).toBe(hex);
    expect(toHex(decodePublicKey(toBase64(k.publicKey)))).toBe(hex);
    expect(toHex(decodePublicKey('ed25519:' + base58Encode(k.publicKey)))).toBe(hex);
    expect(toHex(base58Decode(base58Encode(new Uint8Array([0, 0, 1, 2]))))).toBe('00000102');
    const sig = ed25519Sign('m', k);
    expect(toHex(decodeSignature(toHex(sig)))).toBe(toHex(sig));
    expect(toHex(decodeSignature('0x' + toHex(sig)))).toBe(toHex(sig));
    expect(toHex(decodeSignature(toBase64(sig)))).toBe(toHex(sig));
    expect(() => decodeSignature('abcd')).toThrow();
  });
});

describe('NEAR AI signatures and synthetic ballots', () => {
  it('signature text formats', () => {
    for (const s of vectors.nearai_signature_text) expect(nearaiSignatureText(s.kind, s.model, s.request_sha256, s.response_sha256)).toBe(s.text);
  });
  const body = vectors.panel_requests[0].body as string;
  const rec = makeSyntheticBallot({ jurorIndex: 0, model: JURORS[0]!.model, requestBody: body, responseContent: 'X' });
  it('synthetic ballot has the NEAR AI shape and verifies', () => {
    expect(rec.synthetic).toBe(true);
    expect(rec.signature).toMatchObject({ signing_algo: 'ed25519', signature_kind: 'provider_tee' });
    expect(rec.signature.text).toBe(`${JURORS[0]!.model}:${sha256Hex(body)}:${sha256Hex(recordingResponseBody(rec))}`);
    expect(parseVote(recordingResponseBody(rec))).toBe('X');
    expect(verifyRecording(rec).ok).toBe(true);
    expect(verifyRecording(rec, syntheticJurorKey(0).publicKey).ok).toBe(true);
    expect(verifyRecording(rec, syntheticJurorKey(1).publicKey)).toMatchObject({ ok: false, reason: /expected juror key/ });
    expect(recordingFileName(body)).toBe(`${sha256Hex(body)}.json`);
  });
  it('is deterministic', () => {
    expect(makeSyntheticBallot({ jurorIndex: 0, model: JURORS[0]!.model, requestBody: body, responseContent: 'X' })).toEqual(rec);
  });
  it('detects a flipped vote, a changed prompt and a wrong kind', () => {
    const flipped = { ...rec, response_body_b64: toBase64(new TextEncoder().encode(recordingResponseBody(rec).replace('"X"', '"Y"'))) };
    expect(verifyRecording(flipped)).toMatchObject({ ok: false, reason: /hashes/ });
    expect(verifyRecording({ ...rec, request_body: body + ' ' }).ok).toBe(false);
    expect(verifyNearAiBallot({ model: rec.model, requestBody: body, responseBody: recordingResponseBody(rec), signature: { ...rec.signature, signing_algo: 'ecdsa' } }).ok).toBe(false);
    const badSig = { ...rec, signature: { ...rec.signature, signature: toHex(new Uint8Array(64)) } };
    expect(verifyRecording(badSig)).toMatchObject({ ok: false, reason: /bad ed25519/ });
  });
  it('contract ballot re-encodes the signature as base64', () => {
    const b = toContractBallot(rec);
    expect(b.kind).toBe('provider_tee');
    expect(toHex(fromBase64(b.signature))).toBe(rec.signature.signature);
    expect(b.response_body).toBe(recordingResponseBody(rec));
  });
});

describe('offer commitments', () => {
  it.each(vectors.offer_commits.map((o: Record<string, never>) => [o.offer_bps, o.salt_hex, o.commit_hex]) as [number, string, string][])('%s bps', (bps, salt, commit) => {
    expect(offerCommit(bps as number, salt as string)).toBe(commit);
  });
  it('is sha256(u16_le ‖ salt)', () => {
    const salt = new Uint8Array(32).fill(0xab);
    const buf = new Uint8Array([0xa0, 0x0f, ...salt]); // 4000 = 0x0fa0
    expect(offerCommit(4000, salt)).toBe(sha256Hex(buf));
  });
  it('rejects bad offers and salts', () => {
    expect(() => offerCommit(150, new Uint8Array(32))).toThrow();
    expect(() => offerCommit(10100, new Uint8Array(32))).toThrow();
    expect(() => offerCommit(100, new Uint8Array(31))).toThrow();
  });
});

describe('amounts', () => {
  it('parse and format', () => {
    expect(parseUsdc('0.40')).toBe('400000');
    expect(parseUsdc('50')).toBe('50000000');
    expect(parseUsdc('0.000001')).toBe('1');
    expect(parseUsdc(0.4)).toBe('400000');
    expect(() => parseUsdc('0.0000001')).toThrow();
    expect(() => parseUsdc('-1')).toThrow();
    expect(formatUsdc('396000')).toBe('0.396000');
    expect(formatUsdc(49_580_000n)).toBe('49.580000');
    expect(formatUsdc('-20000')).toBe('-0.020000');
  });
  it('demo numbers from section 4.5', () => {
    expect(feeFor('400000', 100)).toBe('4000');
    expect(feeFor('400000', 150)).toBe('6000');
    expect(feeFor('1', 50)).toBe('1');
    expect(stakeFor('400000')).toBe('20000');
    expect(stakeFor('400000', { multLog2: 1 })).toBe('40000');
    expect(stakeFor('10000000')).toBe('500000');
    expect(refundFor('400000', 10000)).toBe('400000');
    expect(refundFor('400000', 4000)).toBe('160000');
  });
});

describe('events, headers, normalisation', () => {
  it('parses NEP-297 logs of our standard only', () => {
    const logs = [
      'plain log',
      `EVENT_JSON:${JSON.stringify({ standard: EVENT_STANDARD, version: '1.0.0', event: 'call_paid', data: { call_id: 'a/b' } })}`,
      `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data: [] })}`,
      'EVENT_JSON:{broken',
    ];
    expect(parseEvents(logs).map((e) => e.event)).toEqual(['call_paid']);
    expect(errorCode('Smart contract panicked: E_EXPOSURE: free capacity 1')).toBe('E_EXPOSURE');
    expect(errorCode('nothing')).toBeUndefined();
  });
  it('base64 JSON headers round-trip', () => {
    const v = { x402Version: 2, s: 'ż🚀' };
    expect(decodeHeader(encodeHeader(v))).toEqual(v);
  });
  it('toHex32 accepts hex, base64 and byte arrays', () => {
    const h = sha256Hex('a');
    expect(toHex32(h)).toBe(h);
    expect(toHex32(h.toUpperCase())).toBe(h);
    expect(toHex32(toBase64(fromHex(h)))).toBe(h);
    expect(toHex32(Array.from(fromHex(h)))).toBe(h);
    expect(() => toHex32('abc')).toThrow();
  });
});
