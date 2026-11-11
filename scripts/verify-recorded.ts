// `make verify` (DESIGN T17): offline, no chain, no key. Rechecks every committed
// attestation report (SHA-256 against fixtures/jurors.json, ed25519 key and nonce in
// the TDX quote's REPORTDATA) and every recorded ballot in fixtures/panel/*.json
// (file name = sha256 of the request body, signed text rebuilt from sha256 of the
// request and response bytes, ed25519 signature under the registered juror key).
// Synthetic ballots verify only under their published test keys and are counted
// separately; they are never reported as real.
//
//   npx tsx scripts/verify-recorded.ts [--root <fixtures dir>] [--verbose]
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { recordingFileName, type PanelRecording } from "@makegood/core";
import { recheckAttestations, resolveReportPath } from "./lib/attest.ts";
import { checkRecording, listRecordings } from "./lib/ballots.ts";
import type { JurorsFile } from "./lib/jurors-file.ts";
import { fileExists, parseArgs, repoPath, sha256Hex, table } from "./lib/util.ts";

const args = parseArgs();
const root = typeof args.root === "string" ? args.root : repoPath("fixtures");
const verbose = args.verbose === true || args.v === true;
const failures: string[] = [];

// ---- attestation binding ----
const jurorsPath = join(root, "jurors.json");
let jf: JurorsFile | null = null;
if (fileExists(jurorsPath)) {
  jf = JSON.parse(readFileSync(jurorsPath, "utf8")) as JurorsFile;
  const r = recheckAttestations(jf, typeof args.root === "string" ? root : undefined);
  console.log(`jurors.json epoch ${jf.epoch}, fetched ${jf.fetched_at}; gateway ${jf.gateway.public_key.slice(0, 16)}…`);
  if (!jf.source.startsWith("https://cloud-api.near.ai/"))
    console.log(`NOTE: this jurors.json was fetched from ${jf.source.split("/v1/")[0]}, not NEAR AI Cloud; "real" below only means "signed by a key in this file".`);
  console.log(table(["juror", "model", "report sha256", "key = jurors.json", "key+nonce in TDX quote"], r.rows));
  failures.push(...r.problems.map((p) => `attestation: ${p}`));
  for (const p of jf.previous_epochs ?? [])
    for (const j of p.jurors) {
      const path = resolveReportPath(j.report_path, typeof args.root === "string" ? root : undefined);
      if (!fileExists(path)) failures.push(`attestation: epoch ${p.epoch} report ${j.report_path} missing`);
      else if (sha256Hex(readFileSync(path)) !== j.report_sha256) failures.push(`attestation: epoch ${p.epoch} report ${j.report_path} SHA-256 differs`);
    }
} else console.log(`no ${jurorsPath}: real ballots cannot be checked`);

// ---- ballots ----
const files = listRecordings(join(root, "panel"));
let real = 0;
let synthetic = 0;
const perModel = new Map<string, { real: number; synthetic: number; votes: string[] }>();
for (const f of files) {
  const name = basename(f);
  let rec: PanelRecording;
  try {
    rec = JSON.parse(readFileSync(f, "utf8"));
  } catch (e) {
    failures.push(`${name}: not JSON (${(e as Error).message})`);
    continue;
  }
  if (typeof rec.request_body !== "string" || typeof rec.response_body_b64 !== "string" || !rec.signature) {
    failures.push(`${name}: not a recording`);
    continue;
  }
  if (recordingFileName(rec.request_body) !== name) {
    failures.push(`${name}: file name is not sha256(request_body)`);
    continue;
  }
  const v = checkRecording(rec, jf);
  const label = v.synthetic ? "SYNTHETIC" : "real";
  if (!v.ok) {
    failures.push(`${name}: ${label} ballot from ${rec.model} FAILS: ${v.reason}`);
    continue;
  }
  if (v.synthetic) synthetic++;
  else real++;
  const m = perModel.get(rec.model) ?? { real: 0, synthetic: 0, votes: [] };
  m[v.synthetic ? "synthetic" : "real"]++;
  m.votes.push(v.vote);
  perModel.set(rec.model, m);
  if (verbose)
    console.log(`  ${name.slice(0, 16)}… ${label.padEnd(9)} ${rec.model.padEnd(36)} ${v.kind}${v.keyEpoch ? ` epoch ${v.keyEpoch}` : ""} vote ${v.vote}`);
}
if (files.length)
  console.log(
    table(
      ["model", "real", "SYNTHETIC", "votes X/Y/abstain"],
      [...perModel.entries()].map(([m, c]) => [m, c.real, c.synthetic, ["X", "Y", "abstain"].map((x) => c.votes.filter((v) => v === x).length).join("/")]),
    ),
  );
else console.log(`no recordings in ${join(root, "panel")} yet (they come from probe, killtest or record)`);

if (failures.length) {
  console.error(`\nVERIFY FAILED: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
const n = real + synthetic;
console.log(`\nVERIFY OK: ${n} ballots (${real} real, ${synthetic} synthetic)${synthetic ? " — synthetic ballots are signed with published test keys and prove nothing about NEAR AI" : ""}`);
console.log("Attestation check is key+nonce binding only; Intel/NVIDIA certificate chains are not verified (docs/VERIFY.md).");
