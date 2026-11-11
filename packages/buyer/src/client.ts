import {
  callIdOf, decodeHeader, DEFAULT_MAX_PRICE, encodeHeader, errorCode, findOurRequirement, formatUsdc, fromBase64, hasEvent,
  HDR_PAYMENT_REQUIRED, HDR_PAYMENT_RESPONSE, HDR_PAYMENT_SIGNATURE, newSalt, offerCommit, parseAmountInput, receiptText,
  requestCanon, sha256Hex, systemClock, toBase64, verifyBase64,
  type CallView, type Clock, type ContractConfig, type CertoChain, type PaymentRequired, type PaymentRequirement,
  type PaymentResponse, type PaymentSignature, type Receipt, type SellerView, type TermsView, type TxResult,
} from '@certo/core';
import { MemoryCallStore, type CallStore, type Outcome, type SavedCall } from './store.js';

export type BuyerChain = Pick<
  CertoChain,
  'contractId' | 'tokenId' | 'accountId' | 'getConfig' | 'getSeller' | 'getTerms' | 'getCall' | 'getBuyer' | 'quote' | 'pay' |
  'claimError' | 'claimRule' | 'disputeNonDelivery' | 'disputeContent' | 'resolveDefault'
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
  /** Highest price accepted for this call: "0.40" / "1 USDC" (USDC) or "400000" (base units). Default: the client's cap. */
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
  kind?: 'content' | 'non_delivery';
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
  /** Price cap for `call` ("1.00", "1 USDC" or base units). Default `CERTO_MAX_PRICE`, else 1.00 USDC. */
  maxPrice?: string;
  /** Where call records and sealed-offer salts persist (default: memory only). */
  store?: CallStore;
}

/** `quote(url)`: a seller's 402 joined with its on-chain record and terms. Amounts in base units. */
export interface QuoteInfo {
  url: string;
  seller: string;
  price: string;
  maxPrice: string;
  withinCap: boolean;
  /** Empty when `call(url)` would go ahead; otherwise why it would refuse. */
  problems: string[];
  feeBps: number;
  windowMs: number;
  /** What this buyer would stake to open a dispute now. */
  disputeStake: string;
  seller_record: Pick<SellerView, 'bond' | 'free_capacity' | 'fee_bps' | 'lifetime_calls' | 'lifetime_losses' | 'lifetime_volume'> | null;
  wouldFit: boolean;
  termsId: string;
  terms: TermsView | null;
}

/** Progress of `settle`: the final outcome, or where it stands when the wait ran out. */
export type Progress =
  | { state: 'final'; outcome: Outcome }
  | { state: 'waiting'; status: CallView['status']; detail: string; nextDeadlineMs?: number }
  | { state: 'no_dispute'; detail: string };

/** `status(callId)`: on-chain record joined with what this client stored. */
export interface StatusInfo {
  callId: string;
  state: 'open' | 'released' | 'in_dispute' | Outcome['result'] | 'unknown';
  detail: string;
  call: CallView | null;
  outcome?: Outcome;
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
  /** Price cap in base units. */
  readonly maxPrice: string;
  readonly store: CallStore;
  /** Results and sealed offers of this session, by call id (also in `store`). */
  readonly calls = new Map<string, CallResult>();
  readonly disputes = new Map<string, DisputeRecord>();
  private cfg?: ContractConfig;

  constructor(o: ClientOptions) {
    this.chain = o.chain;
    this.f = o.fetch ?? fetch;
    this.clock = o.clock ?? systemClock;
    this.timeoutMs = o.deliveryTimeoutMs ?? 10_000;
    this.maxPrice = parseAmountInput(o.maxPrice ?? process.env.CERTO_MAX_PRICE ?? DEFAULT_MAX_PRICE);
    this.store = o.store ?? new MemoryCallStore();
  }

  private saved(callId: string): SavedCall {
    return this.store.load(callId) ?? {};
  }

  private persist(callId: string, patch: Partial<SavedCall>): void {
    this.store.save(callId, { ...this.saved(callId), ...patch });
  }

  private async config(): Promise<ContractConfig> {
    this.cfg ??= await this.chain.getConfig();
    return this.cfg;
  }

  /** Fetch the 402 and decode the bonded-scheme requirement, without paying. */
  private async requirement(url: string, init: RequestInit): Promise<PaymentRequirement> {
    const first = await this.f(url, init);
    if (first.status !== 402) {
      await first.arrayBuffer().catch(() => undefined);
      throw new CertoError('NOT_PROTECTED', `expected 402, got ${first.status}`);
    }
    const hdr = first.headers.get(HDR_PAYMENT_REQUIRED);
    await first.arrayBuffer().catch(() => undefined);
    if (!hdr) throw new CertoError('NOT_PROTECTED', '402 without PAYMENT-REQUIRED');
    const req = findOurRequirement(decodeHeader<PaymentRequired>(hdr));
    if (!req) throw new CertoError('NO_SCHEME', 'seller does not offer the bonded scheme');
    return req;
  }

  private init(opts: CallOptions): RequestInit {
    const method = (opts.method ?? 'GET').toUpperCase();
    return { method, headers: { ...opts.headers }, body: method === 'GET' || method === 'HEAD' ? undefined : opts.body ?? '' };
  }

  /**
   * Look before paying: the seller's 402 joined with `get_seller`, `get_terms` and `quote`.
   * Throws only when the URL is not a bonded endpoint of this contract.
   */
  async quote(url: string, opts: CallOptions = {}): Promise<QuoteInfo> {
    const req = await this.requirement(url, this.init(opts));
    this.checkContract(req);
    const max = opts.maxPrice !== undefined ? parseAmountInput(opts.maxPrice) : this.maxPrice;
    const { seller, termsId } = req.extra;
    const [s, t, q] = await Promise.all([
      this.chain.getSeller(seller), this.chain.getTerms(seller, termsId), this.chain.quote(seller, req.amount).catch(() => null),
    ]);
    const stake = this.chain.accountId && q ? await this.stakeFor(seller, req.amount) : q?.stake ?? '0';
    const problems: string[] = [];
    if (BigInt(req.amount) > BigInt(max)) problems.push(`PRICE_TOO_HIGH: ${priceCapMessage(req.amount, max)}`);
    if (!s) problems.push(`SELLER_UNKNOWN: seller ${seller} is not registered`);
    if (!t) problems.push(`TERMS_UNKNOWN: terms ${termsId} not found`);
    if (s && q && !q.would_fit) problems.push('WOULD_NOT_FIT: the seller bond has no free capacity for this call now');
    return {
      url, seller, price: req.amount, maxPrice: max, withinCap: BigInt(req.amount) <= BigInt(max), problems,
      feeBps: s?.fee_bps ?? req.extra.feeBps, windowMs: s?.window_ms ?? req.extra.windowMs, disputeStake: stake,
      seller_record: s ? {
        bond: s.bond, free_capacity: s.free_capacity, fee_bps: s.fee_bps, lifetime_calls: s.lifetime_calls,
        lifetime_losses: s.lifetime_losses, lifetime_volume: s.lifetime_volume,
      } : null,
      wouldFit: !!q?.would_fit, termsId, terms: t,
    };
  }

  get buyer(): string {
    if (!this.chain.accountId) throw new Error('chain client has no buyer account');
    return this.chain.accountId;
  }

  /** 402 → checks → pay on chain → retry with proof → verify receipt. */
  async call(url: string, opts: CallOptions = {}): Promise<CallResult> {
    const init = this.init(opts);
    const method = init.method!;
    const body = opts.body ?? '';
    const req = await this.requirement(url, init);
    await this.checkQuote(req, opts.maxPrice !== undefined ? parseAmountInput(opts.maxPrice) : this.maxPrice);

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
    this.persist(callId, { paid: { callId, seller, price: req.amount, payTx: tx.txHash, url, atMs: this.clock.now() } });

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
    const { bodyBytes, ...rest } = result;
    this.persist(callId, { result: { ...rest, bodyB64: toBase64(bodyBytes) } });
    return result;
  }

  private checkContract(req: PaymentRequirement): void {
    if (req.payTo !== this.chain.contractId || req.asset !== this.chain.tokenId) {
      throw new CertoError('WRONG_CONTRACT', `quote pays ${req.payTo}/${req.asset}, expected ${this.chain.contractId}/${this.chain.tokenId}`);
    }
  }

  private async checkQuote(req: PaymentRequirement, maxPrice: string): Promise<void> {
    this.checkContract(req);
    if (BigInt(req.amount) > BigInt(maxPrice)) throw new CertoError('PRICE_TOO_HIGH', priceCapMessage(req.amount, maxPrice));
    const [s, t, q] = await Promise.all([
      this.chain.getSeller(req.extra.seller), this.chain.getTerms(req.extra.seller, req.extra.termsId), this.chain.quote(req.extra.seller, req.amount),
    ]);
    if (!s) throw new CertoError('SELLER_UNKNOWN', `seller ${req.extra.seller} is not registered`);
    if (!t) throw new CertoError('TERMS_UNKNOWN', `terms ${req.extra.termsId} not found`);
    if (!q.would_fit) throw new CertoError('WOULD_NOT_FIT', 'seller bond has no free capacity for this call');
  }

  /** The stored call (this session, else the store), or throws `NO_STATE`. */
  result(callId: string | CallResult): CallResult {
    if (typeof callId !== 'string') return callId;
    let r = this.calls.get(callId);
    const s = r ? undefined : this.saved(callId).result;
    if (s) {
      r = { ...(s as unknown as Omit<CallResult, 'bodyBytes'>), bodyBytes: fromBase64(s.bodyB64) };
      delete (r as { bodyB64?: string }).bodyB64;
      this.calls.set(callId, r);
    }
    if (!r) throw new CertoError('NO_STATE', `no stored result for ${callId}: it was not delivered to this client, or was made with another state dir`);
    return r;
  }

  /** The stored dispute of a call (this session, else the store). */
  disputeOf(callId: string): DisputeRecord | undefined {
    const d = this.disputes.get(callId) ?? this.saved(callId).dispute;
    if (d && !this.disputes.has(callId)) this.disputes.set(callId, { ...d, tx: { txHash: '', events: [], logs: [], failures: [] } });
    return this.disputes.get(callId);
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
    const prior = this.saved(r.callId).dispute;
    // the salt is saved before the transaction: without it the sealed offer can never be revealed
    this.persist(r.callId, { dispute: { callId: r.callId, kind: 'content', offerBps, salt, commit, stake } });
    let tx: TxResult;
    try {
      tx = await this.chain.disputeContent({
        call_id: r.callId, stake, offer_commit: commit, response_hash: r.receipt.responseHash, status_code: r.receipt.statusCode,
        served_at_ms: r.receipt.servedAtMs, sig: r.receipt.sig,
      });
      requireEvent(tx, 'dispute_opened', 'dispute');
    } catch (e) {
      this.persist(r.callId, { dispute: prior });
      throw e;
    }
    const rec: DisputeRecord = { callId: r.callId, kind: 'content', offerBps, salt, commit, stake, tx };
    this.disputes.set(r.callId, rec);
    return rec;
  }

  /** Rule refund for a signed receipt with status ≥ 500. */
  async claimError(call: string | CallResult): Promise<TxResult> {
    const r = this.result(call);
    const tx = await this.chain.claimError({
      call_id: r.callId, response_hash: r.receipt.responseHash, status_code: r.receipt.statusCode, served_at_ms: r.receipt.servedAtMs, sig: r.receipt.sig,
    });
    this.recordOutcome(r.callId, tx, r.price, '0');
    return tx;
  }

  /** Rule refund for not-JSON / missing field / stale (SHOULD S3). */
  async claimRule(call: string | CallResult): Promise<TxResult> {
    const r = this.result(call);
    const tx = await this.chain.claimRule({
      call_id: r.callId, response_hash: r.receipt.responseHash, status_code: r.receipt.statusCode, served_at_ms: r.receipt.servedAtMs,
      sig: r.receipt.sig, response_body: r.body,
    });
    this.recordOutcome(r.callId, tx, r.price, '0');
    return tx;
  }

  /** Non-delivery claim (no response in time, or no valid receipt). */
  async claimNonDelivery(callId: string): Promise<TxResult> {
    const call = await this.chain.getCall(callId);
    if (!call) throw new CertoError('NO_STATE', `call ${callId} not on chain`);
    const stake = await this.stakeFor(call.seller, call.price);
    const tx = await this.chain.disputeNonDelivery({ call_id: callId, stake });
    requireEvent(tx, 'dispute_opened', 'non-delivery claim');
    const rec: DisputeRecord = { callId, kind: 'non_delivery', offerBps: 10000, salt: '', commit: '', stake, tx };
    this.disputes.set(callId, rec);
    this.persist(callId, { dispute: { callId, kind: 'non_delivery', offerBps: 10000, salt: '', commit: '', stake } });
    return tx;
  }

  /** `resolve_default` after the seller's clock ran out (reveals the sealed offer if this client holds it). */
  async resolveDefault(callId: string): Promise<TxResult> {
    const d = this.disputeOf(callId);
    const reveal = d && d.kind !== 'non_delivery' && d.salt;
    const call = await this.chain.getCall(callId);
    const tx = await this.chain.resolveDefault(reveal ? { call_id: callId, buyer_offer_bps: d.offerBps, salt: d.salt } : { call_id: callId });
    if (call) this.recordOutcome(callId, tx, call.price, d?.stake ?? call.dispute?.stake ?? '0');
    return tx;
  }

  /** Store the outcome carried by a `dispute_resolved` event, if the transaction has one. */
  private recordOutcome(callId: string, tx: { txHash?: string; events?: TxResult['events'] }, price: string, stake: string, panel?: Outcome['panel']): Outcome | undefined {
    const o = outcomeOf(tx, price, stake, this.clock.now(), panel);
    if (o) this.persist(callId, { outcome: o });
    return o;
  }

  /**
   * Follow a dispute to its end: wait for the seller's answer or cure, send the
   * case to the panel (if `panelUrl`), and call `resolve_default` once a
   * deadline has passed. Returns the final outcome, or after `maxWaitMs`
   * where it stands (call again to continue).
   */
  async settle(callId: string, o: { panelUrl?: string; maxWaitMs?: number; pollMs?: number } = {}): Promise<Progress> {
    const start = this.clock.now();
    const maxWait = o.maxWaitMs ?? 90_000;
    let note = '';
    for (;;) {
      const saved = this.saved(callId);
      if (saved.outcome) return { state: 'final', outcome: saved.outcome };
      const d = this.disputeOf(callId);
      const c = await this.chain.getCall(callId);
      const now = this.clock.now();
      if (!c) {
        if (!d) return { state: 'no_dispute', detail: 'call not on chain and no dispute stored by this client' };
        const outcome: Outcome = {
          result: 'settled_elsewhere', refund: '0', stakeBack: '0', stakeLost: '0', tier: 'unknown', atMs: now,
          reason: 'the dispute was settled by a transaction this client did not see; check your token balance',
        };
        return { state: 'final', outcome };
      }
      if (c.status === 'Open') {
        if (d?.kind === 'non_delivery') {
          const outcome: Outcome = { result: 'cured', refund: '0', stakeBack: d.stake, stakeLost: '0', tier: 'cure', atMs: now,
            reason: 'the seller published the response with a valid receipt; your stake was returned' };
          this.persist(callId, { outcome });
          return { state: 'final', outcome };
        }
        return { state: 'no_dispute', detail: 'no dispute is open on this call' };
      }
      const cfg = await this.config();
      const disp = c.dispute!;
      let deadline: number;
      let detail: string;
      if (c.status === 'Answered') {
        deadline = disp.answered_at_ms + cfg.panel_deadline_ms;
        const offer = `seller offered ${(disp.seller_offer_bps ?? 0) / 100}%`;
        if (o.panelUrl && d?.salt && !saved.panelSent) {
          this.persist(callId, { panelSent: true });
          try {
            const out = (await this.submitToPanel(o.panelUrl, callId)) as { events?: TxResult['events']; txHash?: string; reason?: string; mode?: string; synthetic?: boolean };
            const got = this.recordOutcome(callId, out, c.price, d.stake, { mode: out.mode, synthetic: out.synthetic });
            if (got) return { state: 'final', outcome: got };
            note = `; panel: ${out.reason ?? 'no verdict submitted'}`;
          } catch (e) {
            note = `; panel error: ${(e as Error).message}`;
          }
        }
        detail = `${offer}; waiting for the panel verdict, else the timeout default at ${iso(deadline)}${note}`;
      } else {
        deadline = disp.opened_at_ms + cfg.answer_ms;
        detail = `waiting for the seller to ${c.status === 'Disputed' ? 'answer' : 'cure'} by ${iso(deadline)}; after that, a full refund by default`;
      }
      if (now > deadline + 1000) {
        try {
          const tx = await this.resolveDefault(callId);
          const got = this.saved(callId).outcome;
          if (got) return { state: 'final', outcome: got };
          note = `; resolve_default ${tx.txHash} gave no outcome`;
        } catch (e) {
          const code = errorCode((e as Error).message);
          if (code !== 'E_TOO_EARLY' && code !== 'E_STATUS') note = `; resolve_default failed: ${(e as Error).message}`;
        }
      }
      const left = maxWait - (this.clock.now() - start);
      if (left <= 0) return { state: 'waiting', status: c.status, detail, nextDeadlineMs: deadline };
      await this.clock.sleep(Math.min(o.pollMs ?? 1000, left));
    }
  }

  /** What happened to a call: open, released to the seller, in dispute, refunded, or unknown to this client. */
  async status(callId: string): Promise<StatusInfo> {
    const saved = this.saved(callId);
    const c = await this.chain.getCall(callId);
    const now = this.clock.now();
    const base = { callId, call: c };
    if (c && c.status === 'Open') {
      if (saved.dispute?.kind === 'non_delivery' && !saved.outcome) await this.settle(callId, { maxWaitMs: 0 });
      const o = this.saved(callId).outcome;
      if (o) return { ...base, state: o.result, detail: describeOutcome(o), outcome: o };
      if (now <= c.expires_at_ms) {
        return { ...base, state: 'open', detail: `paid; refund window open until ${iso(c.expires_at_ms)} (${Math.ceil((c.expires_at_ms - now) / 1000)} s left)` };
      }
      return { ...base, state: 'released', detail: `refund window closed at ${iso(c.expires_at_ms)}; the seller keeps the payment` };
    }
    if (c) {
      const due = c.status === 'Answered' ? 'the panel verdict' : `the seller's ${c.status === 'Disputed' ? 'answer' : 'cure'}`;
      return { ...base, state: 'in_dispute', detail: `${c.status}: waiting for ${due}; certo_dispute with this call_id follows it to the end` };
    }
    if (saved.outcome) return { ...base, state: saved.outcome.result, detail: describeOutcome(saved.outcome), outcome: saved.outcome };
    if (saved.dispute) return { ...base, state: 'settled_elsewhere', detail: 'the dispute was settled by a transaction this client did not see; check your token balance' };
    if (saved.paid) return { ...base, state: 'released', detail: `paid ${formatUsdc(saved.paid.price)} USDC; window closed with no refund, the seller kept the payment` };
    return { ...base, state: 'unknown', detail: 'not on chain and no local record: never paid by this client (or settled from another machine)' };
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
    const d = this.disputeOf(callId);
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

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function priceCapMessage(price: string, max: string): string {
  return `price ${formatUsdc(price)} USDC is above the cap ${formatUsdc(max)} USDC (CERTO_MAX_PRICE or max_price; "0.50" or "1 USDC" is USDC, a bare integer is base units)`;
}

/** Outcome from a transaction's `dispute_resolved` event (or undefined if it has none). */
export function outcomeOf(
  tx: { txHash?: string; events?: TxResult['events'] }, price: string, stake: string, atMs: number, panel?: Outcome['panel'],
): Outcome | undefined {
  const e = tx.events?.find((x) => x.event === 'dispute_resolved');
  if (!e) return undefined;
  const d = e.data as Record<string, unknown>;
  const refund = String(d.refund ?? '0');
  const stakeBack = d.to_buyer !== undefined ? (BigInt(String(d.to_buyer)) - BigInt(refund)).toString() : String(d.stake_returned ?? '0');
  const lost = BigInt(stake) - BigInt(stakeBack);
  const r = BigInt(refund);
  return {
    result: r === 0n ? 'not_refunded' : r >= BigInt(price) ? 'refunded' : 'partly_refunded',
    refund, stakeBack, stakeLost: (lost > 0n ? lost : 0n).toString(), tier: String(d.tier ?? 'unknown'),
    reason: d.reason as string | undefined, winner: d.winner as string | undefined, votes: d.votes as string[] | undefined,
    tx: tx.txHash, atMs, ...(panel?.mode ? { panel } : {}),
  };
}

/** One sentence for an outcome. */
export function describeOutcome(o: Outcome): string {
  const money = `refund ${formatUsdc(o.refund)} USDC, stake back ${formatUsdc(o.stakeBack)}, stake lost ${formatUsdc(o.stakeLost)}`;
  const how = o.tier === 'panel' ? `panel verdict for the ${o.winner} (${(o.votes ?? []).join('/')})` : `${o.tier}${o.reason ? ` (${o.reason})` : ''}`;
  return o.result === 'cured' || o.result === 'settled_elsewhere' ? o.reason ?? o.result : `${o.result}: ${money}; ${how}`;
}
