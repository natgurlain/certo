import type { CallResult } from './client.js';

export type Decision =
  | { action: 'accept'; reason: string }
  | { action: 'no_opinion'; reason: string }
  | { action: 'claim_error'; reason: string }
  | { action: 'dispute'; offerBps: number; reason: string };

/**
 * The demo agent's policy (T10). It understands one thing: a `token` query
 * parameter that the JSON body must echo. A signed 5xx → `claim_error`; a body
 * whose `token` differs → content dispute at 100%; a matching token → accept.
 * For anything else it has no opinion: judge the body yourself.
 */
export function simplePolicy(r: CallResult): Decision {
  if (r.status >= 500) return { action: 'claim_error', reason: `seller signed status ${r.status}` };
  const requested = new URL(r.requestCanon.split('\n')[1] ?? '/', 'http://x').searchParams.get('token');
  if (requested === null) return { action: 'no_opinion', reason: 'this policy only checks a "token" query parameter; judge the body against the terms yourself' };
  let got: unknown;
  try {
    got = (JSON.parse(r.body) as { token?: unknown }).token;
  } catch {
    return { action: 'no_opinion', reason: 'body is not JSON; if the terms require JSON, kind "rule" refunds it' };
  }
  if (got !== requested) return { action: 'dispute', offerBps: 10000, reason: `asked for ${requested}, got ${String(got)}` };
  return { action: 'accept', reason: `token ${requested} as requested` };
}
