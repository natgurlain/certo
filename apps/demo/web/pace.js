// Playback pacing of the demo page (apps/demo/EVENTS.md). The page plays every
// feed message in order and then holds it on screen for `dwellMs` before the
// next one, so a run that finished in seconds, or a feed.json opened later,
// still plays at a pace a viewer can follow. Plain ES module, no DOM: the unit
// test in apps/demo/test/pace.test.ts imports it.

/** Each scene stays on screen at least this long. */
export const MIN_SCENE_MS = 10000;
/** The juror ticks ("signature verified by contract") stay at least this long. */
export const TICKS_MS = 5000;

/**
 * Hold time after playing message `m`, in ms.
 * ctx.now: current time (ms, any origin); ctx.sceneStart: when the current scene's
 * `start` was played; ctx.lastVote: when its last `vote` was played (null if none);
 * ctx.intro: the opening card is still up; ctx.buyers: ids whose log lines the page shows
 * (other actors' lines are not on screen and pass at once).
 */
export function dwellMs(m, ctx = {}) {
  const now = ctx.now ?? 0;
  switch (m.kind) {
    case "mode": return ctx.intro ? 3500 : 0;
    case "scene": {
      if (m.status === "start") return 2500;
      const scene = MIN_SCENE_MS - (now - (ctx.sceneStart ?? now));
      const ticks = ctx.lastVote === null || ctx.lastVote === undefined ? 0 : TICKS_MS - (now - ctx.lastVote);
      return Math.max(3500, scene, ticks);
    }
    case "call": return 3000;
    case "log": return ctx.buyers && !ctx.buyers.has(m.actor) ? 0 : 1500;
    case "dispute": {
      // a rule claim counts down the seller's answer time in real time
      const cd = countdownMs(m);
      if (cd !== null) return cd + 400;
      return m.sellerOfferPct === undefined ? 1800 : 1200; // opened; then the offers
    }
    case "vote": return 1200;
    case "resolved": return 3000;
    case "attack": return 3500;
    case "chain": return 400;
    default: return 0;
  }
}

/** Length of the seller's answer time a non-content dispute counts down, or null. */
export function countdownMs(m) {
  if (m.kind !== "dispute" || (m.disputeKind ?? "content") === "content") return null;
  if (typeof m.answerMs === "number") return m.answerMs;
  if (typeof m.answerByMs === "number" && typeof m.t === "number") return Math.max(0, m.answerByMs - m.t);
  return null;
}
