import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { recordingFileName, type PanelRecording } from '@makegood/core';
import type { JurorSource } from './jurors.js';

/** Writes `<dir>/<sha256 of request body>.json`. */
export async function saveRecording(dir: string, rec: PanelRecording): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, recordingFileName(rec.request_body));
  await writeFile(path, JSON.stringify(rec, null, 2) + '\n');
  return path;
}

/** Wraps a (live) juror source so that every answer is also saved as a replay fixture (`make record`). */
export class RecordingJurors implements JurorSource {
  readonly mode: 'live' | 'replay';
  readonly saved: string[] = [];
  constructor(private readonly inner: JurorSource, readonly dir: string) {
    this.mode = inner.mode;
  }
  async ask(model: string, requestBody: string): Promise<PanelRecording> {
    const rec = await this.inner.ask(model, requestBody);
    this.saved.push(await saveRecording(this.dir, rec));
    return rec;
  }
}
