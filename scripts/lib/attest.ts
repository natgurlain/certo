// Fetch, save and bind-check the jurors' attestation reports; write jurors.json.
// Used by scripts/fetch-attestations.ts and scripts/killtest.ts (step 2 of DESIGN 6.5).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { JURORS, fetchAttestation, nearaiBaseUrl } from "./nearai.ts";
import { checkReport } from "./tdx.ts";
import type { JurorsFile } from "./jurors-file.ts";
import { fileExists, modelSlug, readJson, repoPath, repoRel, REPO_ROOT, sha256Hex, table, writeJson } from "./util.ts";

/** Repo-relative when inside the repository, absolute otherwise (mock runs in a temp dir). */
function storedPath(abs: string): string {
  return abs.startsWith(REPO_ROOT + "/") ? repoRel(abs) : abs;
}

/** Resolve a report path from jurors.json; `fixturesRoot` replaces the leading `fixtures/` (verify --root). */
export function resolveReportPath(p: string, fixturesRoot?: string): string {
  if (isAbsolute(p)) return p;
  if (fixturesRoot && p.startsWith("fixtures/")) return join(fixturesRoot, p.slice("fixtures/".length));
  return repoPath(p);
}

export interface AttestOutcome {
  jurors: JurorsFile;
  problems: string[];
  printed: string;
}

export async function fetchAttestations(opts: { dir: string; jurorsPath: string; force?: boolean }): Promise<AttestOutcome> {
  const fetchedAt = new Date();
  for (const j of JURORS) {
    const p = join(opts.dir, `${modelSlug(j.model)}.json`);
    if (fileExists(p) && !opts.force)
      throw new Error(`${storedPath(p)} exists; reports are evidence and are not overwritten. Use --force to refetch today.`);
  }
  mkdirSync(opts.dir, { recursive: true });

  const results = await Promise.all(
    JURORS.map(async (j) => {
      const r = await fetchAttestation(j.model);
      if (r.status !== 200) throw new Error(`${j.model}: attestation HTTP ${r.status}: ${r.bytes.toString("utf8").slice(0, 300)}`);
      const path = join(opts.dir, `${modelSlug(j.model)}.json`);
      writeFileSync(path, r.bytes); // raw bytes as received; the SHA-256 is over these
      const chk = checkReport(JSON.parse(r.bytes.toString("utf8")), j.model, r.nonce);
      return { j, r, path, chk };
    }),
  );

  const problems = results.flatMap((x) => x.chk.problems.map((p) => `${x.j.model}: ${p}`));
  const gatewayKeys = new Set(results.map((x) => x.chk.gateway.publicKey));
  if (gatewayKeys.size !== 1) problems.push(`gateway key differs between reports: ${[...gatewayKeys].join(", ")}`);

  const prev: JurorsFile | null = fileExists(opts.jurorsPath) ? readJson<JurorsFile>(opts.jurorsPath) : null;
  const keysNow = results.map((x) => x.chk.model.publicKey);
  const sameKeys =
    prev !== null &&
    prev.gateway.public_key === results[0].chk.gateway.publicKey &&
    prev.jurors.length === keysNow.length &&
    prev.jurors.every((pj, i) => pj.model === JURORS[i].model && pj.public_key === keysNow[i]);
  const epoch = prev === null ? 1 : sameKeys ? prev.epoch : prev.epoch + 1;
  const previous_epochs =
    prev === null
      ? []
      : sameKeys
        ? (prev.previous_epochs ?? [])
        : [
            ...(prev.previous_epochs ?? []),
            {
              epoch: prev.epoch,
              fetched_at: prev.fetched_at,
              gateway_public_key: prev.gateway.public_key,
              jurors: prev.jurors.map(({ model, public_key, report_path, report_sha256 }) => ({ model, public_key, report_path, report_sha256 })),
            },
          ];

  const g0 = results[0];
  const jurors: JurorsFile = {
    version: 1,
    epoch,
    fetched_at: fetchedAt.toISOString(),
    source: `${nearaiBaseUrl()}/v1/attestation/report?model=<id>&provider=near&nonce=<64 hex>&signing_algo=ed25519&include_tls_fingerprint=false (header x-no-aliasing: true)`,
    signing_algo: "ed25519",
    binding_check:
      "TDX REPORTDATA = ed25519 public key (32 bytes) || nonce (32 bytes); quote signature, Intel/NVIDIA certificate chains and event log NOT verified (docs/VERIFY.md)",
    gateway: {
      public_key: g0.chk.gateway.publicKey,
      report_path: storedPath(g0.path),
      report_pointer: "/gateway_attestation",
      report_sha256: sha256Hex(g0.r.bytes),
      nonce: g0.r.nonce,
      binding_ok: results.every((x) => x.chk.gateway.ok),
    },
    jurors: results.map((x) => ({
      index: x.j.index,
      model: x.j.model,
      buyer_letter: x.j.buyerLabel,
      public_key: x.chk.model.publicKey,
      report_path: storedPath(x.path),
      report_sha256: sha256Hex(x.r.bytes),
      report_bytes: x.r.bytes.length,
      nonce: x.r.nonce,
      binding_ok: x.chk.model.ok,
      fetch_ms: x.r.ms,
    })),
    previous_epochs,
  };
  writeJson(opts.jurorsPath, jurors);

  const printed = [
    table(
      ["juror", "model", "ed25519 public key", "bytes", "ms", "key+nonce in quote"],
      results.map((x) => [x.j.index, x.j.model, x.chk.model.publicKey, x.r.bytes.length, x.r.ms, x.chk.model.ok ? "yes" : "NO"]),
    ),
    `gateway key ${g0.chk.gateway.publicKey}  key+nonce in quote: ${jurors.gateway.binding_ok ? "yes (all 3 reports)" : "NO"}`,
    `epoch ${epoch}${prev && !sameKeys ? " (keys changed since " + prev.fetched_at + ")" : prev ? " (keys unchanged)" : ""}`,
  ].join("\n");
  return { jurors, problems, printed };
}

/** Re-check saved reports against jurors.json: file hash, key and nonce binding. */
export function recheckAttestations(jf: JurorsFile, fixturesRoot?: string): { rows: (string | number)[][]; problems: string[] } {
  const rows: (string | number)[][] = [];
  const problems: string[] = [];
  const reports = new Map<string, any>();
  for (const j of jf.jurors) {
    const path = resolveReportPath(j.report_path, fixturesRoot);
    if (!fileExists(path)) {
      problems.push(`${j.model}: report ${j.report_path} missing`);
      rows.push([j.index, j.model, "missing", "-", "-"]);
      continue;
    }
    const bytes = readFileSync(path);
    const hashOk = sha256Hex(bytes) === j.report_sha256;
    let bindOk = false;
    let keyOk = false;
    let detail = "";
    try {
      const report = JSON.parse(bytes.toString("utf8"));
      reports.set(j.report_path, report);
      const chk = checkReport(report, j.model, j.nonce);
      keyOk = chk.model.publicKey === j.public_key;
      bindOk = chk.model.ok && chk.problems.length === 0;
      detail = chk.problems.join("; ");
    } catch (e) {
      detail = (e as Error).message;
    }
    if (!hashOk) problems.push(`${j.model}: report SHA-256 differs from jurors.json`);
    if (!keyOk) problems.push(`${j.model}: report key differs from jurors.json`);
    if (!bindOk) problems.push(`${j.model}: binding: ${detail}`);
    rows.push([j.index, j.model, hashOk ? "ok" : "MISMATCH", keyOk ? "ok" : "MISMATCH", bindOk ? "ok" : "FAIL"]);
  }
  const g = reports.get(jf.gateway.report_path)?.gateway_attestation;
  if (!g) problems.push("gateway: report not readable");
  else if (g.signing_address !== jf.gateway.public_key) problems.push("gateway: key differs from jurors.json");
  return { rows, problems };
}
