// Recording format (DESIGN 4.4 "Replay mode") and offline ballot checks shared by
// probe, killtest, record and verify-recorded.
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  JURORS,
  decodePublicKey,
  parseVote,
  recordingFileName,
  recordingResponseBody,
  syntheticJurorKey,
  toHex,
  verifyRecording,
  voteToSide,
  type PanelRecording,
  type Side,
  type Vote,
} from "@makegood/core";
import type { Ballot } from "./nearai.ts";
import { knownKeys, type JurorsFile } from "./jurors-file.ts";
import { fileExists, readJson, repoPath, sha256Hex } from "./util.ts";

export const PANEL_DIR = repoPath("fixtures", "panel");

export function jurorIndexOf(model: string): number {
  const j = JURORS.find((x) => x.model === model);
  return j ? j.index : -1;
}

export function ballotToRecording(b: Ballot): PanelRecording | null {
  if (!b.signature || !b.chatId) return null;
  return {
    model: b.model,
    request_body: b.requestBody,
    response_body_b64: b.responseBytes.toString("base64"),
    chat_id: b.chatId,
    signature: {
      text: b.signature.text,
      signature: b.signature.signature,
      signing_address: b.signature.signing_address,
      signing_algo: b.signature.signing_algo,
      signature_kind: (b.signature.signature_kind ?? "provider_tee") as "provider_tee" | "gateway",
    },
    latency_ms: b.latencyMs,
    recorded_at: new Date().toISOString(),
  };
}

/**
 * Write `<dir>/<sha256 of request body>.json`. A real recording is never replaced
 * by a synthetic one; a real one replaces a synthetic one; an existing real one is
 * kept unless `overwrite` (repeat asks of the same body keep the first answer).
 */
export function saveRecording(rec: PanelRecording, dir = PANEL_DIR, overwrite = false): { path: string; written: boolean; why?: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, recordingFileName(rec.request_body));
  if (fileExists(path)) {
    const old = readJson<PanelRecording>(path);
    if (rec.synthetic && !old.synthetic) return { path, written: false, why: "real recording exists" };
    if (!rec.synthetic && !old.synthetic && !overwrite) return { path, written: false, why: "kept first real recording" };
  }
  writeFileSync(path, JSON.stringify(rec, null, 2) + "\n");
  return { path, written: true };
}

export function listRecordings(dir = PANEL_DIR): string[] {
  if (!fileExists(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f));
}

export interface BallotVerdict {
  ok: boolean;
  synthetic: boolean;
  model: string;
  juror: number;
  kind: string;
  algo: string;
  /** The request hash inside the signed text equals sha256(request body we sent). */
  requestHashMatch: boolean;
  responseHashMatch: boolean;
  /** Which registered key verified it (epoch, role), or null. */
  keyEpoch: number | null;
  keyRole: "juror" | "gateway" | "synthetic" | null;
  vote: Vote;
  side: Side | "abstain";
  reason?: string;
}

/** Split a signed text into (model | null, request hash, response hash). */
export function parseSignedText(text: string): { model: string | null; req: string; resp: string } | null {
  const parts = text.split(":");
  if (parts.length < 2) return null;
  const resp = parts[parts.length - 1];
  const req = parts[parts.length - 2];
  const model = parts.length > 2 ? parts.slice(0, -2).join(":") : null;
  if (!/^[0-9a-f]{64}$/.test(req) || !/^[0-9a-f]{64}$/.test(resp)) return null;
  return { model, req, resp };
}

/**
 * Offline check of one recording. Real ballots must verify under a key from
 * jurors.json (current or previous epoch): the model's key for `provider_tee`,
 * the gateway key for `gateway`. Synthetic ballots verify only under the
 * deterministic test keys of `makeSyntheticBallot` and are reported as such.
 */
export function checkRecording(rec: PanelRecording, jf: JurorsFile | null, opts: { syntheticSeed?: string } = {}): BallotVerdict {
  const juror = jurorIndexOf(rec.model);
  const responseBody = recordingResponseBody(rec);
  const vote = parseVote(responseBody);
  const side = juror >= 0 ? voteToSide(juror, vote) : "abstain";
  const parsed = parseSignedText(rec.signature?.text ?? "");
  const base: BallotVerdict = {
    ok: false,
    synthetic: rec.synthetic === true,
    model: rec.model,
    juror,
    kind: rec.signature?.signature_kind ?? "?",
    algo: rec.signature?.signing_algo ?? "?",
    requestHashMatch: parsed !== null && parsed.req === sha256Hex(rec.request_body),
    responseHashMatch: parsed !== null && parsed.resp === sha256Hex(Buffer.from(rec.response_body_b64, "base64")),
    keyEpoch: null,
    keyRole: null,
    vote,
    side,
  };
  const fail = (reason: string): BallotVerdict => ({ ...base, reason });
  if (juror < 0) return fail(`model ${rec.model} is not a juror`);
  let bodyModel: unknown;
  try {
    bodyModel = JSON.parse(rec.request_body).model;
  } catch {
    return fail("request_body is not JSON");
  }
  if (bodyModel !== rec.model) return fail(`request_body names model ${String(bodyModel)}, recording says ${rec.model}`);
  let signer: string;
  try {
    signer = toHex(decodePublicKey(rec.signature?.signing_address ?? "")); // hex, 0x-hex, base64 or ed25519:<base58>
  } catch {
    return fail(`signing_address ${rec.signature?.signing_address} is not an ed25519 public key`);
  }
  const synthKeys = [juror, -1].map((i) => toHex(syntheticJurorKey(i, opts.syntheticSeed).publicKey));

  if (base.synthetic) {
    const expected = base.kind === "gateway" ? synthKeys[1] : synthKeys[0];
    const r = verifyRecording(rec, expected);
    return r.ok ? { ...base, ok: true, keyRole: "synthetic" } : fail(`synthetic: ${r.reason}`);
  }
  if (synthKeys.includes(signer)) return fail("signed by a synthetic test key but not marked synthetic");
  if (!jf) return fail("no fixtures/jurors.json to check a real ballot against");
  const candidates = knownKeys(jf).filter((k) =>
    base.kind === "gateway" ? k.role === "gateway" : k.role === "juror" && k.model === rec.model,
  );
  const match = candidates.find((k) => k.public_key === signer);
  if (!match) return fail(`signing key ${signer.slice(0, 16)}… is not a registered ${base.kind === "gateway" ? "gateway" : rec.model} key`);
  const r = verifyRecording(rec, match.public_key);
  return r.ok ? { ...base, ok: true, keyEpoch: match.epoch, keyRole: match.role } : fail(r.reason ?? "verification failed");
}

/** What the completion looked like (K4 table "content shape"). */
export function contentShape(responseBody: string): string {
  try {
    const j = JSON.parse(responseBody);
    const m = j?.choices?.[0]?.message ?? {};
    const content = typeof m.content === "string" ? m.content : m.content === null ? null : undefined;
    const parts: string[] = [];
    if (content === undefined) parts.push("no content");
    else if (content === null) parts.push("content null");
    else {
      const think = content.startsWith("<think>");
      parts.push(think ? "<think>+" : "", JSON.stringify(content.length > 12 ? content.slice(-12) : content));
    }
    if (m.reasoning_content || m.reasoning) parts.push(`reasoning ${String(m.reasoning_content ?? m.reasoning).length} ch`);
    if (j?.choices?.[0]?.finish_reason && j.choices[0].finish_reason !== "stop") parts.push(`finish=${j.choices[0].finish_reason}`);
    return parts.filter(Boolean).join(" ");
  } catch {
    return "not JSON";
  }
}

export function usageOf(responseBody: string): { prompt: number; completion: number } {
  try {
    const u = JSON.parse(responseBody)?.usage ?? {};
    return { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0 };
  } catch {
    return { prompt: 0, completion: 0 };
  }
}
