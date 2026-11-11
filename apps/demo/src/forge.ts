/**
 * Scene 5, "we attack our own contract" (guard G1 of `tests/guards/run.ts`):
 * a juror source that hands out the recorded, signed ballots with one byte of
 * one juror's answer changed (its vote letter X ↔ Y) and the signature kept.
 */
import { JURORS, parseVote, recordingResponseBody, toBase64, voteToSide, type PanelRecording, type Side } from '@certo/core';
import type { JurorSource } from '@certo/panel';

/** Change the final vote letter of a chat-completions body (X ↔ Y): exactly one byte. */
export function flipVoteByte(body: string): { body: string; from: 'X' | 'Y'; to: 'X' | 'Y' } {
  const m = /"content"\s*:\s*"/.exec(body);
  if (!m) throw new Error('no "content" in the juror answer');
  let end = m.index + m[0].length;
  while (end < body.length && body[end] !== '"') end += body[end] === '\\' ? 2 : 1;
  const from = body[end - 1];
  if (from !== 'X' && from !== 'Y') throw new Error(`the juror answer does not end in X or Y (${JSON.stringify(from)})`);
  const to = from === 'X' ? 'Y' : 'X';
  return { body: `${body.slice(0, end - 1)}${to}${body.slice(end)}`, from, to };
}

export class ForgingJurors implements JurorSource {
  readonly mode: 'live' | 'replay';
  /** The answer letter before and after the edit, once a ballot was forged. */
  edit?: { from: 'X' | 'Y'; to: 'X' | 'Y' };
  /** Side of each juror's ballot as handed out (the forged one included), by juror index. */
  readonly sides: Array<Side | 'abstain'> = [];

  constructor(private readonly inner: JurorSource, readonly forged: number) {
    this.mode = inner.mode;
  }

  async ask(model: string, requestBody: string): Promise<PanelRecording> {
    const rec = await this.inner.ask(model, requestBody);
    const i = JURORS.findIndex((j) => j.model === model);
    let body = recordingResponseBody(rec);
    if (i === this.forged) {
      const f = flipVoteByte(body);
      body = f.body;
      this.edit = { from: f.from, to: f.to };
    }
    this.sides[i] = voteToSide(i, parseVote(body));
    return i === this.forged ? { ...rec, response_body_b64: toBase64(new TextEncoder().encode(body)) } : rec;
  }
}
