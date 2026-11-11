// Ask the three jurors about one case, verify each ballot offline, and summarise
// (shared by killtest and probe).
import { JURORS, buildPanelRequestFor, majority, type Side, type Vote } from "@certo/core";
import { askJuror, type Ballot } from "./nearai.ts";
import { ballotToRecording, checkRecording, contentShape, saveRecording, usageOf } from "./ballots.ts";
import type { JurorsFile } from "./jurors-file.ts";
import { repoRel, REPO_ROOT, table } from "./util.ts";

export interface Prices {
  [model: string]: { inUsd: number; outUsd: number };
}

export function pricesFromModelList(models: any[]): Prices {
  const p: Prices = {};
  const usd = (c: any) => (c && typeof c.amount === "number" ? c.amount / 10 ** (c.scale ?? 9) : 0);
  for (const m of models) p[m.modelId ?? m.id] = { inUsd: usd(m.inputCostPerToken), outUsd: usd(m.outputCostPerToken) };
  return p;
}

export interface Evidence {
  request_canon: string;
  response_body: string;
}

export interface BallotResult {
  juror: number;
  model: string;
  vote: Vote | "none";
  side: Side | "abstain";
  sig_ok: boolean;
  kind: string;
  algo: string;
  req_hash_match: boolean;
  resp_hash_match: boolean;
  latency_ms: number;
  signature_ms: number;
  signature_tries: number;
  chat_id: string | null;
  http_status: number;
  tokens: { prompt: number; completion: number };
  cost_usd: number;
  shape: string;
  recording: string | null;
  error?: string;
}

export interface CaseRun {
  ballots: BallotResult[];
  verdict: Side | null;
  wall_ms: number; // first request → all three answers and signatures fetched and verified
}

export interface RunContext {
  apiKey: string;
  termsText: string;
  jurors: JurorsFile;
  prices: Prices;
  panelDir: string | null; // where to save recordings; null = do not save
}

/** One case on the panel: three jurors in parallel, each body built by @certo/core. */
export async function runCase(ctx: RunContext, c: { buyer_offer_pct: number; seller_offer_pct: number }, evidenceFor: (juror: number) => Evidence): Promise<CaseRun> {
  const t0 = performance.now();
  const ballots = await Promise.all(
    JURORS.map(async (j): Promise<BallotResult> => {
      const ev = evidenceFor(j.index);
      const body = buildPanelRequestFor({
        jurorIndex: j.index,
        termsText: ctx.termsText,
        requestCanon: ev.request_canon,
        responseBody: ev.response_body,
        buyerOfferBps: c.buyer_offer_pct * 100,
        sellerOfferBps: c.seller_offer_pct * 100,
      });
      const b: Ballot = await askJuror(ctx.apiKey, j.model, body);
      return summarise(ctx, j.index, b);
    }),
  );
  const wall_ms = Math.round(performance.now() - t0);
  return { ballots, verdict: majority(ballots.map((b) => b.side)), wall_ms };
}

function summarise(ctx: RunContext, juror: number, b: Ballot): BallotResult {
  const responseText = b.responseBytes.toString("utf8");
  const tokens = usageOf(responseText);
  const price = ctx.prices[b.model] ?? { inUsd: 0, outUsd: 0 };
  const out: BallotResult = {
    juror,
    model: b.model,
    vote: "none",
    side: "abstain",
    sig_ok: false,
    kind: b.signature?.signature_kind ?? "-",
    algo: b.signature?.signing_algo ?? "-",
    req_hash_match: false,
    resp_hash_match: false,
    latency_ms: b.latencyMs,
    signature_ms: b.signatureMs,
    signature_tries: b.signatureTries,
    chat_id: b.chatId,
    http_status: b.httpStatus,
    tokens,
    cost_usd: Number((tokens.prompt * price.inUsd + tokens.completion * price.outUsd).toFixed(8)),
    shape: b.httpStatus === 200 ? contentShape(responseText) : "-",
    recording: null,
    error: b.error,
  };
  const rec = ballotToRecording(b);
  if (!rec) return out;
  const v = checkRecording(rec, ctx.jurors);
  out.vote = v.vote;
  out.side = v.side;
  out.sig_ok = v.ok;
  out.kind = v.kind;
  out.algo = v.algo;
  out.req_hash_match = v.requestHashMatch;
  out.resp_hash_match = v.responseHashMatch;
  if (!v.ok) out.error = [out.error, v.reason].filter(Boolean).join("; ");
  if (ctx.panelDir) {
    const s = saveRecording(rec, ctx.panelDir);
    out.recording = s.path.startsWith(REPO_ROOT + "/") ? repoRel(s.path) : s.path;
  }
  return out;
}

/** K4 table: per juror, what the signatures looked like. */
export function k4Table(all: BallotResult[]): { text: string; pass: boolean; perJuror: { model: string; pass: boolean; detail: string }[] } {
  const perJuror = JURORS.map((j) => {
    const bs = all.filter((b) => b.juror === j.index);
    const signed = bs.filter((b) => b.kind !== "-");
    const kinds = [...new Set(signed.map((b) => b.kind))].join(",") || "none";
    const algos = [...new Set(signed.map((b) => b.algo))].join(",") || "none";
    const req = bs.filter((b) => b.req_hash_match).length;
    const ver = bs.filter((b) => b.sig_ok).length;
    const lat = bs.map((b) => b.latency_ms).sort((a, b) => a - b);
    const shapes = new Map<string, number>();
    for (const b of bs) shapes.set(b.shape, (shapes.get(b.shape) ?? 0) + 1);
    const shape = [...shapes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "-";
    const pass = bs.length > 0 && kinds === "provider_tee" && algos === "ed25519" && req === bs.length && ver === bs.length;
    return {
      model: j.model,
      pass,
      row: [j.index, j.model, kinds, algos, `${req}/${bs.length}`, `${ver}/${bs.length}`, lat.length ? `${lat[Math.floor(lat.length / 2)]} ms` : "-", shape, pass ? "PASS" : "FAIL"],
      detail: `kind ${kinds}, algo ${algos}, request hash ${req}/${bs.length}, verified ${ver}/${bs.length}`,
    };
  });
  const text = table(["juror", "model", "kind", "algo", "req hash = sha256(sent)", "sig verified", "median latency", "content shape (most common)", "K4"], perJuror.map((p) => p.row));
  return { text, pass: perJuror.every((p) => p.pass), perJuror: perJuror.map(({ model, pass, detail }) => ({ model, pass, detail })) };
}
