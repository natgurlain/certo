import { createHash, randomBytes } from 'node:crypto';
import { RECEIPT_PREFIX } from './brand.js';

const enc = new TextEncoder();

/** UTF-8 bytes of a string. */
export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

/** SHA-256 of bytes or of the UTF-8 encoding of a string. */
export function sha256(data: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(typeof data === 'string' ? utf8(data) : data).digest());
}

/** Lower-case hex SHA-256. */
export function sha256Hex(data: string | Uint8Array): string {
  return toHex(sha256(data));
}

export function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex');
}

export function fromHex(h: string): Uint8Array {
  const s = h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h;
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error(`invalid hex: ${h.slice(0, 20)}`);
  return new Uint8Array(Buffer.from(s, 'hex'));
}

export function toBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

export function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

/**
 * JSON string escaping per section 4.3: exactly what `JSON.stringify` does to a
 * well-formed string, without the outer quotes. Lone surrogates are rejected
 * (they cannot be encoded as UTF-8, so the contract could never see them).
 */
export function esc(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdfff) {
      const hi = c <= 0xdbff;
      const next = s.charCodeAt(i + 1);
      if (!hi || !(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('esc: lone surrogate');
      out += s[i]! + s[i + 1]!;
      i++;
      continue;
    }
    switch (c) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += '\\\\'; break;
      case 0x08: out += '\\b'; break;
      case 0x0c: out += '\\f'; break;
      case 0x0a: out += '\\n'; break;
      case 0x0d: out += '\\r'; break;
      case 0x09: out += '\\t'; break;
      default:
        out += c < 0x20 ? '\\u' + c.toString(16).padStart(4, '0') : s[i];
    }
  }
  return out;
}

/** `METHOD + "\n" + path_with_query + "\n" + body` (body empty for GET). */
export function requestCanon(method: string, pathWithQuery: string, body = ''): string {
  return `${method.toUpperCase()}\n${pathWithQuery}\n${body}`;
}

/** `request_hash` hex = sha256(request_canon). */
export function requestHash(canon: string): string {
  return sha256Hex(canon);
}

/** 16 random bytes, lower-case hex. */
export function newQuoteId(): string {
  return randomBytes(16).toString('hex');
}

export function isQuoteId(s: string): boolean {
  return /^[0-9a-f]{32}$/.test(s);
}

/** `"<seller account>/<quote_id>"`. */
export function callIdOf(seller: string, quoteId: string): string {
  return `${seller}/${quoteId}`;
}

export function splitCallId(callId: string): { seller: string; quoteId: string } {
  const i = callId.lastIndexOf('/');
  if (i < 0) throw new Error(`invalid call id: ${callId}`);
  return { seller: callId.slice(0, i), quoteId: callId.slice(i + 1) };
}

export interface ReceiptFields {
  contract: string;
  callId: string;
  buyer: string;
  /** Price in token base units, decimal integer string. */
  price: string | bigint;
  termsId: string;
  requestHash: string;
  responseHash: string;
  statusCode: number;
  servedAtMs: number;
}

/** Canonical receipt text (section 4.3). */
export function receiptText(r: ReceiptFields): string {
  return [
    RECEIPT_PREFIX, r.contract, r.callId, r.buyer, BigInt(r.price).toString(), r.termsId,
    r.requestHash.toLowerCase(), r.responseHash.toLowerCase(), String(r.statusCode), String(r.servedAtMs),
  ].join('|');
}

/** Offer commitment bytes: sha256(u16_le(offer_bps) ‖ salt[32]). */
export function offerCommit(offerBps: number, salt: Uint8Array | string): string {
  const s = typeof salt === 'string' ? fromHex(salt) : salt;
  if (s.length !== 32) throw new Error('salt must be 32 bytes');
  assertOfferBps(offerBps);
  const buf = new Uint8Array(34);
  buf[0] = offerBps & 0xff;
  buf[1] = (offerBps >> 8) & 0xff;
  buf.set(s, 2);
  return sha256Hex(buf);
}

export function newSalt(): string {
  return randomBytes(32).toString('hex');
}

export function assertOfferBps(bps: number): void {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000 || bps % 100 !== 0) {
    throw new RangeError(`offer must be a multiple of 100 bps in 0..10000, got ${bps}`);
  }
}
