import { callIdOf, sha256Hex } from './encode.js';
import { feeFor, stakeFor } from './amount.js';
import type { CertoChain, TxResult } from './chain.js';
import type { CallView, ContractEvent, SellerView, TermsView } from './types.js';
import { EVENT_STANDARD, EVENT_VERSION } from './brand.js';

/**
 * In-memory stand-in for the contract, for unit tests of the TS packages only.
 * It models just enough state (sellers, terms, calls, statuses) to drive the
 * protocol; it is NOT a reference implementation of the contract.
 */
export class FakeChain implements CertoChain {
  contractId = 'certo.test.near';
  tokenId = 'usdc.test.near';
  network = 'near:sandbox';
  sellers = new Map<string, SellerView>();
  terms = new Map<string, TermsView>();
  calls = new Map<string, CallView>();
  log: Array<{ method: string; args: unknown; signer?: string }> = [];
  now = 1_794_300_000_000;
  private n = 0;

  constructor(public accountId?: string, private shared?: FakeChain) {
    if (shared) {
      this.sellers = shared.sellers; this.terms = shared.terms; this.calls = shared.calls; this.log = shared.log;
      this.contractId = shared.contractId; this.tokenId = shared.tokenId;
    }
  }
  /** Same state, another signer. */
  as(accountId: string): FakeChain { return new FakeChain(accountId, this.shared ?? this); }
  private get clockNow(): number { return (this.shared ?? this).now; }

  private tx(method: string, args: unknown, events: ContractEvent[] = [], failures: string[] = []): TxResult {
    this.log.push({ method, args, signer: this.accountId });
    return { txHash: `tx${++this.n}-${method}`, events, logs: [], failures };
  }
  private ev(event: string, data: Record<string, unknown>): ContractEvent {
    return { standard: EVENT_STANDARD, version: EVENT_VERSION, event, data };
  }

  addSeller(id: string, receiptPubkeyHex: string, bond = '50000000', fee_bps = 100, window_ms = 120_000) {
    this.sellers.set(id, {
      bond, reserved: '0', disputed_reserved: '0', free_capacity: bond, fee_bps, window_ms, lifetime_calls: 0,
      lifetime_losses: 0, lifetime_volume: '0', receipt_pubkey: receiptPubkeyHex,
    });
  }
  addTermsFor(seller: string, termsId: string, text: string, panel = true) {
    this.terms.set(`${seller}|${termsId}`, { text, required_fields: [], as_of_field: null, max_age_s: null, panel });
  }

  async getConfig() { return { min_bond: '1000000', min_price: '10000', answer_ms: 5000, resolver_exclusive_ms: 60000, panel_deadline_ms: 300000, stake_min: '20000', stake_bps: 500, max_terms: 1024, max_request: 1024, max_response: 6144 }; }
  async getJurors() { return { jurors: [], gateway_key: null, epoch: 1 }; }
  async getSeller(id: string) { return this.sellers.get(id) ?? null; }
  async getTerms(seller: string, termsId: string) { return this.terms.get(`${seller}|${termsId}`) ?? null; }
  async getCall(callId: string) { const c = this.calls.get(callId); return c ? structuredClone(c) : null; }
  async getBuyer() { return { disputes_won: 0, disputes_lost: 0, stake_mult_log2: 0 }; }
  async quote(seller: string, price: string) {
    const s = this.sellers.get(seller);
    const stake = stakeFor(price);
    return { fee: feeFor(price, s?.fee_bps ?? 100), stake, would_fit: !!s && BigInt(s.free_capacity) >= BigInt(price) + BigInt(stake) };
  }
  async buildPanelRequest(): Promise<string> { throw new Error('FakeChain.buildPanelRequest: not modelled'); }
  async receiptText(): Promise<string> { throw new Error('not modelled'); }
  async claimableOf() { return '0'; }
  async ftBalanceOf() { return '0'; }

  async registerSeller(a: unknown) { return this.tx('register_seller', a); }
  async depositBond(a: string) { return this.tx('bond', a); }
  async addTerms(a: unknown) { return this.tx('add_terms', a); }
  async withdrawBond(a: string) { return this.tx('withdraw_bond', a); }
  async answer(callId: string, offerBps: number) {
    const c = this.calls.get(callId);
    if (!c || c.status !== 'Disputed' || !c.dispute) throw new Error('E_STATUS');
    c.status = 'Answered'; c.dispute.seller_offer_bps = offerBps; c.dispute.answered_at_ms = this.clockNow;
    return this.tx('answer', { call_id: callId, offer_bps: offerBps }, [this.ev('dispute_answered', { call_id: callId, seller_offer_bps: offerBps })]);
  }
  async cure(a: { call_id: string; response_hash: string; response_body: string }) {
    const c = this.calls.get(a.call_id);
    if (!c || c.status !== 'NonDeliveryClaimed') throw new Error('E_STATUS');
    if (sha256Hex(a.response_body) !== a.response_hash) throw new Error('E_EVIDENCE_HASH');
    c.status = 'Open'; c.dispute = null;
    return this.tx('cure', a, [this.ev('cured', { call_id: a.call_id })]);
  }
  async pay(a: { seller: string; quote_id: string; terms_id: string; request_hash: string; amount: string }) {
    const id = callIdOf(a.seller, a.quote_id);
    const s = this.sellers.get(a.seller);
    if (!s) return this.tx('pay', a, [], ['E_NOT_REGISTERED']);
    if (this.calls.has(id)) return this.tx('pay', a, [], ['E_DUP_CALL']);
    const q = await this.quote(a.seller, a.amount);
    if (!q.would_fit) return this.tx('pay', a, [], ['{"ActionError":{"kind":{"FunctionCallError":{"ExecutionError":"Smart contract panicked: E_EXPOSURE"}}}}']);
    this.calls.set(id, {
      buyer: this.accountId ?? 'buyer.test.near', seller: a.seller, terms_id: a.terms_id, price: a.amount, fee: q.fee,
      reserve: String(BigInt(a.amount) + BigInt(q.stake)), request_hash: a.request_hash, paid_at_ms: this.clockNow,
      expires_at_ms: this.clockNow + s.window_ms, status: 'Open', dispute: null,
    });
    return this.tx('pay', a, [this.ev('call_paid', { call_id: id, price: a.amount, fee: q.fee })]);
  }
  private openDispute(callId: string, stake: string, status: 'Disputed' | 'NonDeliveryClaimed', extra: Partial<NonNullable<CallView['dispute']>>) {
    const c = this.calls.get(callId);
    if (!c) throw new Error('E_STATUS');
    if (c.status !== 'Open') return ['E_STATUS'];
    c.status = status;
    c.dispute = { opened_at_ms: this.clockNow, stake, buyer_commit: '', response_hash: '', status_code: 0, served_at_ms: 0, seller_offer_bps: null, answered_at_ms: 0, ...extra };
    return [];
  }
  async claimError(a: { call_id: string; status_code: number }) {
    if (a.status_code < 500) throw new Error('E_HTTP_STATUS');
    this.calls.delete(a.call_id);
    return this.tx('claim_error', a, [this.ev('dispute_resolved', { call_id: a.call_id, tier: 'rule', reason: 'seller_error' })]);
  }
  async claimRule(a: { call_id: string }) { return this.tx('claim_rule', a); }
  async disputeNonDelivery(a: { call_id: string; stake: string }) {
    const f = this.openDispute(a.call_id, a.stake, 'NonDeliveryClaimed', {});
    return this.tx('dispute_non_delivery', a, f.length ? [] : [this.ev('dispute_opened', { call_id: a.call_id, kind: 'non_delivery' })], f);
  }
  async disputeContent(a: { call_id: string; stake: string; offer_commit: string; response_hash: string; status_code: number; served_at_ms: number; sig: string }) {
    const f = this.openDispute(a.call_id, a.stake, 'Disputed', { buyer_commit: a.offer_commit, response_hash: a.response_hash, status_code: a.status_code, served_at_ms: a.served_at_ms });
    return this.tx('dispute_content', a, f.length ? [] : [this.ev('dispute_opened', { call_id: a.call_id, kind: 'content' })], f);
  }
  async release(seller: string, max: number) { return this.tx('release', { seller, max }); }
  async resolve(a: { call_id: string }) {
    this.calls.delete(a.call_id);
    return this.tx('resolve', a, [this.ev('dispute_resolved', { call_id: a.call_id, tier: 'panel' })]);
  }
  async resolveDefault(a: { call_id: string }) { return this.tx('resolve_default', a); }
  async withdrawClaimable() { return this.tx('withdraw_claimable', {}); }
}
