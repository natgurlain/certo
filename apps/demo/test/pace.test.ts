import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ES module of the page, no type declarations
import { MIN_SCENE_MS, TICKS_MS, countdownMs, dwellMs } from '../web/pace.js';

type Msg = { kind: string; [k: string]: unknown };
/** Total time the page holds a scene on screen when the feed arrives all at once. */
function sceneTime(msgs: Msg[]): number {
  let now = 0, sceneStart = 0, lastVote: number | null = null;
  for (const m of msgs) {
    if (m.kind === 'scene' && m.status === 'start') { sceneStart = now; lastVote = null; }
    if (m.kind === 'vote') lastVote = now;
    now += dwellMs(m, { now, sceneStart, lastVote }) as number;
  }
  return now;
}

describe('page pacing (apps/demo/web/pace.js)', () => {
  it('holds even a bare scene (start, end) for at least MIN_SCENE_MS', () => {
    expect(sceneTime([{ kind: 'scene', n: 1, status: 'start' }, { kind: 'scene', n: 1, status: 'ok' }])).toBeGreaterThanOrEqual(MIN_SCENE_MS);
  });

  it('keeps the juror ticks on screen at least TICKS_MS before the next scene', () => {
    const at = { now: 20_000, sceneStart: 0, lastVote: 19_000 };
    expect(dwellMs({ kind: 'scene', n: 2, status: 'ok' }, at)).toBeGreaterThanOrEqual(TICKS_MS - 1000);
  });

  it('counts a rule claim down in real time and does not hold contract log lines', () => {
    expect(countdownMs({ kind: 'dispute', disputeKind: 'non_delivery', answerMs: 5000 })).toBe(5000);
    expect(countdownMs({ kind: 'dispute', disputeKind: 'non_delivery', answerByMs: 15_000, t: 10_000 })).toBe(5000);
    expect(countdownMs({ kind: 'dispute', disputeKind: 'content', answerByMs: 15_000, t: 10_000 })).toBeNull();
    expect(dwellMs({ kind: 'dispute', disputeKind: 'non_delivery', answerMs: 5000 })).toBeGreaterThanOrEqual(5000);
    const buyers = new Set(['agent']);
    expect(dwellMs({ kind: 'log', actor: 'contract', text: 'seller silent, 3 s left' }, { buyers })).toBe(0);
    expect(dwellMs({ kind: 'log', actor: 'agent', text: 'asked NEAR, got NEO → claim a refund' }, { buyers })).toBeGreaterThan(0);
  });

  it('paces a recorded scene 2 to at least 10 s', () => {
    const scene2: Msg[] = [
      { kind: 'scene', n: 2, status: 'start' }, { kind: 'chain', event: 'call_paid' }, { kind: 'state' }, { kind: 'call' },
      { kind: 'log', actor: 'agent' }, { kind: 'dispute', disputeKind: 'content' }, { kind: 'dispute', disputeKind: 'content' },
      { kind: 'vote' }, { kind: 'vote' }, { kind: 'vote' }, { kind: 'chain', event: 'dispute_resolved' }, { kind: 'resolved' },
      { kind: 'scene', n: 2, status: 'ok' },
    ];
    expect(sceneTime(scene2)).toBeGreaterThanOrEqual(MIN_SCENE_MS);
  });
});
