import type { CallResult } from './client.js';

export type Decision =
  | { action: 'accept'; reason: string }
  | { action: 'claim_error'; reason: string }
  | { action: 'dispute'; offerBps: number; reason: string };

/**
 * The demo agent's policy (T10): a signed 5xx → `claim_error`; a body whose
 * `token` differs from the requested `token` query parameter → content dispute
 * at 100%; otherwise accept.
 */
export function simplePolicy(r: CallResult): Decision {
  if (r.status >= 500) return { action: 'claim_error', reason: `seller signed status ${r.status}` };
  const requested = new URL(r.requestCanon.split('\n')[1] ?? '/', 'http://x').searchParams.get('token');
  if (requested === null) return { action: 'accept', reason: 'no token requested' };
  let got: unknown;
  try {
    got = (JSON.parse(r.body) as { token?: unknown }).token;
  } catch {
    return { action: 'accept', reason: 'body is not JSON (a rule claim, not a panel case)' };
  }
  if (got !== requested) return { action: 'dispute', offerBps: 10000, reason: `asked for ${requested}, got ${String(got)}` };
  return { action: 'accept', reason: `token ${requested} as requested` };
}
