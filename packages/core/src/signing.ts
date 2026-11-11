import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify, randomBytes, KeyObject } from 'node:crypto';
import { fromBase64, fromHex, sha256, toBase64, toHex, utf8 } from './encode.js';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** A plain ed25519 key (not a NEAR account key): 32-byte seed and 32-byte public key. */
export interface Ed25519Key {
  seed: Uint8Array;
  publicKey: Uint8Array;
}

export function ed25519FromSeed(seed: Uint8Array): Ed25519Key {
  if (seed.length !== 32) throw new Error('ed25519 seed must be 32 bytes');
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return { seed: new Uint8Array(seed), publicKey: new Uint8Array(spki.subarray(SPKI_PREFIX.length)) };
}

export function generateEd25519(): Ed25519Key {
  return ed25519FromSeed(new Uint8Array(randomBytes(32)));
}

/** Deterministic key from a label: seed = sha256(label). For tests and synthetic ballots only. */
export function ed25519FromLabel(label: string): Ed25519Key {
  return ed25519FromSeed(sha256(label));
}

function privKey(k: Ed25519Key | Uint8Array): KeyObject {
  const seed = k instanceof Uint8Array ? k : k.seed;
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
}

/** ed25519 signature (64 bytes) over bytes or the UTF-8 bytes of a string. */
export function ed25519Sign(message: string | Uint8Array, key: Ed25519Key | Uint8Array): Uint8Array {
  const m = typeof message === 'string' ? utf8(message) : message;
  return new Uint8Array(nodeSign(null, m, privKey(key)));
}

/** Verify; never throws on malformed input (returns false). */
export function ed25519Verify(message: string | Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    if (signature.length !== 64 || publicKey.length !== 32) return false;
    const pub = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey)]), format: 'der', type: 'spki' });
    const m = typeof message === 'string' ? utf8(message) : message;
    return nodeVerify(null, m, pub, signature);
  } catch {
    return false;
  }
}

/** Sign and return base64 (receipt signatures, contract `Base64<[u8;64]>`). */
export function signBase64(message: string, key: Ed25519Key | Uint8Array): string {
  return toBase64(ed25519Sign(message, key));
}

export function verifyBase64(message: string, sigB64: string, publicKey: Uint8Array | string): boolean {
  const pk = typeof publicKey === 'string' ? decodePublicKey(publicKey) : publicKey;
  return ed25519Verify(message, fromBase64(sigB64), pk);
}

/**
 * Decode a 64-byte signature given as hex (optionally `0x`-prefixed) or base64.
 * NEAR AI's ed25519 signature encoding is not documented precisely, so accept both.
 */
export function decodeSignature(s: string): Uint8Array {
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (/^[0-9a-fA-F]{128}$/.test(h)) return fromHex(h);
  const b = fromBase64(s);
  if (b.length !== 64) throw new Error('signature is neither 64-byte hex nor base64');
  return b;
}

/**
 * Decode a 32-byte ed25519 public key given as hex (optionally `0x`), base64,
 * or NEAR's `ed25519:<base58>` form.
 */
export function decodePublicKey(s: string): Uint8Array {
  if (s.startsWith('ed25519:')) return base58Decode(s.slice(8));
  const h = s.startsWith('0x') ? s.slice(2) : s;
  if (/^[0-9a-fA-F]{64}$/.test(h)) return fromHex(h);
  const b = fromBase64(s);
  if (b.length !== 32) throw new Error('public key is neither 32-byte hex, base64 nor ed25519:<base58>');
  return b;
}

export function publicKeyHex(k: Ed25519Key): string {
  return toHex(k.publicKey);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error('invalid base58');
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch === '1') bytes.unshift(0); else break; }
  return new Uint8Array(bytes);
}
export function base58Encode(b: Uint8Array): string {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const x of b) { if (x === 0) out = '1' + out; else break; }
  return out;
}

// ---- NEAR AI Cloud signatures (section 2.1) ----

export type SignatureKind = 'provider_tee' | 'gateway';

/** `provider_tee`: `<model>:<reqHash>:<respHash>`; `gateway`: `<reqHash>:<respHash>`. */
export function nearaiSignatureText(kind: SignatureKind, model: string, reqHash: string, respHash: string): string {
  return kind === 'provider_tee' ? `${model}:${reqHash}:${respHash}` : `${reqHash}:${respHash}`;
}

/** Shape returned by `GET /v1/signature/<chat id>?…&signing_algo=ed25519`. */
export interface NearAiSignature {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: SignatureKind;
}

export interface BallotCheck {
  ok: boolean;
  reason?: string;
  kind: SignatureKind;
  requestHash: string;
  responseHash: string;
}

/**
 * Offline check of one ballot: the signed text must be exactly the text rebuilt
 * from the request body we sent and the raw response bytes we received, and
 * the ed25519 signature must verify under `expectedKey` (or under the
 * `signing_address` in the signature object if no key is given).
 */
export function verifyNearAiBallot(args: {
  model: string;
  requestBody: string | Uint8Array;
  responseBody: string | Uint8Array;
  signature: NearAiSignature;
  expectedKey?: Uint8Array | string;
}): BallotCheck {
  const kind: SignatureKind = args.signature.signature_kind ?? (args.signature.text.split(':').length > 2 ? 'provider_tee' : 'gateway');
  const requestHash = toHex(sha256(args.requestBody));
  const responseHash = toHex(sha256(args.responseBody));
  const base = { kind, requestHash, responseHash };
  if (args.signature.signing_algo !== 'ed25519') return { ok: false, reason: `signing_algo ${args.signature.signing_algo}`, ...base };
  const expectedText = nearaiSignatureText(kind, args.model, requestHash, responseHash);
  if (args.signature.text !== expectedText) return { ok: false, reason: 'signed text does not match the hashes', ...base };
  let key: Uint8Array;
  let sig: Uint8Array;
  try {
    key = args.expectedKey === undefined ? decodePublicKey(args.signature.signing_address)
      : typeof args.expectedKey === 'string' ? decodePublicKey(args.expectedKey) : args.expectedKey;
    if (args.expectedKey !== undefined && toHex(key) !== toHex(decodePublicKey(args.signature.signing_address))) {
      return { ok: false, reason: 'signing_address is not the expected juror key', ...base };
    }
    sig = decodeSignature(args.signature.signature);
  } catch (e) {
    return { ok: false, reason: (e as Error).message, ...base };
  }
  if (!ed25519Verify(expectedText, sig, key)) return { ok: false, reason: 'bad ed25519 signature', ...base };
  return { ok: true, ...base };
}
