import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  callIdOf, decodeHeader, ed25519FromSeed, encodeHeader, HDR_PAYMENT_REQUIRED, HDR_PAYMENT_RESPONSE, HDR_PAYMENT_SIGNATURE,
  isQuoteId, newQuoteId, PAYMENT_SCHEME, receiptText, requestCanon, sha256Hex, signBase64, stakeFor, systemClock,
  type Clock, type Ed25519Key, type CertoChain, type PaymentRequired, type PaymentRequirement, type PaymentResponse,
  type PaymentSignature, type Receipt,
} from '@certo/core';

/** Chain access the middleware needs (views; `release` only if the client can sign). */
export type SellerChain = Pick<CertoChain, 'contractId' | 'tokenId' | 'network' | 'getCall' | 'getSeller'> &
  Partial<Pick<CertoChain, 'release' | 'accountId'>>;

/** What the middleware remembers about each served call (also used by the answer bot to `cure`). */
export interface ServedCall {
  callId: string;
  buyer: string;
  requestHash: string;
  statusCode: number;
  headers: Record<string, string | string[] | number>;
  body: Buffer;
  receipt: Receipt;
  /** base64 `PAYMENT-RESPONSE` header value */
  paymentResponse: string;
}

export type ServedStore = Map<string, Promise<ServedCall>>;

export interface ProtectOptions {
  /** Chain client for the certo contract. */
  contract: SellerChain;
  /** Seller account id (registered in the contract). */
  seller: string;
  termsId: string;
  /** Price in token base units (decimal-integer string), e.g. "400000" for 0.40. */
  price: string;
  /** Seller's receipt key: a plain ed25519 key or its 32-byte seed. */
  receiptKey: Ed25519Key | Uint8Array;
  /** Used in the 402 when `get_seller` is unavailable. */
  windowMs?: number;
  feeBps?: number;
  maxTimeoutSeconds?: number;
  /** Shared with `createAnswerBot`; one is created if omitted. */
  store?: ServedStore;
  clock?: Clock;
  /** Call `release(seller, 32)` when free capacity looks short at quote time (needs a signing client). Default true. */
  releaseWhenShort?: boolean;
}

export interface ProtectMiddleware extends RequestHandler {
  store: ServedStore;
}

async function readRawBody(req: Request): Promise<string> {
  const b = (req as { body?: unknown }).body;
  if (Buffer.isBuffer(b)) return b.toString('utf8');
  if (typeof b === 'string') return b;
  if (b !== undefined && b !== null && !(typeof b === 'object' && Object.keys(b as object).length === 0)) {
    throw new Error('protect() needs the raw request body: mount it before any body parser');
  }
  if (req.readableEnded) return '';
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks).toString('utf8');
}

function json(res: Response, status: number, obj: unknown, headers: Record<string, string> = {}): void {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.status(status).type('application/json').send(JSON.stringify(obj));
}

/**
 * Express middleware implementing the x402-v2-shaped flow of DESIGN.md 4.3:
 * no payment header → 402 + `PAYMENT-REQUIRED`; with `PAYMENT-SIGNATURE` →
 * checks the call on chain (open, price, terms, request hash, not served) →
 * runs the next handler → signs a receipt over the exact response bytes and
 * sends it in `PAYMENT-RESPONSE` (also for handler errors and 5xx).
 * The raw request body is exposed to the handler as `req.body` (string).
 */
export function protect(opts: ProtectOptions): ProtectMiddleware {
  const key = opts.receiptKey instanceof Uint8Array ? ed25519FromSeed(opts.receiptKey) : opts.receiptKey;
  const store: ServedStore = opts.store ?? new Map();
  const clock = opts.clock ?? systemClock;
  const chain = opts.contract;

  async function requirement(): Promise<PaymentRequirement> {
    let windowMs = opts.windowMs ?? 120_000;
    let feeBps = opts.feeBps ?? 100;
    try {
      const s = await chain.getSeller(opts.seller);
      if (s) {
        windowMs = s.window_ms;
        feeBps = s.fee_bps;
        const need = BigInt(opts.price) + BigInt(stakeFor(opts.price));
        if ((opts.releaseWhenShort ?? true) && BigInt(s.free_capacity) < need && chain.release && chain.accountId) {
          chain.release(opts.seller, 32).catch(() => undefined);
        }
      }
    } catch {
      /* quote with configured values */
    }
    return {
      scheme: PAYMENT_SCHEME, network: chain.network, amount: opts.price, asset: chain.tokenId, payTo: chain.contractId,
      maxTimeoutSeconds: opts.maxTimeoutSeconds ?? 60,
      extra: { seller: opts.seller, quoteId: newQuoteId(), termsId: opts.termsId, windowMs, feeBps },
    };
  }

  async function paymentRequired(req: Request, res: Response, error?: string): Promise<void> {
    const pr: PaymentRequired = {
      x402Version: 2,
      resource: { url: `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}` },
      accepts: [await requirement()],
    };
    json(res, 402, error ? { error, ...pr } : pr, { [HDR_PAYMENT_REQUIRED]: encodeHeader(pr) });
  }

  function replay(res: Response, s: ServedCall): void {
    for (const [k, v] of Object.entries(s.headers)) res.setHeader(k, v as string);
    res.setHeader(HDR_PAYMENT_RESPONSE, s.paymentResponse);
    res.status(s.statusCode).end(s.body);
  }

  const mw = async function protectMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const raw = await readRawBody(req);
      (req as { body?: unknown }).body = raw;
      const header = req.get(HDR_PAYMENT_SIGNATURE);
      if (!header) return await paymentRequired(req, res);

      let ps: PaymentSignature;
      try {
        ps = decodeHeader<PaymentSignature>(header);
      } catch {
        return await paymentRequired(req, res, 'malformed PAYMENT-SIGNATURE');
      }
      const callId = ps?.payload?.callId ?? '';
      const quoteId = ps?.accepted?.extra?.quoteId ?? '';
      if (ps?.accepted?.scheme !== PAYMENT_SCHEME || !isQuoteId(quoteId) || callId !== callIdOf(opts.seller, quoteId)) {
        return await paymentRequired(req, res, 'payment is not for this seller or scheme');
      }
      const reqHash = sha256Hex(requestCanon(req.method, req.originalUrl, raw));

      const prior = store.get(callId);
      if (prior) {
        const s = await prior.catch(() => undefined);
        if (s && s.requestHash === reqHash) return replay(res, s);
        if (s) return await paymentRequired(req, res, 'request differs from the one paid for');
      }

      const call = await chain.getCall(callId);
      const problem = !call ? 'call not found on chain'
        : call.status !== 'Open' ? `call status is ${call.status}`
        : call.seller !== opts.seller ? 'call is for another seller'
        : BigInt(call.price) < BigInt(opts.price) ? 'paid less than the quoted price'
        : call.terms_id !== opts.termsId ? 'call is for other terms'
        : call.request_hash !== reqHash ? 'request differs from the one paid for'
        : undefined;
      if (problem || !call) return await paymentRequired(req, res, problem);
      if (store.has(callId)) {
        const s = await store.get(callId)!.catch(() => undefined);
        if (s) return replay(res, s);
      }

      let resolveServed!: (s: ServedCall) => void;
      let rejectServed!: (e: unknown) => void;
      const served = new Promise<ServedCall>((a, b) => { resolveServed = a; rejectServed = b; });
      served.catch(() => undefined);
      store.set(callId, served);

      // Buffer the handler's output, then sign it.
      const chunks: Buffer[] = [];
      const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
      const origEnd = res.end.bind(res) as (...a: unknown[]) => Response;
      const origWriteHead = res.writeHead.bind(res) as (...a: unknown[]) => Response;
      let deferredHead: unknown[] | undefined;
      const toBuf = (c: unknown, enc?: unknown): Buffer =>
        Buffer.isBuffer(c) ? c : c instanceof Uint8Array ? Buffer.from(c) : Buffer.from(String(c), (typeof enc === 'string' ? enc : 'utf8') as BufferEncoding);

      (res as { writeHead: unknown }).writeHead = (...a: unknown[]) => { deferredHead = a; if (typeof a[0] === 'number') res.statusCode = a[0]; return res; };
      (res as { write: unknown }).write = (c: unknown, enc?: unknown, cb?: unknown) => {
        if (c !== undefined && c !== null && typeof c !== 'function') chunks.push(toBuf(c, enc));
        const done = typeof enc === 'function' ? enc : cb;
        if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
        return true;
      };
      (res as { end: unknown }).end = (c?: unknown, enc?: unknown, cb?: unknown) => {
        if (c !== undefined && c !== null && typeof c !== 'function') chunks.push(toBuf(c, enc));
        const done = typeof c === 'function' ? c : typeof enc === 'function' ? enc : cb;
        (res as { write: unknown }).write = origWrite;
        (res as { end: unknown }).end = origEnd;
        (res as { writeHead: unknown }).writeHead = origWriteHead;
        try {
          const body = Buffer.concat(chunks);
          if (deferredHead) {
            // apply headers given to writeHead(status, [message], headers)
            const h = deferredHead.find((x, i) => i > 0 && typeof x === 'object' && x !== null) as Record<string, string> | undefined;
            if (h) for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
          }
          const statusCode = res.statusCode;
          const servedAtMs = clock.now();
          const responseHash = sha256Hex(body);
          const text = receiptText({
            contract: chain.contractId, callId, buyer: call.buyer, price: call.price, termsId: opts.termsId,
            requestHash: reqHash, responseHash, statusCode, servedAtMs,
          });
          const receipt: Receipt = { callId, responseHash, statusCode, servedAtMs, sig: signBase64(text, key) };
          const pr: PaymentResponse = {
            success: true, network: chain.network, transaction: ps.payload.txHash ?? '', payer: call.buyer, receipt,
          };
          const paymentResponse = encodeHeader(pr);
          res.setHeader('Content-Encoding', 'identity');
          res.setHeader('Content-Length', String(body.length));
          res.setHeader(HDR_PAYMENT_RESPONSE, paymentResponse);
          resolveServed({
            callId, buyer: call.buyer, requestHash: reqHash, statusCode, headers: { ...res.getHeaders() } as ServedCall['headers'],
            body, receipt, paymentResponse,
          });
        } catch (e) {
          rejectServed(e);
          store.delete(callId);
        }
        res.statusCode = res.statusCode || 200;
        origEnd(Buffer.concat(chunks), done as undefined);
        return res;
      };
      next();
    } catch (e) {
      next(e);
    }
  } as ProtectMiddleware;
  mw.store = store;
  return mw;
}
