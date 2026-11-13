import { Account } from '@near-js/accounts';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner, type Signer } from '@near-js/signers';
import { actionCreators, createTransaction } from '@near-js/transactions';
import type { KeyPairString } from '@near-js/crypto';
import { fromBase64, toHex } from './encode.js';
import { base58Decode, base58Encode } from './signing.js';
import { errorCode, parseEvents } from './events.js';
import type {
  BuyerView, CallView, ContractBallot, ContractConfig, ContractEvent, JurorsView, QuoteView, SellerView, TermsView,
} from './types.js';

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;
export const ONE_NEAR = 10n ** 24n;

/** Result of a signed transaction. */
export interface TxResult {
  txHash: string;
  events: ContractEvent[];
  logs: string[];
  /** Panic / action-error messages from any receipt (e.g. a bounced `ft_on_transfer`). */
  failures: string[];
  /** Decoded SuccessValue of the transaction, if JSON. */
  value?: unknown;
}

export class ContractError extends Error {
  constructor(message: string, readonly code: string | undefined, readonly tx?: TxResult) {
    super(message);
    this.name = 'ContractError';
  }
}

/** Receipt fields as the contract takes them (it rebuilds the text itself). */
export interface ReceiptArgs {
  response_hash: string;
  status_code: number;
  served_at_ms: number;
  /** base64 */
  sig: string;
}

export interface BuildPanelRequestArgs {
  juror_idx: number;
  terms_text: string;
  request_canon: string;
  response_body: string;
  buyer_bps: number;
  seller_bps: number;
}

/**
 * Every contract method of section 4.2 plus the token calls the protocol needs.
 * Calls are signed by the account the implementation was built with.
 * Inject a fake of (a `Pick` of) this interface in unit tests.
 */
export interface CertoChain {
  readonly contractId: string;
  readonly tokenId: string;
  /** Account that signs calls (undefined for a view-only client). */
  readonly accountId?: string;
  /** Network label for x402, e.g. `near:testnet` or `near:sandbox`. */
  readonly network: string;

  // views
  getConfig(): Promise<ContractConfig>;
  getJurors(): Promise<JurorsView>;
  getSeller(id: string): Promise<SellerView | null>;
  getTerms(seller: string, termsId: string): Promise<TermsView | null>;
  getCall(callId: string): Promise<CallView | null>;
  getBuyer(id: string): Promise<BuyerView | null>;
  quote(seller: string, price: string): Promise<QuoteView>;
  buildPanelRequest(args: BuildPanelRequestArgs): Promise<string>;
  receiptText(args: { call_id: string; response_hash: string; status_code: number; served_at_ms: number }): Promise<string>;
  claimableOf(id: string): Promise<string>;
  ftBalanceOf(id: string): Promise<string>;

  // seller
  registerSeller(args: { receipt_pubkey: string; window_ms: number }, depositYocto?: bigint): Promise<TxResult>;
  depositBond(amount: string): Promise<TxResult>;
  addTerms(args: { terms_id: string; text: string; required_fields: string[]; as_of_field: string | null; max_age_s: number | null; panel: boolean }): Promise<TxResult>;
  withdrawBond(amount: string): Promise<TxResult>;
  answer(callId: string, offerBps: number): Promise<TxResult>;
  cure(args: { call_id: string; response_body: string } & ReceiptArgs): Promise<TxResult>;

  // buyer
  pay(args: { seller: string; quote_id: string; terms_id: string; request_hash: string; amount: string }): Promise<TxResult>;
  claimError(args: { call_id: string } & ReceiptArgs): Promise<TxResult>;
  claimRule(args: { call_id: string; response_body: string } & ReceiptArgs): Promise<TxResult>;
  disputeNonDelivery(args: { call_id: string; stake: string }): Promise<TxResult>;
  disputeContent(args: { call_id: string; stake: string; offer_commit: string } & ReceiptArgs): Promise<TxResult>;

  // anyone
  release(seller: string, max: number): Promise<TxResult>;
  resolve(args: {
    call_id: string; buyer_offer_bps: number; salt: string; request_canon: string; response_body: string; ballots: ContractBallot[];
  }): Promise<TxResult>;
  resolveDefault(args: { call_id: string; buyer_offer_bps?: number; salt?: string }): Promise<TxResult>;
  withdrawClaimable(): Promise<TxResult>;
}

/** Normalise a 32-byte value the contract may serialise as hex, base64 or a byte array. */
export function toHex32(v: unknown): string {
  if (Array.isArray(v)) return toHex(Uint8Array.from(v as number[]));
  if (typeof v === 'string') {
    const h = v.startsWith('0x') ? v.slice(2) : v;
    if (/^[0-9a-fA-F]{64}$/.test(h)) return h.toLowerCase();
    const b = fromBase64(v);
    if (b.length === 32) return toHex(b);
  }
  throw new Error(`not a 32-byte value: ${JSON.stringify(v)?.slice(0, 80)}`);
}

function normCall(c: CallView | null): CallView | null {
  if (!c) return c;
  const out: CallView = { ...c, request_hash: toHex32(c.request_hash), price: String(c.price), fee: String(c.fee), reserve: String(c.reserve) };
  if (c.dispute) {
    out.dispute = {
      ...c.dispute,
      stake: String(c.dispute.stake),
      response_hash: toHex32(c.dispute.response_hash),
      buyer_commit: c.dispute.buyer_commit ? toHex32(c.dispute.buyer_commit) : c.dispute.buyer_commit,
    };
  }
  return out;
}

function normSeller(s: SellerView | null): SellerView | null {
  return s ? { ...s, receipt_pubkey: toHex32(s.receipt_pubkey) } : s;
}

function normJurors(v: unknown): JurorsView {
  const raw = v as { jurors?: unknown[]; gateway_key?: unknown; epoch?: number; juror_epoch?: number } | unknown[];
  const list = (Array.isArray(raw) ? raw : raw.jurors ?? []) as Array<{ model_id: string; pubkey: unknown; attestation_sha256: unknown }>;
  const obj = Array.isArray(raw) ? {} : raw;
  return {
    jurors: list.map((j) => ({ model_id: j.model_id, pubkey: toHex32(j.pubkey), attestation_sha256: toHex32(j.attestation_sha256) })),
    gateway_key: obj.gateway_key == null ? null : toHex32(obj.gateway_key),
    epoch: obj.epoch ?? obj.juror_epoch ?? 0,
  };
}

export interface NearChainOptions {
  rpcUrl: string;
  contractId: string;
  tokenId: string;
  network?: string;
  /** Signing account; omit for a view-only client. */
  accountId?: string;
  /** `ed25519:<base58>` secret key, e.g. from `.env` or a near-workspaces `KeyPair.toString()`. */
  privateKey?: string;
  /** Alternatively, any @near-js signer. */
  signer?: Signer;
}

/** Longest `signAndSend` waits for one transaction to execute, across all its retries. */
export const TX_TIMEOUT_MS = 60_000;

/** The transaction was signed and sent but not seen executed within the time limit; it may still execute. */
export class TxTimeoutError extends Error {
  readonly type = 'TxTimeout';
  constructor(readonly txHash: string, timeoutMs: number) {
    super(`transaction ${txHash} not executed within ${timeoutMs / 1000} s; it may still execute, so check its status by hash before sending it again`);
    this.name = 'TxTimeoutError';
  }
}

type SendParams = { receiverId: string; actions: Parameters<Account['createTransaction']>[1]; throwOnFailure?: boolean };
type Outcome = Awaited<ReturnType<JsonRpcProvider['sendTransactionUntil']>>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `p`, or a `TxTimeoutError` for `hash` once `deadline` (ms since epoch) has passed. */
function within<T>(p: Promise<T>, deadline: number, hash: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TxTimeoutError(hash, timeoutMs)), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * Whether the node gave no verdict on the transaction (HTTP 408 `TIMEOUT_ERROR`, 5xx, a dropped
 * connection), as opposed to rejecting it (`InvalidChain`, `InvalidNonce`, ...), which means it
 * was never admitted.
 */
/** True if a public RPC refused the request for its rate limit (fastnear answers JSON-RPC code -429). */
export function isRateLimited(err: unknown): boolean {
  const e = err as { cause?: unknown; message?: string; code?: unknown };
  return e?.cause === 429 || e?.code === -429 || /rate limit|\b-?429\b/i.test(String(e?.message ?? err));
}

/** A dropped connection or a gateway error on the way to a public RPC (worth repeating a read). */
function isTransient(err: unknown): boolean {
  const e = err as { cause?: unknown; message?: string };
  return [502, 503, 504].includes(e?.cause as number) || /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(String(e?.message ?? err));
}

/**
 * Calls `fn` (a read: safe to repeat), waiting 1, 2, 4 and 8 s after a rate-limit refusal or a
 * dropped connection from a public RPC; other errors pass through. Not for sending transactions:
 * `signAndSend` has its own rules for that.
 */
export async function rateLimitRetry<T>(fn: () => Promise<T>, waitsMs: number[] = [1000, 2000, 4000, 8000]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= waitsMs.length || !(isRateLimited(err) || isTransient(err))) throw err;
      await sleep(waitsMs[i]!);
    }
  }
}

function noVerdict(err: unknown): boolean {
  const e = err as { cause?: unknown; type?: string; message?: string };
  if (e?.type === 'RetriesExceeded' || isRateLimited(err)) return true;
  if (e?.type) return /timeout/i.test(`${e.type} ${e.message}`);
  return [408, 500, 502, 503, 504].includes(e?.cause as number) || /timeout|fetch|ECONN|socket/i.test(String(e?.message ?? err));
}

/** Rejections proving the transaction was never admitted, so signing it again cannot execute it twice. */
function neverAdmitted(err: unknown): boolean {
  const e = err as { type?: string; message?: string };
  return e?.type === 'InvalidChain' || e?.type === 'Expired' || /Transaction has expired/.test(String(e?.message ?? ''));
}

/**
 * Sign `params` once and send it with a bounded total time (`timeoutMs`, default
 * `TX_TIMEOUT_MS`). Each RPC request is made once (no near-js back-off). When the node gives no
 * verdict (the nearcore 2.10 sandbox answers `send_tx` with `TIMEOUT_ERROR` under load), the
 * transaction's status is looked up by hash and, if the node does not know it, the **same signed
 * bytes** are sent again: one nonce, one hash, so it can never execute twice. Past the deadline it
 * throws `TxTimeoutError` with the hash. Only a rejection that proves the transaction was never
 * admitted, `InvalidChain` ("parent block hash doesn't belong to the current chain", seen on the
 * 2.10.0 sandbox with many concurrent transactions) or `Expired` (its block hash fell out of the
 * validity window, seen right after `sandbox_fast_forward`), leads to signing again (fresh block
 * hash and nonce), at most `tries` times. With `throwOnFailure` (default) a failed execution throws.
 * The transaction references the latest **final** block (near-js uses the optimistic head, which
 * the 2.10.0 sandbox sometimes never makes canonical: `InvalidChain`, or a transaction it accepts
 * and never executes).
 */
export async function signAndSend(account: Account, params: SendParams, o: { tries?: number; timeoutMs?: number } = {}): Promise<Outcome> {
  const { tries = 4, timeoutMs = TX_TIMEOUT_MS } = o;
  const deadline = Date.now() + timeoutMs;
  const signer = account.getSigner();
  if (!signer) throw new Error('signAndSend: the account has no signer');
  // a provider that makes each request once; the loop below decides what to retry
  const rpc = new JsonRpcProvider((account.provider as JsonRpcProvider).connection, { retries: 1 });
  for (let i = 1; ; i++) {
    const tx = await within(buildTx(account, params), deadline, '(not signed yet)', timeoutMs);
    const [hashBytes, signed] = await signer.signTransaction(tx);
    const hash = base58Encode(hashBytes);
    let outcome: Outcome;
    try {
      outcome = await within(sendUntilExecuted(rpc, account.accountId, hash, signed, deadline, waitLevelFor(rpc)), deadline, hash, timeoutMs);
    } catch (err) {
      if (i < tries && neverAdmitted(err)) {
        await sleep(300 * i);
        continue;
      }
      throw err;
    }
    const status = outcome.status as { Failure?: unknown };
    if (params.throwOnFailure !== false && typeof status === 'object' && status.Failure) {
      throw Object.assign(new Error(`transaction ${hash} failed: ${JSON.stringify(status.Failure)}`), { type: 'TxFailure', outcome });
    }
    return outcome;
  }
}

/** Unsigned transaction: next nonce of the signer's key, latest final block hash. */
async function buildTx(account: Account, params: SendParams) {
  const pk = await account.getSigner()!.getPublicKey();
  const [key, block] = await Promise.all([
    rateLimitRetry(() => account.provider.viewAccessKey(account.accountId, pk, { finality: 'optimistic' })),
    rateLimitRetry(() => account.provider.viewBlock({ finality: 'final' })),
  ]);
  return createTransaction(account.accountId, pk, params.receiverId, BigInt(key.nonce) + 1n, params.actions, base58Decode(block.header.hash));
}

/** Send `signed` and wait for its execution; on no verdict, look it up by hash, else resend the same bytes. */
/**
 * How long to wait for a transaction. On the local sandbox, `EXECUTED_OPTIMISTIC`. On a public
 * network (any RPC that is not localhost), `FINAL`: testnet RPC endpoints are load-balanced, and a
 * read sent right after an optimistic execution can reach a node that has not seen it yet
 * (seen as "Cannot find contract code" and a missing seller right after `register_seller`).
 */
export function waitLevelFor(rpc: JsonRpcProvider): 'EXECUTED_OPTIMISTIC' | 'FINAL' {
  return /\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(rpc.connection.url) ? 'EXECUTED_OPTIMISTIC' : 'FINAL';
}

async function sendUntilExecuted(rpc: JsonRpcProvider, sender: string, hash: string, signed: Parameters<JsonRpcProvider['sendTransactionUntil']>[0], deadline: number, wait: 'EXECUTED_OPTIMISTIC' | 'FINAL' = 'EXECUTED_OPTIMISTIC'): Promise<Outcome> {
  for (let first = true; ; first = false) {
    try {
      if (first) return await rpc.sendTransactionUntil(signed, wait);
      try {
        return await rpc.txStatus(hash, sender, wait);
      } catch (err) {
        if (noVerdict(err)) throw err;
        // the node does not know the transaction (dropped before admission): same bytes again
        return await rpc.sendTransactionUntil(signed, wait);
      }
    } catch (err) {
      if (!noVerdict(err) || Date.now() >= deadline) throw err;
      await sleep(500);
    }
  }
}

/** `CertoChain` over NEAR JSON-RPC (sandbox or testnet). */
export class NearCertoChain implements CertoChain {
  readonly contractId: string;
  readonly tokenId: string;
  readonly accountId?: string;
  readonly network: string;
  readonly provider: JsonRpcProvider;
  private readonly account?: Account;
  private sending: Promise<unknown> = Promise.resolve();

  constructor(o: NearChainOptions) {
    this.contractId = o.contractId;
    this.tokenId = o.tokenId;
    this.accountId = o.accountId;
    this.network = o.network ?? (o.rpcUrl.includes('testnet') ? 'near:testnet' : o.rpcUrl.includes('mainnet') ? 'near:mainnet' : 'near:sandbox');
    this.provider = new JsonRpcProvider({ url: o.rpcUrl });
    const signer = o.signer ?? (o.privateKey ? KeyPairSigner.fromSecretKey(o.privateKey as KeyPairString) : undefined);
    if (o.accountId && signer) this.account = new Account(o.accountId, this.provider, signer);
  }

  /** Same chain, different signing account. */
  as(accountId: string, privateKey: string): NearCertoChain {
    return new NearCertoChain({
      rpcUrl: this.provider.connection.url, contractId: this.contractId, tokenId: this.tokenId, network: this.network, accountId, privateKey,
    });
  }

  async view<T>(method: string, args: Record<string, unknown> = {}, contractId = this.contractId): Promise<T> {
    return (await rateLimitRetry(() => this.provider.callFunction(contractId, method, args))) as T;
  }

  /** Signed function call; throws `ContractError` if the transaction's own receipt fails. */
  async call(method: string, args: Record<string, unknown>, opts: { receiverId?: string; gas?: bigint; deposit?: bigint } = {}): Promise<TxResult> {
    const account = this.account;
    if (!account) throw new Error('this chain client has no signing account');
    // One transaction at a time per client: each send reads the access-key nonce, so
    // concurrent sends from one account (e.g. two panel cases at once) would reuse it.
    const send = this.sending.then(() => signAndSend(account, {
      receiverId: opts.receiverId ?? this.contractId,
      actions: [actionCreators.functionCall(method, args, opts.gas ?? 100n * TGAS, opts.deposit ?? 0n)],
      throwOnFailure: false,
    }));
    this.sending = send.then(() => undefined, () => undefined);
    const outcome = await send;
    const logs: string[] = [];
    const failures: string[] = [];
    for (const o of [outcome.transaction_outcome, ...outcome.receipts_outcome]) {
      logs.push(...o.outcome.logs);
      const st = o.outcome.status as { Failure?: unknown };
      if (st && typeof st === 'object' && 'Failure' in st && st.Failure) failures.push(JSON.stringify(st.Failure));
    }
    const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
    let value: unknown;
    if (typeof status === 'object' && typeof status.SuccessValue === 'string' && status.SuccessValue) {
      try { value = JSON.parse(Buffer.from(status.SuccessValue, 'base64').toString('utf8')); } catch { value = undefined; }
    }
    const res: TxResult = { txHash: outcome.transaction_outcome.id, events: parseEvents(logs), logs, failures, value };
    if (typeof status === 'object' && status.Failure) {
      const msg = JSON.stringify(status.Failure);
      throw new ContractError(`${method} failed: ${msg}`, errorCode(msg), res);
    }
    return res;
  }

  private ftCall(amount: string, msg: Record<string, unknown>): Promise<TxResult> {
    return this.call('ft_transfer_call', { receiver_id: this.contractId, amount, msg: JSON.stringify(msg) }, {
      receiverId: this.tokenId, gas: 100n * TGAS, deposit: ONE_YOCTO,
    });
  }

  async getConfig(): Promise<ContractConfig> {
    const raw = await this.view<Record<string, unknown> & { cfg?: Record<string, unknown> }>('get_config');
    const { cfg, ...rest } = raw;
    return { ...rest, ...(cfg ?? {}) } as ContractConfig;
  }
  async getJurors() { return normJurors(await this.view('get_jurors')); }
  async getSeller(id: string) { return normSeller(await this.view<SellerView | null>('get_seller', { id })); }
  getTerms(seller: string, termsId: string) { return this.view<TermsView | null>('get_terms', { seller, terms_id: termsId }); }
  async getCall(callId: string) { return normCall(await this.view<CallView | null>('get_call', { call_id: callId })); }
  getBuyer(id: string) { return this.view<BuyerView | null>('get_buyer', { id }); }
  quote(seller: string, price: string) { return this.view<QuoteView>('quote', { seller, price }); }
  buildPanelRequest(args: BuildPanelRequestArgs) { return this.view<string>('build_panel_request', { ...args }); }
  receiptText(args: { call_id: string; response_hash: string; status_code: number; served_at_ms: number }) {
    return this.view<string>('receipt_text', { ...args });
  }
  async claimableOf(id: string) { return String(await this.view('claimable_of', { id })); }
  async ftBalanceOf(id: string) { return String(await this.view('ft_balance_of', { account_id: id }, this.tokenId)); }

  registerSeller(args: { receipt_pubkey: string; window_ms: number }, depositYocto = ONE_NEAR) {
    return this.call('register_seller', args, { deposit: depositYocto, gas: 30n * TGAS });
  }
  depositBond(amount: string) { return this.ftCall(amount, { action: 'bond' }); }
  addTerms(args: { terms_id: string; text: string; required_fields: string[]; as_of_field: string | null; max_age_s: number | null; panel: boolean }) {
    return this.call('add_terms', args, { gas: 30n * TGAS });
  }
  withdrawBond(amount: string) { return this.call('withdraw_bond', { amount }); }
  answer(callId: string, offerBps: number) { return this.call('answer', { call_id: callId, offer_bps: offerBps }, { gas: 30n * TGAS }); }
  cure(args: { call_id: string; response_body: string } & ReceiptArgs) { return this.call('cure', { ...args }); }

  pay(a: { seller: string; quote_id: string; terms_id: string; request_hash: string; amount: string }) {
    return this.ftCall(a.amount, { action: 'pay', seller: a.seller, quote_id: a.quote_id, terms_id: a.terms_id, request_hash: a.request_hash });
  }
  claimError(args: { call_id: string } & ReceiptArgs) { return this.call('claim_error', { ...args }); }
  claimRule(args: { call_id: string; response_body: string } & ReceiptArgs) { return this.call('claim_rule', { ...args }); }
  disputeNonDelivery(a: { call_id: string; stake: string }) {
    return this.ftCall(a.stake, { action: 'dispute', kind: 'non_delivery', call_id: a.call_id });
  }
  disputeContent(a: { call_id: string; stake: string; offer_commit: string } & ReceiptArgs) {
    return this.ftCall(a.stake, {
      action: 'dispute', kind: 'content', call_id: a.call_id, response_hash: a.response_hash, status_code: a.status_code,
      served_at_ms: a.served_at_ms, sig: a.sig, offer_commit: a.offer_commit,
    });
  }

  release(seller: string, max: number) { return this.call('release', { seller, max }); }
  resolve(args: { call_id: string; buyer_offer_bps: number; salt: string; request_canon: string; response_body: string; ballots: ContractBallot[] }) {
    return this.call('resolve', { ...args }, { gas: 200n * TGAS });
  }
  resolveDefault(args: { call_id: string; buyer_offer_bps?: number; salt?: string }) { return this.call('resolve_default', { ...args }); }
  withdrawClaimable() { return this.call('withdraw_claimable', {}); }
}

/** Build a chain client from environment variables (testnet scripts). */
export function chainFromEnv(env: NodeJS.ProcessEnv = process.env, account?: { accountId: string; privateKey: string }): NearCertoChain {
  const contractId = env.CERTO_CONTRACT;
  const tokenId = env.CERTO_TOKEN;
  if (!contractId || !tokenId) throw new Error('CERTO_CONTRACT and CERTO_TOKEN must be set');
  return new NearCertoChain({
    rpcUrl: env.NEAR_RPC_URL ?? 'https://rpc.testnet.fastnear.com',
    contractId, tokenId,
    network: env.NEAR_NETWORK ? `near:${env.NEAR_NETWORK}` : undefined,
    ...account,
  });
}

/** True if a transaction emitted the named event (optionally matching a predicate). */
export function hasEvent(tx: TxResult, name: string, pred: (d: Record<string, unknown>) => boolean = () => true): boolean {
  return tx.events.some((e) => e.event === name && pred(e.data));
}
