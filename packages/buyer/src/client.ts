import {
  callIdOf, decodeHeader, encodeHeader, errorCode, findOurRequirement, hasEvent, HDR_PAYMENT_REQUIRED, HDR_PAYMENT_RESPONSE,
  HDR_PAYMENT_SIGNATURE, newSalt, offerCommit, receiptText, requestCanon, sha256Hex, systemClock, verifyBase64,
  type CallView, type Clock, type CertoChain, type PaymentRequired, type PaymentRequirement, type PaymentResponse,
  type PaymentSignature, type Receipt, type TxResult,
} from '@certo/core';

export type BuyerChain = Pick<
  CertoChain,
  'contractId' | 'tokenId' | 'accountId' | 'getSeller' | 'getTerms' | 'getCall' | 'getBuyer' | 'quote' | 'pay' | 'claimError' |
  'claimRule' | 'disputeNonDelivery' | 'disputeContent' | 'resolveDefault'
>;

export type FailureCode =
  | 'NOT_PROTECTED' | 'NO_SCHEME' | 'WRONG_CONTRACT' | 'PRICE_TOO_HIGH' | 'SELLER_UNKNOWN' | 'TERMS_UNKNOWN' | 'WOULD_NOT_FIT'
  | 'PAY_FAILED' | 'TIMEOUT' | 'NO_RECEIPT' | 'RECEIPT_MISMATCH' | 'BAD_RECEIPT_SIG' | 'NO_STATE';

/** Thrown for every refusal. After payment, `callId` is set so the buyer can claim non-delivery. */
export class CertoError extends Error {
  constructor(readonly code: FailureCode, message: string, readonly callId?: string, readonly contractCode?: string) {
    super(message);
    this.name = 'CertoError';
  }
}

export interface CallOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  /** Highest price accepted, base units. */
  maxPrice?: string;
}

/** A paid, delivered, receipt-checked call: everything needed for any later dispute. */
export interface CallResult {
  callId: string;
  seller: string;
  termsId: string;
  price: string;
  payTx: string;
  status: number;
  /** Response body as UTF-8 text (exact bytes in `bodyBytes`). */
  body: string;
  bodyBytes: Uint8Array;
  headers: Record<string, string>;
  receipt: Receipt;
  requestCanon: string;
  requestHash: string;
}

export interface DisputeRecord {
  callId: string;
  offerBps: number;
  /** hex, keep it: needed to reveal the sealed offer at `resolve` */
  salt: string;
  commit: string;
  stake: string;
  tx: TxResult;
}

export interface ClientOptions {
  chain: BuyerChain;
  fetch?: typeof fetch;
  clock?: Clock;
  /** SDK delivery timeout (section 4.3: 10 s). */
  deliveryTimeoutMs?: number;
  /** Default `maxPrice` for `call`. */
  maxPrice?: string;
}

function headersOf(r: Response): Record<string, string> {
  const h: Record<string, string> = {};
  r.headers.forEach((v, k) => { h[k] = v; });
  return h;
}

/** Buyer SDK (DESIGN.md 4.3, T10). */
export class CertoClient {
  readonly chain: BuyerChain;
  private readonly f: typeof fetch;
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly maxPrice?: string;
  /** Results and sealed offers of this session, by call id. */
  readonly calls = new Map<string, CallResult>();
  readonly disputes = new Map<string, DisputeRecord>();

  constructor(o: ClientOptions) {
    this.chain = o.chain;
    this.f = o.fetch ?? fetch;
    this.clock = o.clock ?? systemClock;
    this.timeoutMs = o.deliveryTimeoutMs ?? 10_000;
    this.maxPrice = o.maxPrice;
  }

  get buyer(): string {
    if (!this.chain.accountId) throw new Error('chain client has no buyer account');
    return this.chain.accountId;
  }

  /** 402 → checks → pay on chain → retry with proof → verify receipt. */
  async call(url: string, opts: CallOptions = {}): Promise<CallResult> {
    const method = (opts.method ?? 'GET').toUpperCase();
    const body = opts.body ?? '';
    const init: RequestInit = { method, headers: { ...opts.headers }, body: method === 'GET' || method === 'HEAD' ? undefined : body };
    const first = await this.f(url, init);
    if (first.status !== 402) throw new CertoError('NOT_PROTECTED', `expected 402, got ${first.status}`);
    const hdr = first.headers.get(HDR_PAYMENT_REQUIRED);
    await first.arrayBuffer().catch(() => undefined);
    if (!hdr) throw new CertoError('NOT_PROTECTED', '402 without PAYMENT-REQUIRED');
    const req = findOurRequirement(decodeHeader<PaymentRequired>(hdr));
    if (!req) throw new CertoError('NO_SCHEME', 'seller does not offer the bonded scheme');
    await this.checkQuote(req, opts.maxPrice ?? this.maxPrice);

    const u = new URL(url);
    const canon = requestCanon(method, u.pathname + u.search, body);
    const requestHash = sha256Hex(canon);
    const { seller, quoteId, termsId } = req.extra;
    const callId = callIdOf(seller, quoteId);
    const tx = await this.chain.pay({ seller, quote_id: quoteId, terms_id: termsId, request_hash: requestHash, amount: req.amount });
    if (!hasEvent(tx, 'call_paid')) {
      const msg = tx.failures.join('; ') || 'no call_paid event';
      throw new CertoError('PAY_FAILED', `payment bounced: ${msg}`, undefined, errorCode(msg));
    }

    const ps: PaymentSignature = { x402Version: 2, accepted: req, payload: { callId, buyer: this.buyer, txHash: tx.txHash } };
    let resp: Response;
    let bytes: Uint8Array;
    try {
      resp = await this.f(url, {
        ...init, headers: { ...opts.headers, [HDR_PAYMENT_SIGNATURE]: encodeHeader(ps) }, signal: AbortSignal.timeout(this.timeoutMs),
      });
      bytes = new Uint8Array(await resp.arrayBuffer());
    } catch (e) {
      throw new CertoError('TIMEOUT', `no delivery within ${this.timeoutMs} ms: ${(e as Error).message}`, callId);
    }
    const prh = resp.headers.get(HDR_PAYMENT_RESPONSE);
    if (!prh) throw new CertoError('NO_RECEIPT', `response ${resp.status} without PAYMENT-RESPONSE`, callId);
    let receipt: Receipt;
    try {
      receipt = decodeHeader<PaymentResponse>(prh).receipt;
    } catch {
      throw new CertoError('NO_RECEIPT', 'malformed PAYMENT-RESPONSE', callId);
    }
    if (!receipt || receipt.callId !== callId) throw new CertoError('NO_RECEIPT', 'receipt is for another call', callId);
    if (receipt.responseHash !== sha256Hex(bytes)) {
      throw new CertoError('RECEIPT_MISMATCH', 'response body hash differs from the receipt; refusing the response', callId);
    }
    if (receipt.statusCode !== resp.status) throw new CertoError('RECEIPT_MISMATCH', 'receipt status differs from the HTTP status', callId);
    const sellerView = await this.chain.getSeller(seller);
    const text = receiptText({
      contract: this.chain.contractId, callId, buyer: this.buyer, price: req.amount, termsId, requestHash,
      responseHash: receipt.responseHash, statusCode: receipt.statusCode, servedAtMs: receipt.servedAtMs,
    });
    if (!sellerView || !verifyBase64(text, receipt.sig, sellerView.receipt_pubkey)) {
      throw new CertoError('BAD_RECEIPT_SIG', 'receipt signature does not verify under the seller key on chain', callId);
    }
    const result: CallResult = {
      callId, seller, termsId, price: req.amount, payTx: tx.txHash, status: resp.status,
      body: Buffer.from(bytes).toString('utf8'), bodyBytes: bytes, headers: headersOf(resp), receipt, requestCanon: canon, requestHash,
    };
    this.calls.set(callId, result);
    return result;
  }

  private async checkQuote(req: PaymentRequirement, maxPrice?: string): Promise<void> {
    if (req.payTo !== this.chain.contractId || req.asset !== this.chain.tokenId) {
      throw new CertoError('WRONG_CONTRACT', `quote pays ${req.payTo}/${req.asset}, expected ${this.chain.contractId}/${this.chain.tokenId}`);
    }
    if (maxPrice !== undefined && BigInt(req.amount) > BigInt(maxPrice)) {
      throw new CertoError('PRICE_TOO_HIGH', `price ${req.amount} > max ${maxPrice}`);
    }
    const [s, t, q] = await Promise.all([
      this.chain.getSeller(req.extra.seller), this.chain.getTerms(req.extra.seller, req.extra.termsId), this.chain.quote(req.extra.seller, req.amount),
    ]);
    if (!s) throw new CertoError('SELLER_UNKNOWN', `seller ${req.extra.seller} is not registered`);
    if (!t) throw new CertoError('TERMS_UNKNOWN', `terms ${req.extra.termsId} not found`);
    if (!q.would_fit) throw new CertoError('WOULD_NOT_FIT', 'seller bond has no free capacity for this call');
  }

  private result(callId: string | CallResult): CallResult {
    const r = typeof callId === 'string' ? this.calls.get(callId) : callId;
    if (!r) throw new CertoError('NO_STATE', `no stored result for ${String(callId)}`);
    return r;
  }

  /** Ruling stake for a call: quote(...).stake × 2^stake_mult_log2 of this buyer. */
  async stakeFor(seller: string, price: string): Promise<string> {
    const [q, b] = await Promise.all([this.chain.quote(seller, price), this.chain.getBuyer(this.buyer)]);
    return (BigInt(q.stake) << BigInt(b?.stake_mult_log2 ?? 0)).toString();
  }

  /** Content dispute with a sealed offer (default 100%). Keep the returned salt. */
  async dispute(call: string | CallResult, opts: { offerBps?: number; salt?: string } = {}): Promise<DisputeRecord> {
    const r = this.result(call);
    const offerBps = opts.offerBps ?? 10000;
    const salt = opts.salt ?? newSalt();
    const commit = offerCommit(offerBps, salt);
    const stake = await this.stakeFor(r.seller, r.price);
    const tx = await this.chain.disputeContent({
      call_id: r.callId, stake, offer_commit: commit, response_hash: r.receipt.responseHash, status_code: r.receipt.statusCode,
      served_at_ms: r.receipt.servedAtMs, sig: r.receipt.sig,
    });
    requireEvent(tx, 'dispute_opened', 'dispute');
    const rec = { callId: r.callId, offerBps, salt, commit, stake, tx };
    this.disputes.set(r.callId, rec);
    return rec;
  }

  /** Rule refund for a signed receipt with status ≥ 500. */
  async claimError(call: string | CallResult): Promise<TxResult> {
    const r = this.result(call);
    return this.chain.claimError({
      call_id: r.callId, response_hash: r.receipt.responseHash, status_code: r.receipt.statusCode, served_at_ms: r.receipt.servedAtMs, sig: r.receipt.sig,
    });
  }

  /** Rule refund for not-JSON / missing field / stale (SHOULD S3). */
  async claimRule(call: string | CallResult): Promise<TxResult> {
    const r = this.result(call);
    return this.chain.claimRule({
      call_id: r.callId, response_hash: r.receipt.responseHash, status_code: r.receipt.statusCode, served_at_ms: r.receipt.servedAtMs,
      sig: r.receipt.sig, response_body: r.body,
    });
  }

  /** Non-delivery claim (no response in time, or no valid receipt). */
  async claimNonDelivery(callId: string): Promise<TxResult> {
    const call = await this.chain.getCall(callId);
    if (!call) throw new CertoError('NO_STATE', `call ${callId} not on chain`);
    const stake = await this.stakeFor(call.seller, call.price);
    const tx = await this.chain.disputeNonDelivery({ call_id: callId, stake });
    requireEvent(tx, 'dispute_opened', 'non-delivery claim');
    return tx;
  }

  /** `resolve_default` after the seller's clock ran out (reveals the sealed offer if this client holds it). */
  async resolveDefault(callId: string): Promise<TxResult> {
    const d = this.disputes.get(callId);
    return this.chain.resolveDefault(d ? { call_id: callId, buyer_offer_bps: d.offerBps, salt: d.salt } : { call_id: callId });
  }

  /** Poll `get_call` until its status is one of `statuses` (or the call is gone → null). */
  async waitForStatus(callId: string, statuses: CallView['status'][], opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<CallView | null> {
    const end = this.clock.now() + (opts.timeoutMs ?? 60_000);
    for (;;) {
      const c = await this.chain.getCall(callId);
      if (!c || statuses.includes(c.status)) return c;
      if (this.clock.now() >= end) throw new Error(`timeout waiting for ${statuses.join('/')} on ${callId} (status ${c.status})`);
      await this.clock.sleep(opts.pollMs ?? 500);
    }
  }

  /** `POST /cases` to a panel service with the evidence and the sealed offer reveal. */
  async submitToPanel(panelUrl: string, callId: string): Promise<unknown> {
    const r = this.result(callId);
    const d = this.disputes.get(callId);
    if (!d) throw new CertoError('NO_STATE', `no dispute stored for ${callId}`);
    const res = await this.f(new URL('/cases', panelUrl), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_id: callId, buyer_offer_bps: d.offerBps, salt: d.salt, request_canon: r.requestCanon, response_body: r.body }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`panel answered ${res.status}: ${JSON.stringify(out)}`);
    return out;
  }
}

function requireEvent(tx: TxResult, name: string, what: string): void {
  if (!hasEvent(tx, name)) {
    const msg = tx.failures.join('; ') || `no ${name} event`;
    throw Object.assign(new Error(`${what} failed: ${msg}`), { contractCode: errorCode(msg), tx });
  }
}
