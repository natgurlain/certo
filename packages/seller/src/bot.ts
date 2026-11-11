import type { MakegoodChain } from '@makegood/core';
import type { ServedStore } from './protect.js';

export type BotChain = Pick<MakegoodChain, 'getCall' | 'answer' | 'cure'>;

export interface AnswerBotOptions {
  chain: BotChain;
  /** Calls served by `protect()`; the bot watches these. */
  store: ServedStore;
  /** Offer to state in every content dispute, in bps (0 = "no refund"). */
  offerBps?: number;
  /** Cure non-delivery claims with the stored response and receipt. Default true. */
  cure?: boolean;
  onAction?: (a: { callId: string; action: 'answer' | 'cure'; txHash?: string; error?: string }) => void;
}

/**
 * The seller's answer bot: for every served call still on chain, answers a
 * content dispute with a fixed offer and cures a non-delivery claim. Drive it
 * with `tick()` (tests) or `start(intervalMs)`.
 */
export function createAnswerBot(o: AnswerBotOptions) {
  const done = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  async function tick(): Promise<void> {
    for (const [callId, p] of o.store) {
      const served = await p.catch(() => undefined);
      if (!served) continue;
      const call = await o.chain.getCall(callId).catch(() => null);
      if (!call) { o.store.delete(callId); continue; } // released or resolved
      const key = `${callId}:${call.status}:${call.dispute?.opened_at_ms ?? ''}`;
      if (done.has(key)) continue;
      try {
        if (call.status === 'Disputed') {
          done.add(key);
          const tx = await o.chain.answer(callId, o.offerBps ?? 0);
          o.onAction?.({ callId, action: 'answer', txHash: tx.txHash });
        } else if (call.status === 'NonDeliveryClaimed' && (o.cure ?? true)) {
          done.add(key);
          const r = served.receipt;
          const tx = await o.chain.cure({
            call_id: callId, response_hash: r.responseHash, status_code: r.statusCode, served_at_ms: r.servedAtMs, sig: r.sig,
            response_body: served.body.toString('utf8'),
          });
          o.onAction?.({ callId, action: 'cure', txHash: tx.txHash });
        }
      } catch (e) {
        o.onAction?.({ callId, action: call.status === 'Disputed' ? 'answer' : 'cure', error: (e as Error).message });
      }
    }
  }

  return {
    tick,
    start(intervalMs = 1000) {
      if (!timer) timer = setInterval(() => { tick().catch(() => undefined); }, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
