// T03 signature probe (DESIGN 2.1, 6.4 K4): one non-streaming call per juror with a
// body built by @makegood/core, fetch the ed25519 signature, verify offline against
// fixtures/jurors.json, and print the K4 table. Verified ballots are saved as the first
// fixtures/panel/*.json recordings.
//
//   npx tsx scripts/probe.ts [--case B1-03] [--refresh-attestations]   # needs NEARAI_API_KEY
//   npx tsx scripts/probe.ts --mock                                       # local fake panel, outputs in a temp dir
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JURORS, buildPanelRequestFor, sha256Hex } from "@makegood/core";
import { apiKeyOrExit, askJuror, httpRaw, nearaiBaseUrl } from "./lib/nearai.ts";
import { fetchAttestations, recheckAttestations } from "./lib/attest.ts";
import { PANEL_DIR, ballotToRecording, checkRecording, contentShape, parseSignedText, saveRecording } from "./lib/ballots.ts";
import { loadCases, loadTerms } from "./lib/cases.ts";
import { startMockJurors, oracleKey } from "./lib/mock-jurors.ts";
import type { JurorsFile } from "./lib/jurors-file.ts";
import { fileExists, parseArgs, readJson, repoPath, repoRel, table, utcDate } from "./lib/util.ts";

const args = parseArgs();
const MOCK = args.mock === true;
const caseId = typeof args.case === "string" ? args.case : "B1-03";
const c = loadCases("cases.jsonl").find((x) => x.id === caseId);
if (!c) throw new Error(`no case ${caseId} in fixtures/killtest/cases.jsonl`);
const terms = loadTerms();

let apiKey: string;
let jurors: JurorsFile;
let panelDir = PANEL_DIR;
let scratch: string;
let mock: Awaited<ReturnType<typeof startMockJurors>> | null = null;
if (MOCK) {
  mock = await startMockJurors(new Map([[oracleKey(c.request_canon, c.response_body), { label: c.label }]]));
  process.env.NEARAI_BASE_URL = mock.url;
  apiKey = "mock-key";
  scratch = mkdtempSync(join(tmpdir(), "probe-mock-"));
  panelDir = join(scratch, "panel");
  const a = await fetchAttestations({ dir: join(scratch, "attestations"), jurorsPath: join(scratch, "jurors.json") });
  jurors = a.jurors;
  console.log(`MOCK panel at ${mock.url}; outputs in ${scratch} (not evidence)`);
} else {
  apiKey = apiKeyOrExit("probe");
  scratch = mkdtempSync(join(tmpdir(), "probe-"));
  const jp = repoPath("fixtures", "jurors.json");
  if (!fileExists(jp) || args["refresh-attestations"]) {
    const a = await fetchAttestations({ dir: repoPath("fixtures", "attestations", utcDate()), jurorsPath: jp, force: args["refresh-attestations"] === true });
    console.log(a.printed);
    jurors = a.jurors;
  } else {
    jurors = readJson<JurorsFile>(jp);
    const r = recheckAttestations(jurors);
    if (r.problems.length) throw new Error("attestation recheck: " + r.problems.join("; "));
    console.log(`using fixtures/jurors.json epoch ${jurors.epoch} (${jurors.fetched_at}); reports rechecked`);
  }
}

console.log(`probing ${nearaiBaseUrl()} with case ${c.id} (label ${c.label}), three jurors in parallel…`);
const t0 = performance.now();
const results = await Promise.all(
  JURORS.map(async (j) => {
    const body = buildPanelRequestFor({
      jurorIndex: j.index,
      termsText: terms.text,
      requestCanon: c.request_canon,
      responseBody: c.response_body,
      buyerOfferBps: c.buyer_offer_pct * 100,
      sellerOfferBps: c.seller_offer_pct * 100,
    });
    const b = await askJuror(apiKey, j.model, body);
    let ecdsa = "-";
    if (!b.signature && b.chatId) {
      // L1 fallback question: is there at least an ECDSA signature?
      const r = await httpRaw("GET", `${nearaiBaseUrl()}/v1/signature/${encodeURIComponent(b.chatId)}?model=${encodeURIComponent(j.model)}&signing_algo=ecdsa`, {
        headers: { Authorization: `Bearer ${apiKey}`, "x-no-aliasing": "true" },
      }).catch((e) => ({ status: 0, bytes: Buffer.from(String(e)) }));
      ecdsa = r.status === 200 ? "available" : `HTTP ${r.status}`;
    }
    const rec = ballotToRecording(b);
    const v = rec ? checkRecording(rec, jurors) : null;
    let saved = "-";
    if (rec && v?.ok) {
      const s = saveRecording(rec, panelDir);
      saved = s.written ? (s.path.startsWith(repoPath()) ? repoRel(s.path) : s.path) : `kept existing (${s.why})`;
    }
    const signed = b.signature ? parseSignedText(b.signature.text) : null;
    return { j, b, v, body, signed, ecdsa, saved };
  }),
);
const wallMs = Math.round(performance.now() - t0);
if (mock) await mock.close();

const raw = join(scratch, "probe-raw.json");
writeFileSync(
  raw,
  JSON.stringify(
    results.map(({ j, b, v, body }) => ({
      model: j.model,
      request_body_sha256: sha256Hex(body),
      http_status: b.httpStatus,
      chat_id: b.chatId,
      response_body: b.responseBytes.toString("utf8"),
      signature: b.signature,
      error: b.error,
      verdict: v,
    })),
    null,
    2,
  ),
);

const yes = (x: boolean | undefined) => (x ? "yes" : "NO");
const rows = results.map(({ j, b, v, signed, ecdsa }) => [
  j.index,
  j.model,
  b.signature?.signature_kind ?? (b.signature ? "?" : "none"),
  b.signature?.signing_algo ?? "-",
  signed ? (signed.model === null ? "no (gateway form)" : signed.model === j.model ? "yes" : `other: ${signed.model}`) : "-",
  yes(v?.requestHashMatch),
  yes(v?.responseHashMatch),
  v ? (v.ok ? `yes (${v.keyRole}${v.keyEpoch ? " epoch " + v.keyEpoch : ""})` : `NO: ${v.reason}`) : `NO: ${b.error}`,
  `${b.latencyMs} ms`,
  `${b.signatureMs} ms / ${b.signatureTries} tries`,
  b.httpStatus === 200 ? contentShape(b.responseBytes.toString("utf8")) : `HTTP ${b.httpStatus}`,
  v?.vote ?? "-",
  ecdsa,
]);
const head = ["juror", "model", "signature_kind", "algo", "model in text", "req hash = sha256(sent)", "resp hash = sha256(recv)", "ed25519 verified (key)", "completion", "signature fetch", "content shape", "vote", "ecdsa (if no ed25519)"];
console.log("\nK4 probe");
console.log(table(head, rows));
const k4 = results.every(({ b, v }) => b.signature?.signature_kind === "provider_tee" && b.signature?.signing_algo === "ed25519" && v?.requestHashMatch && v?.ok);
const gw = results.every(({ b, v }) => b.signature?.signing_algo === "ed25519" && v?.requestHashMatch && v?.ok);
console.log(`\nwall clock (3 parallel answers + signatures + offline checks): ${wallMs} ms`);
console.log(
  `K4: ${k4 ? "PASS → level L3 (provider_tee, rebuildable request hash)" : gw ? "provider_tee missing but gateway ed25519 signatures verify → L3-gateway" : "FAIL → see DESIGN 2.1 fallbacks (L2 if the request hash does not match, L1 if no ed25519)"}`,
);
console.log(`recordings: ${results.map((r) => r.saved).join(", ")}`);
console.log(`raw responses and signatures: ${raw}`);
console.log("\nMarkdown for docs/KILLTEST.md (Probe section):\n");
console.log(`| ${head.join(" | ")} |\n|${head.map(() => "---").join("|")}|\n${rows.map((r) => `| ${r.map((x) => String(x).replace(/\|/g, "\\|")).join(" | ")} |`).join("\n")}`);
process.exit(k4 || gw ? 0 : 3);
