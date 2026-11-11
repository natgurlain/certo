import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  recordingFileName, sha256Hex, systemClock, toBase64, verifyNearAiBallot,
  type Clock, type NearAiSignature, type PanelRecording,
} from '@certo/core';

export const NEARAI_BASE_URL = 'https://cloud-api.near.ai/v1';

/** Asks one juror for one exact request body and returns the recording (raw bytes + signature). */
export interface JurorSource {
  readonly mode: 'live' | 'replay';
  ask(model: string, requestBody: string): Promise<PanelRecording>;
}

export class PanelMissError extends Error {
  constructor(readonly requestSha256: string) {
    super(`no recording for this case (sha256 ${requestSha256}); set NEARAI_API_KEY to ask the live panel`);
    this.name = 'PanelMissError';
  }
}

/** Replay mode: `fixtures/panel/<sha256 of request body>.json`. */
export class ReplayJurors implements JurorSource {
  readonly mode = 'replay' as const;
  constructor(readonly fixturesDir: string) {}

  async ask(model: string, requestBody: string): Promise<PanelRecording> {
    const sha = sha256Hex(requestBody);
    let text: string;
    try {
      text = await readFile(join(this.fixturesDir, recordingFileName(requestBody)), 'utf8');
    } catch {
      throw new PanelMissError(sha);
    }
    const rec = JSON.parse(text) as PanelRecording;
    if (rec.request_body !== requestBody || rec.model !== model) {
      throw new Error(`recording ${sha} is for another body or model (${rec.model})`);
    }
    return rec;
  }
}

export interface LiveOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  clock?: Clock;
  /** Signature fetch: tries and spacing (section 4.3: up to 10, 1 s apart; DeepSeek sometimes 404s for a few seconds). */
  signatureTries?: number;
  signatureDelayMs?: number;
}

/**
 * Live mode against NEAR AI Cloud (section 2.1): non-streaming chat completion
 * with the canonical model id, `x-no-aliasing: true`, `Accept-Encoding:
 * identity`; the body is sent byte for byte and the raw response bytes are
 * kept; then `GET /v1/signature/<chat id>?model=…&signing_algo=ed25519`.
 */
export class LiveJurors implements JurorSource {
  readonly mode = 'live' as const;
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly clock: Clock;
  constructor(private readonly o: LiveOptions) {
    this.base = (o.baseUrl ?? NEARAI_BASE_URL).replace(/\/$/, '');
    this.f = o.fetch ?? fetch;
    this.clock = o.clock ?? systemClock;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.o.apiKey}`, 'Accept-Encoding': 'identity', 'x-no-aliasing': 'true', ...extra };
  }

  async ask(model: string, requestBody: string): Promise<PanelRecording> {
    const t0 = this.clock.now();
    const r = await this.f(`${this.base}/chat/completions`, {
      method: 'POST', headers: this.headers({ 'Content-Type': 'application/json' }), body: requestBody, // a string is sent as its exact UTF-8 bytes
    });
    const raw = new Uint8Array(await r.arrayBuffer());
    if (!r.ok) throw new Error(`NEAR AI ${model}: HTTP ${r.status}: ${Buffer.from(raw).toString('utf8').slice(0, 300)}`);
    let chatId: string;
    try {
      chatId = (JSON.parse(Buffer.from(raw).toString('utf8')) as { id: string }).id;
    } catch {
      throw new Error(`NEAR AI ${model}: response is not JSON`);
    }
    if (!chatId) throw new Error(`NEAR AI ${model}: response has no id`);
    const signature = await this.fetchSignature(chatId, model);
    return {
      model, request_body: requestBody, response_body_b64: toBase64(raw), chat_id: chatId,
      signature: { ...signature, signature_kind: signature.signature_kind ?? (signature.text.split(':').length > 2 ? 'provider_tee' : 'gateway') },
      latency_ms: this.clock.now() - t0, recorded_at: new Date(this.clock.now()).toISOString(),
    };
  }

  async fetchSignature(chatId: string, model: string): Promise<NearAiSignature> {
    const url = `${this.base}/signature/${encodeURIComponent(chatId)}?model=${encodeURIComponent(model)}&signing_algo=ed25519`;
    const tries = this.o.signatureTries ?? 10;
    let last = '';
    for (let i = 0; i < tries; i++) {
      if (i > 0) await this.clock.sleep(this.o.signatureDelayMs ?? 1000);
      try {
        const r = await this.f(url, { headers: this.headers() });
        const body = (await r.json().catch(() => ({}))) as Partial<NearAiSignature> & { error?: unknown };
        if (r.ok && !body.error && body.text && body.signature && body.signing_address) return body as NearAiSignature;
        last = `HTTP ${r.status} ${JSON.stringify(body).slice(0, 200)}`;
      } catch (e) {
        last = (e as Error).message;
      }
    }
    throw new Error(`NEAR AI signature for ${chatId} (${model}) missing after ${tries} tries: ${last}`);
  }
}

/** Offline check of a recording against the expected juror key (throws with the reason). */
export function assertBallot(rec: PanelRecording, expectedKey?: string): void {
  const c = verifyNearAiBallot({
    model: rec.model, requestBody: rec.request_body, responseBody: Buffer.from(rec.response_body_b64, 'base64'),
    signature: rec.signature, expectedKey,
  });
  if (!c.ok) throw new Error(`ballot for ${rec.model} does not verify: ${c.reason}`);
}

/** `live` when `PANEL_MODE=live` or a key is set (and `PANEL_MODE` is not `replay`); otherwise `replay`. */
export function jurorsFromEnv(env: NodeJS.ProcessEnv, fixturesDir: string, extra: Omit<LiveOptions, 'apiKey'> = {}): JurorSource {
  const mode = env.PANEL_MODE ?? (env.NEARAI_API_KEY ? 'live' : 'replay');
  if (mode === 'live') {
    if (!env.NEARAI_API_KEY) throw new Error('PANEL_MODE=live needs NEARAI_API_KEY');
    return new LiveJurors({ apiKey: env.NEARAI_API_KEY, baseUrl: env.NEARAI_BASE_URL, ...extra });
  }
  if (mode !== 'replay') throw new Error(`PANEL_MODE must be live or replay, got ${mode}`);
  return new ReplayJurors(fixturesDir);
}
