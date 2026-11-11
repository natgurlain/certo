// Record juror ballots (DESIGN 4.4 "Replay mode") for given cases or request bodies,
// one file per ballot: <out>/<sha256 of request body>.json.
//
//   npx tsx scripts/record.ts [--cases <file.jsonl>] [--bodies <file.jsonl>] [--ids A,B] [--out dir] [--overwrite]
//   npx tsx scripts/record.ts --synthetic [same inputs]       # test-key ballots, marked synthetic: true
//
// --cases: one case per line, either the kill-test shape {request_canon, response_body,
//   buyer_offer_pct, seller_offer_pct, label?, terms_text?} or the core CaseInput shape
//   {termsText, requestCanon, responseBody, buyerOfferBps, sellerOfferBps, side?}; each case
//   becomes three request bodies (one per juror) built by @certo/core. Terms default to
//   fixtures/killtest/terms.json.
// --bodies: one exact chat-completions request body per line, as {"request_body": "...", "side"?: ...}.
// With no input, records fixtures/demo/cases.jsonl if present, else the 60 kill-test cases.
// Live mode needs NEARAI_API_KEY. In --synthetic mode each ballot votes for the line's
// `label`/`side` (buyer|seller); lines without one are refused.
import { readFileSync } from "node:fs";
import { JURORS, buildPanelRequestFor, labelsFor, makeSyntheticBallot } from "@certo/core";
import { apiKeyOrExit, askJuror } from "./lib/nearai.ts";
import { PANEL_DIR, ballotToRecording, checkRecording, jurorIndexOf, saveRecording } from "./lib/ballots.ts";
import { loadTerms } from "./lib/cases.ts";
import type { JurorsFile } from "./lib/jurors-file.ts";
import { fileExists, parseArgs, pool, readJson, repoPath, repoRel, table } from "./lib/util.ts";

const args = parseArgs();
const SYNTH = args.synthetic === true;
const out = typeof args.out === "string" ? args.out : PANEL_DIR;
const onlyIds = typeof args.ids === "string" ? new Set(args.ids.split(",")) : null;

interface Item {
  source: string;
  model: string;
  requestBody: string;
  side: "buyer" | "seller" | null;
}

function lines(path: string): any[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new Error(`${path}:${i + 1}: not JSON`);
      }
    });
}

const items: Item[] = [];
let casesPath = typeof args.cases === "string" ? args.cases : null;
const bodiesPath = typeof args.bodies === "string" ? args.bodies : null;
if (!casesPath && !bodiesPath) {
  const demo = repoPath("fixtures", "demo", "cases.jsonl");
  casesPath = fileExists(demo) ? demo : repoPath("fixtures", "killtest", "cases.jsonl");
  console.log(`no --cases/--bodies given; using ${repoRel(casesPath)}`);
}
if (casesPath) {
  const terms = loadTerms();
  for (const [i, c] of lines(casesPath).entries()) {
    const id = c.id ?? `line${i + 1}`;
    if (onlyIds && !onlyIds.has(id)) continue;
    const side = c.label ?? c.side ?? null;
    for (const j of JURORS) {
      const requestBody = buildPanelRequestFor({
        jurorIndex: j.index,
        termsText: c.termsText ?? c.terms_text ?? terms.text,
        requestCanon: c.requestCanon ?? c.request_canon,
        responseBody: c.responseBody ?? c.response_body,
        buyerOfferBps: c.buyerOfferBps ?? c.buyer_offer_pct * 100,
        sellerOfferBps: c.sellerOfferBps ?? c.seller_offer_pct * 100,
      });
      items.push({ source: `${id}/juror${j.index}`, model: j.model, requestBody, side });
    }
  }
}
if (bodiesPath)
  for (const [i, b] of lines(bodiesPath).entries()) {
    const requestBody = typeof b === "string" ? b : b.request_body;
    const model = JSON.parse(requestBody).model;
    if (jurorIndexOf(model) < 0) throw new Error(`${bodiesPath}:${i + 1}: model ${model} is not a juror`);
    items.push({ source: `${bodiesPath.split("/").pop()}:${i + 1}`, model, requestBody, side: typeof b === "object" ? (b.side ?? b.label ?? null) : null });
  }
if (!items.length) {
  console.error("record: nothing to record");
  process.exit(2);
}

const rows: (string | number)[][] = [];
let failed = 0;
if (SYNTH) {
  for (const it of items) {
    if (it.side !== "buyer" && it.side !== "seller") throw new Error(`${it.source}: --synthetic needs a label/side (buyer|seller)`);
    const ji = jurorIndexOf(it.model);
    const rec = makeSyntheticBallot({ jurorIndex: ji, model: it.model, requestBody: it.requestBody, responseContent: labelsFor(ji)[it.side], recordedAt: new Date().toISOString() });
    const v = checkRecording(rec, null);
    const s = saveRecording(rec, out);
    if (!v.ok) failed++;
    rows.push([it.source, it.model, "SYNTHETIC", v.vote, v.ok ? "ok" : `FAIL ${v.reason}`, s.written ? "written" : `skipped (${s.why})`]);
  }
} else {
  const apiKey = apiKeyOrExit("record");
  const jp = repoPath("fixtures", "jurors.json");
  const jf: JurorsFile | null = fileExists(jp) ? readJson<JurorsFile>(jp) : null;
  if (!jf) console.warn("no fixtures/jurors.json: run scripts/fetch-attestations.ts first or ballots cannot be verified");
  const results = await pool(items, 4, async (it) => {
    const b = await askJuror(apiKey, it.model, it.requestBody);
    const rec = ballotToRecording(b);
    if (!rec) return [it.source, it.model, "real", "-", `FAIL ${b.error}`, "not written"];
    const v = checkRecording(rec, jf);
    if (!v.ok) {
      failed++;
      return [it.source, it.model, "real", v.vote, `FAIL ${v.reason}`, "not written"];
    }
    const s = saveRecording(rec, out, args.overwrite === true);
    return [it.source, it.model, `real ${v.kind}`, v.vote, `ok (${b.latencyMs} ms)`, s.written ? "written" : `skipped (${s.why})`];
  });
  rows.push(...results);
}
console.log(table(["source", "model", "kind", "vote", "verify", "file"], rows));
console.log(`${items.length - failed}/${items.length} ballots verified; directory ${out.startsWith(repoPath()) ? repoRel(out) : out}`);
process.exit(failed ? 1 : 0);
