// NEAR AI Cloud HTTP calls used by the panel scripts (Node built-ins only).
// The base URL can be pointed at the mock juror server (scripts/lib/mock-jurors.ts).
import { fileExists, randomHex, repoPath } from "./util.ts";

/** Read on every call so `--mock` can point it at the local fake after start-up. */
export function nearaiBaseUrl(): string {
  return (process.env.NEARAI_BASE_URL ?? "https://cloud-api.near.ai").replace(/\/$/, "");
}

// Juror table and reserve model come from @certo/core (section 4.4), never duplicated here.
export { JURORS, RESERVE_JUROR_MODEL } from "@certo/core";

export interface RawResponse {
  status: number;
  bytes: Buffer;
  ms: number;
  headers: Record<string, string>;
}

export async function httpRaw(
  method: "GET" | "POST",
  url: string,
  opts: { headers?: Record<string, string>; body?: Uint8Array | string; timeoutMs?: number } = {},
): Promise<RawResponse> {
  const t0 = performance.now();
  const res = await fetch(url, {
    method,
    headers: opts.headers,
    body: opts.body as BodyInit | undefined,
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  const bytes = Buffer.from(await res.arrayBuffer());
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  return { status: res.status, bytes, ms: Math.round(performance.now() - t0), headers };
}

export function apiKeyOrExit(script: string): string {
  const envFile = repoPath(".env");
  if (!process.env.NEARAI_API_KEY && fileExists(envFile)) process.loadEnvFile(envFile); // never committed
  const key = process.env.NEARAI_API_KEY?.trim();
  if (!key) {
    console.error(
      `${script}: NEARAI_API_KEY is not set.\n` +
        `This step calls NEAR AI Cloud chat completions and signatures, which need a key.\n` +
        `Put NEARAI_API_KEY=… in .env at the repository root (never committed) or export it, then re-run.\n` +
        `Without a key: \`npx tsx scripts/killtest.ts --mock\` exercises the same harness against a local fake panel.`,
    );
    process.exit(2);
  }
  return key;
}

/** Attestation reports need no key (section 2.1). */
export async function fetchAttestation(model: string, nonce = randomHex(32)): Promise<RawResponse & { nonce: string; url: string }> {
  const q = new URLSearchParams({
    model,
    provider: "near",
    nonce,
    signing_algo: "ed25519",
    include_tls_fingerprint: "false",
  });
  const url = `${nearaiBaseUrl()}/v1/attestation/report?${q}`;
  const r = await httpRaw("GET", url, { headers: { "x-no-aliasing": "true", "Accept-Encoding": "identity" }, timeoutMs: 120_000 });
  return { ...r, nonce, url };
}

export async function listModels(): Promise<any[]> {
  const r = await httpRaw("GET", `${nearaiBaseUrl()}/v1/model/list?limit=500`);
  if (r.status !== 200) throw new Error(`/v1/model/list → HTTP ${r.status}`);
  const j = JSON.parse(r.bytes.toString("utf8"));
  return j.models ?? j.data ?? j;
}

export interface Ballot {
  model: string;
  chatId: string | null;
  requestBody: string;
  responseBytes: Buffer;
  httpStatus: number;
  latencyMs: number; // completion only
  signature: SignatureRecord | null;
  signatureMs: number; // signature fetch incl. retries
  signatureTries: number;
  error?: string;
}

export interface SignatureRecord {
  text: string;
  signature: string;
  signing_address: string;
  signing_algo: string;
  signature_kind?: string;
}

/**
 * One juror call exactly as section 4.3/6.5 says: the body bytes as given,
 * non-streaming, `x-no-aliasing: true`, `Accept-Encoding: identity`, raw
 * response bytes kept; then the ed25519 signature with up to `tries` attempts.
 */
export async function askJuror(apiKey: string, model: string, requestBody: string, opts: { tries?: number; gapMs?: number } = {}): Promise<Ballot> {
  const tries = opts.tries ?? 10;
  const gapMs = opts.gapMs ?? 1000;
  const base: Ballot = {
    model,
    chatId: null,
    requestBody,
    responseBytes: Buffer.alloc(0),
    httpStatus: 0,
    latencyMs: 0,
    signature: null,
    signatureMs: 0,
    signatureTries: 0,
  };
  let r: RawResponse;
  try {
    r = await httpRaw("POST", `${nearaiBaseUrl()}/v1/chat/completions`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Accept-Encoding": "identity",
        "x-no-aliasing": "true",
      },
      body: Buffer.from(requestBody, "utf8"),
      timeoutMs: 120_000,
    });
  } catch (e) {
    return { ...base, error: `completion: ${(e as Error).message}` };
  }
  base.responseBytes = r.bytes;
  base.httpStatus = r.status;
  base.latencyMs = r.ms;
  if (r.status !== 200) return { ...base, error: `completion HTTP ${r.status}: ${r.bytes.toString("utf8").slice(0, 200)}` };
  try {
    base.chatId = JSON.parse(r.bytes.toString("utf8")).id ?? null;
  } catch {
    return { ...base, error: "completion body is not JSON" };
  }
  if (!base.chatId) return { ...base, error: "completion has no id" };
  const t0 = performance.now();
  let lastErr = "";
  for (let i = 1; i <= tries; i++) {
    base.signatureTries = i;
    try {
      const s = await httpRaw(
        "GET",
        `${nearaiBaseUrl()}/v1/signature/${encodeURIComponent(base.chatId)}?model=${encodeURIComponent(model)}&signing_algo=ed25519`,
        { headers: { Authorization: `Bearer ${apiKey}`, "Accept-Encoding": "identity", "x-no-aliasing": "true" } },
      );
      if (s.status === 200) {
        const j = JSON.parse(s.bytes.toString("utf8"));
        if (typeof j.text === "string" && typeof j.signature === "string") {
          base.signature = {
            text: j.text,
            signature: j.signature,
            signing_address: j.signing_address,
            signing_algo: j.signing_algo,
            signature_kind: j.signature_kind,
          };
          break;
        }
        lastErr = `signature 200 without text/signature: ${s.bytes.toString("utf8").slice(0, 160)}`;
      } else lastErr = `signature HTTP ${s.status}`;
    } catch (e) {
      lastErr = `signature: ${(e as Error).message}`;
    }
    if (i < tries) await new Promise((res) => setTimeout(res, gapMs));
  }
  base.signatureMs = Math.round(performance.now() - t0);
  if (!base.signature) base.error = lastErr;
  return base;
}
