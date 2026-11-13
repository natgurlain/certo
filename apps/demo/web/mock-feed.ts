// Mock SSE feed for developing the demo page without the runner.
//
//   npx tsx apps/demo/web/mock-feed.ts            -> http://localhost:4020
//
// Serves apps/demo/web/ statically and replays a scripted run of the five
// scenes (docs/DESIGN.md 5.5 plus the forged vote) at /events, using the message shapes in
// apps/demo/EVENTS.md. Like the runner, it replays every message sent so far
// to each new client, so the page can be opened mid-run or after the run.
//
// Environment:
//   PORT=4020                 listen port
//   MOCK_MODE=replay-synthetic   live | replay | replay-synthetic
//   MOCK_STOP_AFTER=4         stop the script after scene N ends (screenshots)
//   MOCK_SPEED=1              time multiplier (2 = twice as fast)
//   MOCK_START=connect        connect: start when the first page connects; now: at once
//
// This is a development fixture: every number is scripted, nothing touches a chain.

import { createServer, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4020);
const MODE = process.env.MOCK_MODE ?? "replay-synthetic";
const STOP_AFTER = Number(process.env.MOCK_STOP_AFTER ?? 99);
const SPEED = Number(process.env.MOCK_SPEED ?? 1);
const START = process.env.MOCK_START ?? "connect";

type Msg = Record<string, unknown> & { kind: string };
const history: string[] = [];
const clients = new Set<ServerResponse>();

function send(msg: Msg): void {
  const line = `data: ${JSON.stringify({ ...msg, t: Date.now() })}\n\n`;
  history.push(line);
  for (const c of clients) c.write(line);
}

// Deterministic base58 tx hashes.
let seed = 0x2f6b1d;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const txHash = () => Array.from({ length: 44 }, () => B58[Math.floor(rnd() * 58)]).join("");
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join("");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms / SPEED));
const amt = (x: number) => x.toFixed(6);
const raw = (x: number) => String(Math.round(x * 1e6));
const chain = (event: string, data: Record<string, unknown>) => send({ kind: "chain", event, data, txHash: txHash() });

// Mutable mock ledger, mirrored into `state` snapshots.
const buyers: Record<string, number> = { agent: 10, "liar-agent": 10 };
const sellers: Record<string, { balance: number; bond: number; exposed: number; feeBps: number; calls: number; losses: number }> = {
  'honest-api': { balance: 0, bond: 50, exposed: 0, feeBps: 100, calls: 0, losses: 0 },
  'shady-api': { balance: 0, bond: 50, exposed: 0, feeBps: 100, calls: 0, losses: 0 },
};
function state(): void {
  send({
    kind: "state",
    buyers: Object.fromEntries(Object.entries(buyers).map(([k, v]) => [k, { balance: amt(v) }])),
    sellers: Object.fromEntries(
      Object.entries(sellers).map(([k, s]) => [
        k,
        { balance: amt(s.balance), bond: amt(s.bond), exposed: amt(s.exposed), feeBps: s.feeBps, record: { calls: s.calls, losses: s.losses } },
      ]),
    ),
  });
}

const FEE_STEPS = [50, 100, 150, 250, 500];
const PRICE = 0.4;
const STAKE = 0.02;
const REQUEST = "GET /v1/holders?token=NEAR&top=5";
const GOOD =
  '{"token":"NEAR","as_of":"2026-11-14T10:02:11Z","top":[{"account":"binance1.near","balance":"91204417.31"},{"account":"okx-hot.near","balance":"40112908.00"},{"account":"f5cfbc74.near","balance":"22018334.75"},{"account":"lockup.poolv1.near","balance":"18877120.40"},{"account":"kraken.near","balance":"9120044.18"}]}';
const WRONG =
  '{"token":"NEO","as_of":"2026-11-14T10:02:19Z","top":[{"account":"AQzRMe3zyGS8W177xLJfewRRQZY2kddMun","balance":"2471802"},{"account":"AJd31a8rYPEBkY1QSxpsGy8mdU4vTYTD4U","balance":"1964000"},{"account":"AWvMSy2GzqBbVFEqvx7EbX5uqFE1QY9nYT","balance":"1530199"}]}';

async function pay(buyer: string, seller: string): Promise<string> {
  const s = sellers[seller];
  const fee = Math.ceil(PRICE * 1e6 * s.feeBps / 10000) / 1e6;
  const callId = `${seller}/${hex(32)}`;
  buyers[buyer] -= PRICE;
  s.balance += PRICE - fee;
  s.exposed += PRICE + STAKE;
  s.calls += 1;
  chain("call_paid", { call_id: callId, buyer: `${buyer}.test.near`, seller: `${seller}.sellers.certo.test.near`, price: raw(PRICE), fee: raw(fee), fee_bps: s.feeBps, expires_at_ms: Date.now() + 120_000 });
  state();
  return callId;
}

async function panelDispute(scene: number, buyer: string, seller: string, callId: string, winner: "buyer" | "seller") {
  const opened = Date.now();
  buyers[buyer] -= STAKE;
  chain("dispute_opened", { call_id: callId, kind: "content", stake: raw(STAKE), answer_by_ms: Date.now() + 5000 });
  state();
  send({ kind: "dispute", scene, callId, buyer, seller, buyerOfferPct: 100, stake: amt(STAKE), ...disputeKind("content") });
  await sleep(2200);
  send({ kind: "log", actor: seller, text: "answer: refund offer 0%" });
  chain("dispute_answered", { call_id: callId, seller_offer_bps: 0 });
  send({ kind: "dispute", scene, callId, buyer, seller, buyerOfferPct: 100, sellerOfferPct: 0, stake: amt(STAKE), ...disputeKind("content") });
  await sleep(1500);
  const models = ["Qwen3.8", "GLM-5.3", "DeepSeek-V4.1"];
  for (let i = 0; i < 3; i++) {
    await sleep(1300);
    send({ kind: "vote", scene, callId, juror: i, model: models[i], vote: winner, sigVerified: true, latencyMs: 2100 + i * 640 });
  }
  await sleep(900);
  const votes = winner === "buyer" ? "3-0" : "0-3";
  chain("ballots_verified", { call_id: callId, epoch: 1, votes: [winner, winner, winner] });
  const s = sellers[seller];
  s.exposed -= PRICE + STAKE;
  let refund = 0;
  if (winner === "buyer") {
    refund = PRICE;
    buyers[buyer] += PRICE + STAKE;
    s.bond -= PRICE + STAKE;
    s.losses += 1;
  }
  chain("dispute_resolved", { call_id: callId, tier: "panel", winner, votes, refund: raw(refund), ruling_fee: raw(STAKE) });
  if (winner === "buyer") stepFee(seller);
  state();
  send({ kind: "resolved", scene, callId, tier: "panel", winner, refund: amt(refund), votes, elapsedMs: Date.now() - opened });
}

function disputeKind(k: string) {
  // EVENTS.md names the dispute type field `kind`, which collides with the
  // message discriminator `kind: "dispute"`. The mock sends `disputeKind`.
  return { disputeKind: k };
}

function stepFee(seller: string) {
  const s = sellers[seller];
  const i = FEE_STEPS.indexOf(s.feeBps);
  const next = FEE_STEPS[Math.min(i + 1, FEE_STEPS.length - 1)];
  chain("fee_tier_changed", { seller: `${seller}.sellers.certo.test.near`, from_bps: s.feeBps, to_bps: next });
  s.feeBps = next;
}

async function script(): Promise<void> {
  send({ kind: "mode", panel: MODE, network: "sandbox", ...(MODE === "replay" ? { recordedAt: Date.parse("2026-11-12T15:40:00Z") } : {}) });
  send({
    kind: "actors",
    buyers: [{ id: "agent", label: "agent", role: "buying agent" }, { id: "liar-agent", label: "liar-agent", role: "lies to get a refund" }],
    sellers: [{ id: "honest-api", label: "honest-api", role: "honest seller" }, { id: "shady-api", label: "shady-api", role: "sends wrong data" }],
    jurors: [
      { index: 0, model: "Qwen/Qwen3.8-27B", name: "Qwen", family: "Alibaba Qwen" },
      { index: 1, model: "z-ai/glm-5.3-flash", name: "GLM", family: "Zhipu GLM" },
      { index: 2, model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", name: "DeepSeek", family: "DeepSeek" },
    ],
  });
  chain("jurors_set", { epoch: 1, model_ids: ["Qwen3.8", "GLM-5.3", "DeepSeek-V4.1"] });
  state();
  await sleep(2500);

  // Scene 1: honest seller, instant pay.
  send({ kind: "scene", n: 1, title: "Honest seller: paid in the same transaction", status: "start" });
  send({ kind: "log", actor: "agent", text: `${REQUEST} → 402, price 0.40` });
  await sleep(1500);
  const c1 = await pay("agent", "honest-api");
  send({ kind: "call", scene: 1, buyer: "agent", seller: "honest-api", request: REQUEST, price: amt(PRICE), callId: c1, status: 200, responsePreview: GOOD, windowMs: 120_000 });
  send({ kind: "log", actor: "agent", text: "receipt verified; token NEAR as requested" });
  await sleep(3500);
  send({ kind: "scene", n: 1, title: "Honest seller: paid in the same transaction", status: "ok", line: "Scene 1 OK: seller balance +0.396000 in the paying transaction", caption: "honest-api got +0.396 in agent's own transaction: nothing held in escrow" });
  if (STOP_AFTER <= 1) return;
  await sleep(2000);

  // Scene 2: wrong token, panel 3-0.
  send({ kind: "scene", n: 2, title: "Wrong token: the panel decides", status: "start" });
  send({ kind: "log", actor: "agent", text: `${REQUEST} → shady-api, price 0.40` });
  await sleep(1500);
  const c2 = await pay("agent", "shady-api");
  send({ kind: "call", scene: 2, buyer: "agent", seller: "shady-api", request: REQUEST, price: amt(PRICE), callId: c2, status: 200, responsePreview: WRONG, highlight: '"token":"NEO"' });
  await sleep(1800);
  send({ kind: "log", actor: "agent", text: "asked NEAR, got NEO → claim a refund" });
  await sleep(1200);
  await panelDispute(2, "agent", "shady-api", c2, "buyer");
  send({ kind: "log", actor: "agent", text: "refund 0.40 received, stake 0.02 returned" });
  await sleep(4000);
  send({ kind: "scene", n: 2, title: "Wrong token: the panel decides", status: "ok", line: "Scene 2 OK: votes buyer/buyer/buyer, 3 signatures verified by contract, refund 0.400000, bond 50.000000 → 49.580000, fee 1.0% → 1.5%", caption: "3–0 for the buyer, 3 signatures checked by the contract: 0.40 back from shady-api' bond" });
  if (STOP_AFTER <= 2) return;
  await sleep(2000);

  // Scene 3: lying buyer loses 0-3.
  send({ kind: "scene", n: 3, title: "Lying buyer: loses and pays the ruling fee", status: "start" });
  send({ kind: "log", actor: "liar-agent", text: `${REQUEST} → honest-api, price 0.40` });
  await sleep(1500);
  const c3 = await pay("liar-agent", "honest-api");
  send({ kind: "call", scene: 3, buyer: "liar-agent", seller: "honest-api", request: REQUEST, price: amt(PRICE), callId: c3, status: 200, responsePreview: GOOD });
  await sleep(1500);
  send({ kind: "log", actor: "liar-agent", text: "data is correct; disputes anyway at 100%" });
  await sleep(1000);
  await panelDispute(3, "liar-agent", "honest-api", c3, "seller");
  send({ kind: "log", actor: "liar-agent", text: "lost 0-3; stake 0.02 forfeited" });
  await sleep(4000);
  send({ kind: "scene", n: 3, title: "Lying buyer: loses and pays the ruling fee", status: "ok", line: "Scene 3 OK: votes seller/seller/seller, buyer stake 0.020000 forfeited", caption: "0–3 for the seller: liar-agent loses its 0.02 stake; honest-api keeps bond and fee" });
  if (STOP_AFTER <= 3) return;
  await sleep(2000);

  // Scene 4: seller down, refund by rule.
  send({ kind: "scene", n: 4, title: "Seller down: refund by rule, no panel", status: "start" });
  send({ kind: "log", actor: "shady-api", text: "process killed" });
  send({ kind: "log", actor: "agent", text: `${REQUEST} → shady-api, price 0.40` });
  await sleep(1500);
  const c4 = await pay("agent", "shady-api");
  send({ kind: "call", scene: 4, buyer: "agent", seller: "shady-api", request: REQUEST, price: amt(PRICE), callId: c4, status: null, responsePreview: "" });
  await sleep(2500);
  send({ kind: "log", actor: "agent", text: "no response → claim non-delivery" });
  const opened = Date.now();
  buyers.agent -= STAKE;
  chain("dispute_opened", { call_id: c4, kind: "non_delivery", stake: raw(STAKE), answer_by_ms: opened + 5000 });
  state();
  send({ kind: "dispute", scene: 4, callId: c4, buyer: "agent", seller: "shady-api", stake: amt(STAKE), answerByMs: opened + 5000, answerMs: 5000, ...disputeKind("non_delivery") });
  await new Promise((r) => setTimeout(r, Math.max(0, opened + 5300 - Date.now())));
  const s = sellers['shady-api'];
  buyers.agent += PRICE + STAKE;
  s.bond -= PRICE + STAKE;
  s.exposed -= PRICE + STAKE;
  s.losses += 1;
  chain("dispute_resolved", { call_id: c4, tier: "rule", reason: "seller_no_answer", refund: raw(PRICE), ruling_fee: raw(STAKE) });
  stepFee("shady-api");
  state();
  send({ kind: "resolved", scene: 4, callId: c4, tier: "rule", winner: "buyer", refund: amt(PRICE), elapsedMs: Date.now() - opened });
  send({ kind: "log", actor: "agent", text: "refund 0.40 by rule, stake 0.02 returned" });
  await sleep(3000);
  send({ kind: "scene", n: 4, title: "Seller down: refund by rule, no panel", status: "ok", line: "Scene 4 OK: seller did not answer in 5 s (demo setting; 30 s on testnet), refund 0.400000 by rule, no panel", caption: "shady-api silent 5 s: 0.40 refunded by rule, no panel; fee 1.5% → 2.5%" });
  if (STOP_AFTER <= 4) return;
  await sleep(2000);

  // Scene 5: one byte of a juror's signed answer changed; the contract rejects it.
  const t5 = "We attack our own contract: one byte of a juror's signed answer changed";
  send({ kind: "scene", n: 5, title: t5, status: "start" });
  await sleep(1500);
  const c5 = await pay("liar-agent", "honest-api");
  send({ kind: "call", scene: 5, buyer: "liar-agent", seller: "honest-api", request: REQUEST, price: amt(PRICE), callId: c5, status: 200, responsePreview: GOOD });
  await sleep(1500);
  send({ kind: "dispute", scene: 5, callId: c5, buyer: "liar-agent", seller: "honest-api", buyerOfferPct: 100, sellerOfferPct: 0, stake: amt(STAKE), ...disputeKind("content") });
  await sleep(2000);
  const forged = { kind: "attack", scene: 5, callId: c5, juror: 0, from: "Y", to: "X", votes: ["buyer", "seller", "seller"] };
  chain("tx_failed", { method: "resolve", signer: "resolver", error: "E_BALLOT_SIG" });
  send({ ...forged, build: "real", rejected: true, error: "E_BALLOT_SIG", txHash: txHash() });
  await sleep(2500);
  send({ ...forged, build: "no-check", rejected: false, winner: "seller", txHash: txHash() });
  await sleep(3000);
  send({ kind: "scene", n: 5, title: t5, status: "ok", line: "Scene 5 forged vote: certo rejected it with E_BALLOT_SIG; res/guards/certo_no_g1.wasm counted it", caption: "Forged vote rejected with E_BALLOT_SIG; a build without the check counted it" });
  send({ kind: "done", ok: true, summary: "DEMO OK: 5/5 scenes, 3/3 juror signatures verified on chain" });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

let started = false;
function start() {
  if (started) return;
  started = true;
  script().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const line of history) res.write(line);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    if (START === "connect") setTimeout(start, 500);
    return;
  }
  const rel = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR) || rel.endsWith(".ts")) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => {
  console.log(`mock feed: http://localhost:${PORT} (mode ${MODE}, start on ${START})`);
  if (START === "now") start();
});
