/**
 * Shapes of contract views, call arguments and events (section 4.2).
 * Token amounts (u128) are decimal-integer strings. 32-byte hashes are
 * normalised to lower-case hex by the chain wrapper whatever the contract's
 * serialisation; signatures are base64.
 */
export type U128 = string;

/** `get_config()` flattened: the contract's `cfg` fields plus owner/token/resolver/treasury. */
export interface ContractConfig {
  owner?: string;
  token?: string;
  resolver?: string;
  treasury?: U128;
  min_bond: U128;
  min_price: U128;
  window_min_ms?: number;
  window_max_ms?: number;
  answer_ms: number;
  resolver_exclusive_ms: number;
  panel_deadline_ms: number;
  stake_min: U128;
  stake_bps: number;
  max_terms: number;
  max_request: number;
  max_response: number;
  [k: string]: unknown;
}

export interface JurorView {
  model_id: string;
  /** hex */
  pubkey: string;
  /** hex */
  attestation_sha256: string;
}

export interface JurorsView {
  jurors: JurorView[];
  gateway_key: string | null;
  epoch: number;
}

export interface SellerView {
  bond: U128;
  reserved: U128;
  disputed_reserved: U128;
  free_capacity: U128;
  fee_bps: number;
  window_ms: number;
  lifetime_calls: number;
  lifetime_losses: number;
  lifetime_volume: U128;
  /** hex */
  receipt_pubkey: string;
  [k: string]: unknown;
}

export interface TermsView {
  text: string;
  required_fields: string[];
  as_of_field: string | null;
  max_age_s: number | null;
  panel: boolean;
}

export type CallStatus = 'Open' | 'NonDeliveryClaimed' | 'Disputed' | 'Answered';

export interface DisputeView {
  opened_at_ms: number;
  stake: U128;
  buyer_commit: string;
  response_hash: string;
  status_code: number;
  served_at_ms: number;
  seller_offer_bps: number | null;
  answered_at_ms: number;
}

export interface CallView {
  buyer: string;
  seller: string;
  terms_id: string;
  price: U128;
  fee: U128;
  reserve: U128;
  /** hex */
  request_hash: string;
  paid_at_ms: number;
  expires_at_ms: number;
  status: CallStatus;
  dispute: DisputeView | null;
}

export interface BuyerView {
  disputes_won: number;
  disputes_lost: number;
  stake_mult_log2: number;
}

export interface QuoteView {
  fee: U128;
  stake: U128;
  would_fit: boolean;
}

/** Ballot argument of `resolve` (section 4.2). */
export interface ContractBallot {
  response_body: string;
  /** base64 of the 64-byte ed25519 signature */
  signature: string;
  kind: 'provider_tee' | 'gateway';
}

/** NEP-297 event as logged by the contract. */
export interface ContractEvent<D = Record<string, unknown>> {
  standard: string;
  version: string;
  event: string;
  data: D;
}

export type EventName =
  | 'seller_registered' | 'bond_changed' | 'terms_added' | 'call_paid' | 'call_released'
  | 'dispute_opened' | 'dispute_answered' | 'cured' | 'ballots_verified' | 'dispute_resolved'
  | 'fee_tier_changed' | 'jurors_set' | 'resolver_set';

/** Signed receipt as carried in `PAYMENT-RESPONSE`. */
export interface Receipt {
  callId: string;
  responseHash: string;
  statusCode: number;
  servedAtMs: number;
  /** base64 ed25519 signature over `receiptText(...)` */
  sig: string;
}

/** One recorded or synthetic juror answer: `fixtures/panel/<sha256 of request body>.json` (section 4.4). */
export interface PanelRecording {
  model: string;
  request_body: string;
  response_body_b64: string;
  chat_id: string;
  signature: {
    text: string;
    signature: string;
    signing_address: string;
    signing_algo: 'ed25519' | string;
    signature_kind: 'provider_tee' | 'gateway';
  };
  latency_ms: number;
  recorded_at: string;
  /** true when made by `makeSyntheticBallot` with a test key, not by NEAR AI */
  synthetic?: boolean;
}
