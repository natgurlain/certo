import { EVENT_STANDARD } from './brand.js';
import type { ContractEvent } from './types.js';

const PREFIX = 'EVENT_JSON:';

/** Parse NEP-297 `EVENT_JSON:` log lines of this contract's standard; other lines are skipped. */
export function parseEvents(logs: string[]): ContractEvent[] {
  const out: ContractEvent[] = [];
  for (const l of logs) {
    if (!l.startsWith(PREFIX)) continue;
    try {
      const e = JSON.parse(l.slice(PREFIX.length)) as ContractEvent;
      if (e.standard === EVENT_STANDARD) out.push(e);
    } catch {
      /* not an event */
    }
  }
  return out;
}

/** First `E_*` error code in a message, if any. */
export function errorCode(msg: string): string | undefined {
  return /\bE_[A-Z0-9_]+/.exec(msg)?.[0];
}
