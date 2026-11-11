import { formatUsdc } from '@certo/core';
import { CertoError, describeOutcome, type CertoClient, type Progress } from './client.js';

export type DisputeKind = 'content' | 'error' | 'rule' | 'non_delivery';

/**
 * Open a dispute of `kind` (unless one is already open on the call) and follow
 * it to the final outcome, waiting at most `maxWaitMs`. Running it again on the
 * same call continues where it stopped.
 */
export async function disputeAndSettle(
  c: CertoClient, callId: string, o: { kind?: DisputeKind; offerPct?: number; panelUrl?: string; maxWaitMs?: number; pollMs?: number } = {},
): Promise<{ opened?: { kind: DisputeKind; tx: string; stake?: string; sealedOfferPct?: number }; progress: Progress }> {
  const kind = o.kind ?? 'content';
  const call = await c.chain.getCall(callId);
  const stored = c.disputeOf(callId);
  // a dispute in progress, or a non-delivery claim the seller cured (call open again): follow it, do not open another
  const already = (call && call.status !== 'Open') || (call && stored?.kind === 'non_delivery');
  const settle = () => c.settle(callId, { panelUrl: o.panelUrl, maxWaitMs: o.maxWaitMs, pollMs: o.pollMs });
  if (already || (!call && stored)) return { progress: await settle() };
  if (!call) throw new CertoError('NO_STATE', `call ${callId} is not on chain (window closed, already settled, or never paid); see certo_status`);
  if (kind === 'error' || kind === 'rule') {
    const tx = kind === 'error' ? await c.claimError(callId) : await c.claimRule(callId);
    return { opened: { kind, tx: tx.txHash }, progress: await settle() };
  }
  if (kind === 'non_delivery') {
    const tx = await c.claimNonDelivery(callId);
    return { opened: { kind, tx: tx.txHash, stake: c.disputeOf(callId)?.stake }, progress: await settle() };
  }
  const pct = o.offerPct ?? 100;
  if (!Number.isInteger(pct) || pct < 0 || pct > 100) throw new Error(`offer must be a whole percent 0..100, got ${pct}`);
  const d = await c.dispute(callId, { offerBps: pct * 100 });
  return { opened: { kind, tx: d.tx.txHash, stake: d.stake, sealedOfferPct: pct }, progress: await settle() };
}

/** One line for a `Progress`. */
export function describeProgress(p: Progress): string {
  if (p.state === 'final') return describeOutcome(p.outcome);
  if (p.state === 'no_dispute') return p.detail;
  return `still open (${p.status}): ${p.detail}; run the same dispute command again to continue`;
}

/** What each failure code means and what to do (shown to agents with every error). */
export const ERROR_HELP: Record<string, string> = {
  NOT_PROTECTED: 'the URL did not answer 402 with a PAYMENT-REQUIRED header: it is not a Certo endpoint; nothing was paid',
  NO_SCHEME: 'the 402 offers no certo-bonded scheme; nothing was paid',
  WRONG_CONTRACT: 'the seller wants payment to another contract or token than this client is configured for; nothing was paid',
  PRICE_TOO_HIGH: 'price above your cap; nothing was paid. Pass a higher max_price only if the call is worth it',
  SELLER_UNKNOWN: 'the seller is not registered in the contract; nothing was paid',
  TERMS_UNKNOWN: 'the quoted terms are not on chain; nothing was paid',
  WOULD_NOT_FIT: 'the seller bond has no free capacity now; nothing was paid. Retry later or use another seller',
  PAY_FAILED: 'the payment transaction bounced (see contract_code); the tokens were returned',
  TIMEOUT: 'paid but no response in time: dispute with kind "non_delivery" before the window closes',
  NO_RECEIPT: 'paid but the response had no valid signed receipt: dispute with kind "non_delivery"',
  RECEIPT_MISMATCH: 'paid but the body differs from what the seller signed: dispute with kind "non_delivery"',
  BAD_RECEIPT_SIG: 'paid but the receipt is not signed by the seller key on chain: dispute with kind "non_delivery"',
  NO_STATE: 'this client has no record of that call (made elsewhere, or a different CERTO_STATE_DIR); check certo_status',
  E_WINDOW_CLOSED: 'the refund window of this call has closed; no dispute is possible',
  E_STATUS: 'the call is not in a state that allows this (already disputed or settled); check certo_status',
  E_STAKE_LOW: 'the stake sent is below what the contract requires now; retry (the stake is recomputed)',
  E_NO_PANEL_TERMS: 'these terms do not allow content disputes; use kind "rule" or "error" if they apply',
  E_RULE_NOT_BROKEN: 'the body passes every published rule; a rule claim cannot refund it (consider kind "content")',
  E_HTTP_STATUS: 'kind "error" needs a signed status >= 500; kinds "content" and "rule" need < 500',
  E_EXPOSURE: 'the seller bond had no free capacity when the payment landed; the tokens were returned',
  E_TOO_EARLY: 'a deadline has not passed yet; wait and run the dispute again',
};

/** The help line for an error (failure code first, then contract code). */
export function helpFor(code?: string, contractCode?: string): string | undefined {
  return (contractCode && ERROR_HELP[contractCode]) || (code && ERROR_HELP[code]) || undefined;
}

export const fmt = (units: string | undefined) => (units === undefined ? undefined : formatUsdc(units));
