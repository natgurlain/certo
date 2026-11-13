import { countdownMs, dwellMs } from "./pace.js";
import { TESTNET, findCase, fingerprint, verifyOnChain } from "./verify.js";

// ---------------------------------------------------------------------------
// Product naming. The ONLY place the name, tagline and badge text live
// (docs/DESIGN.md 1.2). Rename here.
// ---------------------------------------------------------------------------
const BRAND = {
  name: "Certo",
  tagline: "Agents pay instantly. Bad calls get refunded.",
  badge: (bond, windowS) => `${BRAND.name} ✓ · bonded ${bond} USDC · refunds for ${windowS} s`,
  intro: "Your agent paid 0.40 for data. The data was wrong. Now what?",
  builtAt: "Built at NEAR HACKATHON",
  repoUrl: "https://github.com/natgurlain/certo", // the ONE place for the repository link (empty: no link shown)
};

// Refund window shown before the first call carries `windowMs`; demo value from DESIGN 4.2.
const DEFAULT_WINDOW_MS = 120000;
const FEED_URL = "/events";
// Played when /events is not there (the page served as static files with a recorded feed next to it).
const FEED_FILE = "feed.json";
const SCENE_SHORT = { 1: "Honest seller", 2: "Wrong token", 3: "Lying buyer", 4: "Seller down", 5: "Forged vote" };
const AMOUNT_KEYS = new Set(["price", "fee", "stake", "refund", "ruling_fee", "amount", "bond"]);
const DISPUTE_TYPES = new Set(["content", "non_delivery", "error", "rule"]);
// Median time of a live panel ruling in the kill test (README, Measured). A replayed ruling takes seconds, so the page names both.
const LIVE_PANEL_MEDIAN_S = 23;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const params = new URLSearchParams(location.search);

/** "49.580000" -> "49.58", "0.396000" -> "0.396": trailing zeros trimmed, at least two decimals. */
function amt(s) {
  if (s === undefined || s === null || s === "") return "—";
  const str = String(s);
  if (!/^-?\d+(\.\d+)?$/.test(str)) return str;
  const [i, f = ""] = str.split(".");
  let frac = f.replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${i}.${frac}`;
}
const dec = (x) => amt(Number(x).toFixed(6));
const pct = (bps) => `${(Number(bps) / 100).toFixed(1)}%`;
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const lockSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

function flash(el) {
  if (!live || !el) return;
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

// ---------------------------------------------------------------------------
// state (rebuilt from scratch on every replay)
// ---------------------------------------------------------------------------
let S;
// ?speed=2 plays twice as fast; ?speed=0 shows everything at once (no pacing, no animation)
const speed = params.has("speed") ? Math.max(0, Number(params.get("speed")) || 0) : 1;
const live = speed > 0; // animations on
function reset() {
  S = {
    mode: null,
    actors: { buyers: [], sellers: [], jurors: [] },
    buyers: {}, sellers: {},
    sellerWas: {}, // id -> {bond, feeBps} value before the last change
    initialBond: {},
    buyerNote: {}, // id -> {text, cls}
    logs: {},
    scenes: {}, current: 0,
    call: null, paid: {}, // call_id -> call_paid data
    answerBy: {}, // call_id -> ms
    disputes: {}, // callId -> merged dispute
    votes: {}, // callId -> [vote]
    attacks: {}, // callId -> {real, "no-check"} (scene 5)
    checked: {}, // callId -> [true | false] per juror: signature checked in this browser
    resolved: {},
    caseId: null,
    cd: null, // {callId, start, len}: the countdown of a rule claim, in page time
    chain: null, done: null,
    down: {}, // seller id -> true while not responding
  };
}

// ---------------------------------------------------------------------------
// feed and player: every message is queued and played with a minimum dwell (pace.js)
// ---------------------------------------------------------------------------
let received = []; // every message so far, for Replay
let queue = [];
let gen = 0, running = -1;
const clock = { sceneStart: 0, lastVote: null };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// ?upto=2 stops playing after scene 2 ends (stills for screenshots)
let upto = params.has("upto") ? Number(params.get("upto")) : Infinity;
let halted = false;
const vnow = () => performance.now() * (speed || 1);

function receive(m) {
  received.push(m);
  queue.push(m);
  renderPhone();
  pump();
}

async function pump() {
  if (running === gen || halted) return;
  const g = (running = gen);
  while (queue.length && g === gen && !halted) {
    const m = queue.shift();
    handle(m);
    renderAll();
    if (m.kind === "scene" && m.status !== "start" && m.n >= upto) { halted = true; break; }
    if (m.kind === "scene" && m.status === "start") { clock.sceneStart = vnow(); clock.lastVote = null; }
    if (m.kind === "vote") clock.lastVote = vnow();
    if (!speed) continue;
    const w = dwellMs(m, { now: vnow(), sceneStart: clock.sceneStart, lastVote: clock.lastVote, intro: !$("intro").classList.contains("hidden"), buyers: new Set(S.actors.buyers.map((b) => b.id)) });
    if (w > 0) await sleep(w / speed);
  }
  if (g === gen) { running = -1; renderReplay(); }
}

function replay() {
  gen++;
  halted = false;
  upto = Infinity;
  reset();
  queue = received.slice();
  if (params.get("intro") !== "0") { const el = $("intro"); el.style.transition = "none"; el.classList.remove("hidden"); void el.offsetWidth; el.style.transition = ""; }
  buildActors();
  renderAll();
  pump();
}

function connect() {
  if (params.has("feed")) { loadFile(params.get("feed")); return; }
  const es = new EventSource(FEED_URL);
  let idx = 0, got = false;
  es.onopen = () => { idx = 0; };
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    got = true;
    const i = idx++;
    if (i < received.length) {
      if (received[i].t === msg.t && received[i].kind === msg.kind) return; // history the runner replays on reconnect
      received = []; // a new run: start over
      replay();
    }
    receive(msg);
  };
  es.onerror = () => {
    if (!got) { es.close(); loadFile(FEED_FILE); return; }
    if (!received.some((m) => m.kind === "done")) setCaption("Feed disconnected; reconnecting…", "fail");
  };
}

async function loadFile(url) {
  try {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const msgs = await r.json();
    if (!Array.isArray(msgs)) throw new Error("not a JSON array");
    for (const m of msgs) receive(m);
  } catch (e) {
    setCaption(`No feed: run \`make demo\`, or put a recorded ${FEED_FILE} next to index.html (${e.message})`, "fail");
  }
}

function disputeType(m) {
  return m.disputeKind ?? m.type ?? (DISPUTE_TYPES.has(m.kind) ? m.kind : undefined);
}

function handle(m) {
  const t = m.t ?? Date.now();
  // EVENTS.md names the dispute type `kind`, which collides with the message
  // discriminator; accept either spelling.
  const kind = DISPUTE_TYPES.has(m.kind) && m.callId ? "dispute" : m.kind;
  switch (kind) {
    case "mode":
      S.mode = m;
      break;
    case "actors":
      S.actors = { buyers: m.buyers ?? [], sellers: m.sellers ?? [], jurors: m.jurors ?? [] };
      buildActors();
      break;
    case "state":
      onState(m);
      break;
    case "scene":
      S.scenes[m.n] = { ...(S.scenes[m.n] ?? {}), title: m.title, status: m.status, line: m.line, caption: m.caption };
      if (m.status === "start") {
        S.current = m.n;
        S.call = null;
        S.caseId = null;
        hideIntro();
      }
      break;
    case "call":
      S.call = m;
      if (m.status === null || m.status === undefined || m.status === 0) S.down[m.seller] = true;
      else delete S.down[m.seller];
      break;
    case "dispute": {
      const prev = S.disputes[m.callId] ?? { openedAt: t };
      S.disputes[m.callId] = { ...prev, ...m, type: disputeType(m) ?? prev.type, openedAt: prev.openedAt };
      if (m.answerByMs) S.answerBy[m.callId] = m.answerByMs;
      const cd = countdownMs(m);
      if (cd !== null && S.cd?.callId !== m.callId) S.cd = { callId: m.callId, start: performance.now(), len: cd };
      if (!S.votes[m.callId]) S.votes[m.callId] = [];
      if (S.caseId !== m.callId) S.buyerNote[m.buyer] = null;
      S.caseId = m.callId;
      break;
    }
    case "vote":
      (S.votes[m.callId] ??= [])[m.juror] = m;
      checkInBrowser(m);
      break;
    case "attack":
      (S.attacks[m.callId] ??= {})[m.build] = m;
      S.caseId = m.callId;
      break;
    case "resolved":
      S.resolved[m.callId] = m;
      onResolved(m);
      break;
    case "chain":
      S.chain = m;
      if (m.event === "call_paid" && m.data?.call_id) S.paid[m.data.call_id] = m.data;
      if (m.event === "dispute_opened" && m.data?.answer_by_ms && !S.answerBy[m.data.call_id]) S.answerBy[m.data.call_id] = Number(m.data.answer_by_ms);
      break;
    case "log":
      if (m.text === "process restarted") delete S.down[m.actor]; // the playground restarts the seller scene 4 stopped
      (S.logs[m.actor] ??= []).push(m.text);
      if (S.logs[m.actor].length > 6) S.logs[m.actor].shift();
      break;
    case "done":
      S.done = m;
      break;
  }
}

function onState(m) {
  for (const [id, b] of Object.entries(m.buyers ?? {})) {
    const prev = S.buyers[id];
    S.buyers[id] = b;
    if (prev && prev.balance !== b.balance) flash(q(`[data-buyer="${id}"] .bal`));
  }
  for (const [id, s] of Object.entries(m.sellers ?? {})) {
    const prev = S.sellers[id];
    if (S.initialBond[id] === undefined) S.initialBond[id] = Number(s.bond);
    if (prev) {
      const was = (S.sellerWas[id] ??= {});
      if (prev.bond !== s.bond) { was.bond = prev.bond; flash(q(`[data-seller="${id}"] .bond-cell`)); }
      if (prev.feeBps !== s.feeBps) { was.feeBps = prev.feeBps; flash(q(`[data-seller="${id}"] .fee`)); }
      if (prev.balance !== s.balance) flash(q(`[data-seller="${id}"] .bal-cell`));
    }
    S.sellers[id] = s;
  }
}

function onResolved(m) {
  const d = S.disputes[m.callId] ?? {};
  const buyer = d.buyer ?? S.call?.buyer;
  const stake = d.stake;
  if (m.winner === "buyer") {
    const back = stake ? ` · stake ${amt(stake)} back` : "";
    S.buyerNote[buyer] = { text: `refund +${amt(m.refund)} from the bond${back}`, cls: "good" };
    if (live && Number(m.refund) > 0) fly(`+${amt(m.refund)} refund`, q(`[data-seller="${d.seller}"] .bond-cell`), q(`[data-buyer="${buyer}"] .bal`));
  } else {
    const r = Number(m.refund) > 0 ? `refund ${amt(m.refund)} · ` : "no refund · ";
    S.buyerNote[buyer] = { text: `${r}stake −${amt(stake ?? "0")} forfeited`, cls: "bad" };
  }
}

// ---------------------------------------------------------------------------
// the page's own check of a juror ballot: ed25519 over "<model>:<sha256 prompt>:<sha256 answer>"
// (NEAR AI provider_tee), against the key the contract was given (from fixtures/)
// ---------------------------------------------------------------------------
const hexBytes = (h) => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16));
const b64Bytes = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
async function checkInBrowser(v) {
  const pubkey = S.actors.jurors.find((j) => Number(j.index) === v.juror)?.pubkey;
  if (!pubkey || !v.signature || v.responseBody === undefined || v.signatureKind !== "provider_tee" || !crypto.subtle) return;
  const g = gen;
  let ok = false;
  try {
    const enc = new TextEncoder();
    const answer = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(v.responseBody)));
    const text = `${v.model}:${v.requestSha256}:${[...answer].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
    const key = await crypto.subtle.importKey("raw", hexBytes(pubkey), { name: "Ed25519" }, false, ["verify"]);
    ok = await crypto.subtle.verify({ name: "Ed25519" }, key, b64Bytes(v.signature), enc.encode(text));
  } catch { ok = false; } // e.g. a browser without Ed25519 in WebCrypto
  if (g !== gen) return;
  (S.checked[v.callId] ??= [])[v.juror] = ok;
  renderCase();
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------
const q = (sel) => document.querySelector(sel);

function buildActors() {
  $("buyers").innerHTML = S.actors.buyers.map((b) => `
    <div class="card buyer" data-buyer="${esc(b.id)}">
      <div class="buyer-top">
        <div class="card-head"><span class="name">${esc(b.label ?? b.id)}</span><span class="role">buyer agent</span></div>
        <div class="bal"><span class="big v">—</span><span class="unit">USDC</span></div>
      </div>
      <div class="note"></div>
      <ul class="log"></ul>
    </div>`).join("");
  $("sellers").innerHTML = S.actors.sellers.map((s) => `
    <div class="card seller" data-seller="${esc(s.id)}">
      <div class="card-head"><span class="name">${esc(s.label ?? s.id)}</span><span class="role">seller API</span><span class="down"></span><span class="spacer"></span>
        <span class="fee-was"></span><span class="fee">fee —</span></div>
      <div class="seller-nums">
        <div class="bal-cell"><label>Balance</label><div class="big v-bal">—</div><div class="was"></div></div>
        <div class="bond-cell"><label>Bond</label><div class="big v-bond">—</div><div class="was v-bondwas"></div></div>
      </div>
      <div class="bondbar"><div class="fill"></div><div class="exposed"></div><div class="lost"></div></div>
      <div class="bond-legend"><span><i class="swatch exp"></i>exposed <b class="v-exp">—</b></span><span><i class="swatch lost"></i>paid out <b class="v-lost">—</b></span><span class="record"></span></div>
      <div class="mgbadge"></div>
    </div>`).join("");
  $("jurors").innerHTML = S.actors.jurors.map((j) => `
    <div class="juror" data-juror="${esc(j.index)}">
      <div class="idx">${Number(j.index) + 1}</div>
      <div><div class="model" title="${esc(j.model)}">${esc(j.name ?? j.model)}</div><div class="family">${esc(j.family)} family · own enclave</div><div class="sig"></div></div>
      <div class="vote"></div>
    </div>`).join("");
}

function renderAll() {
  renderHeader();
  renderBuyers();
  renderCall();
  renderSellers();
  renderCase();
  renderFooter();
}

function renderHeader() {
  const m = S.mode;
  const box = $("mode");
  box.className = "mode";
  if (m) {
    let label;
    if (m.panel === "live") { label = "Live NEAR AI panel, asked now"; box.classList.add("live"); }
    else if (m.panel === "replay") {
      const when = m.recordedAt ? new Date(isNaN(Number(m.recordedAt)) ? m.recordedAt : Number(m.recordedAt)).toISOString().slice(0, 10) : "earlier";
      label = `Real NEAR AI ballots, recorded ${when}`;
      box.classList.add("replay");
    } else if (m.panel === "replay-synthetic") { label = "Panel answers signed with a local TEST key (synthetic)"; box.classList.add("synthetic"); }
    else label = `Panel: ${m.panel}`;
    $("mode-panel").textContent = label;
    $("mode-net").textContent = m.network === "testnet" ? "Chain: NEAR testnet" : m.network === "sandbox" ? "Chain: local NEAR sandbox" : `Chain: ${m.network ?? "?"}`;
  }
  $("verify").classList.toggle("hidden", !onTestnet());
  // every scene the feed holds so far (a recorded feed: all of them), so the row does not change mid-run
  const ns = received.filter((m) => m.kind === "scene").map((m) => Number(m.n));
  const max = Math.max(4, ...ns);
  let html = "";
  for (let n = 1; n <= max; n++) {
    const sc = S.scenes[n];
    const cls = sc ? (sc.status === "ok" ? "ok" : sc.status === "fail" ? "fail" : "") : "";
    const active = n === S.current && sc?.status === "start" ? " active" : "";
    html += `<li class="${cls}${active}"><span class="n">${sc?.status === "ok" ? "✓" : sc?.status === "fail" ? "✕" : n}</span><span class="t">${esc(SCENE_SHORT[n] ?? sc?.title ?? `Scene ${n}`)}</span></li>`;
  }
  $("scenes").innerHTML = html;

  const cur = S.scenes[S.current];
  if (S.done && !S.done.ok) setCaption(S.done.summary, "fail");
  else if (cur) {
    // at the end of a scene: its short result (`caption`); the full transcript line is the tooltip
    if (cur.status === "start") setCaption(`Scene ${S.current} · ${cur.title}`, "");
    else if (cur.status === "ok") setCaption(`✓ Scene ${S.current} · ${cur.caption ?? cur.line ?? cur.title}`, "ok", cur.line);
    else setCaption(cur.line ?? `Scene ${S.current} failed`, "fail");
  } else if (S.mode) setCaption("Ready: waiting for scene 1", "");
}

/** Caption text, shrunk to fit the stage width (then cut with an ellipsis). */
function setCaption(text, cls, title) {
  const c = $("caption");
  c.className = `caption ${cls}`;
  const span = $("caption-text");
  span.title = title ?? "";
  if (span.textContent !== text) span.textContent = text;
  span.style.fontSize = "";
  for (let px = 25; px > 17 && span.scrollWidth > span.clientWidth; px -= 2) span.style.fontSize = `${px - 2}px`;
}

function activePair() {
  const d = S.caseId ? S.disputes[S.caseId] : null;
  return { buyer: S.call?.buyer ?? d?.buyer, seller: S.call?.seller ?? d?.seller };
}

function renderBuyers() {
  const { buyer } = activePair();
  for (const b of S.actors.buyers) {
    const el = q(`[data-buyer="${b.id}"]`);
    if (!el) continue;
    el.classList.toggle("active", buyer === b.id);
    el.classList.toggle("dim", !!buyer && buyer !== b.id);
    el.querySelector(".v").textContent = amt(S.buyers[b.id]?.balance);
    const note = S.buyerNote[b.id];
    const n = el.querySelector(".note");
    n.className = `note ${note?.cls ?? ""}`;
    n.textContent = note?.text ?? "";
    const logs = (S.logs[b.id] ?? []).slice(-2);
    el.querySelector(".log").innerHTML = logs.map((l) => `<li class="${/claim/i.test(l) ? "claim" : ""}" title="${esc(l)}">${esc(l)}</li>`).join("");
  }
}

function renderCall() {
  const c = S.call;
  const box = $("call");
  if (!c) {
    box.innerHTML = `<div class="call-head"><b>Paid call</b></div><div class="empty">${S.current ? "Waiting for the paid call…" : "No call yet."}</div>`;
    return;
  }
  const paid = S.paid[c.callId];
  const sellerState = S.sellers[c.seller];
  const fee = paid?.fee !== undefined ? Number(paid.fee) / 1e6 : c.fee !== undefined ? Number(c.fee) : Number(c.price) * (sellerState?.feeBps ?? 0) / 10000;
  const feeBps = paid?.fee_bps ?? c.feeBps ?? sellerState?.feeBps;
  const net = Number(c.price) - fee;
  const ok = typeof c.status === "number" && c.status >= 200 && c.status < 300;
  const statusTxt = c.status ? `HTTP ${c.status}` : "no response";

  // Highlight the requested value of the mismatching field, e.g. token=NEAR.
  let reqHtml = esc(c.request);
  const hk = c.highlight && /"([^"]+)"\s*:/.exec(c.highlight)?.[1];
  if (hk) reqHtml = reqHtml.replace(new RegExp(`(${hk}=[^&\\s]+)`), "<mark>$1</mark>");

  let respHtml;
  if (!c.responsePreview) respHtml = `<pre class="resp none">${c.status ? "empty response" : "nothing delivered"}</pre>`;
  else if (c.highlight && c.responsePreview.includes(c.highlight)) {
    respHtml = `<pre class="resp">${c.responsePreview.split(c.highlight).map(esc).join(`<mark>${esc(c.highlight)}</mark>`)}</pre>`;
  } else respHtml = `<pre class="resp">${esc(c.responsePreview)}</pre>`;

  // the wedge: no escrow wait for the seller; a wrong answer no rule can catch
  const windowS = Math.round((c.windowMs || DEFAULT_WINDOW_MS) / 1000);
  const noRule = c.highlight && ok ? `<div class="wedge">HTTP ${c.status}, valid JSON, every field present: no rule can catch this</div>` : "";
  box.innerHTML = `
    <div class="call-head"><b>${esc(c.buyer)}</b> → <b>${esc(c.seller)}</b><span class="spacer"></span>${c.highlight ? '<span class="mismatch">mismatch</span>' : ""}<span class="http ${ok ? "ok" : "bad"}">${statusTxt}</span></div>
    <code class="req">${reqHtml}</code>
    <div class="pay"><span class="neg">−${amt(c.price)}</span> ${esc(c.buyer)} → <span class="pos">+${dec(net)}</span> ${esc(c.seller)} · fee ${dec(fee)}${feeBps !== undefined ? ` (${pct(feeBps)})` : ""}<br><span class="same">paid in the same transaction</span>${c.scene === 1 ? `<div class="wedge">escrow would hold this for ${windowS} s</div>` : ""}</div>
    ${respHtml}${noRule}`;
}

function renderSellers() {
  const { seller } = activePair();
  const windowS = Math.round((S.call?.windowMs || DEFAULT_WINDOW_MS) / 1000);
  for (const a of S.actors.sellers) {
    const el = q(`[data-seller="${a.id}"]`);
    const s = S.sellers[a.id];
    if (!el || !s) continue;
    el.classList.toggle("active", seller === a.id);
    el.classList.toggle("dim", !!seller && seller !== a.id);
    const was = S.sellerWas[a.id] ?? {};
    el.querySelector(".v-bal").textContent = amt(s.balance);
    el.querySelector(".v-bond").textContent = amt(s.bond);
    el.querySelector(".v-bondwas").innerHTML = was.bond !== undefined ? `<s>${amt(was.bond)}</s> → ${amt(s.bond)}` : "";
    const fee = el.querySelector(".fee");
    fee.textContent = `fee ${pct(s.feeBps)}`;
    fee.classList.toggle("up", was.feeBps !== undefined && s.feeBps > was.feeBps);
    el.querySelector(".fee-was").innerHTML = was.feeBps !== undefined ? `<s>${pct(was.feeBps)}</s> →` : "";

    const init = S.initialBond[a.id] || Number(s.bond) || 1;
    const bond = Number(s.bond), exp = Number(s.exposed);
    const W = 100;
    const fillPct = Math.max(0, Math.min(W, (bond / init) * W));
    el.querySelector(".fill").style.width = `${fillPct}%`;
    const ex = el.querySelector(".exposed");
    const expPct = exp > 0 ? Math.max(1.6, (exp / init) * W) : 0;
    ex.style.width = `${expPct}%`;
    ex.style.left = `${Math.max(0, fillPct - expPct)}%`;
    const lostAmt = Math.max(0, init - bond);
    el.querySelector(".lost").style.width = lostAmt > 0 ? `${Math.max(1.6, (lostAmt / init) * W)}%` : "0";
    el.querySelector(".v-exp").textContent = amt(s.exposed);
    el.querySelector(".v-lost").textContent = dec(lostAmt);
    const r = s.record ?? {};
    el.querySelector(".record").textContent = `record: ${r.calls ?? 0} ${r.calls === 1 ? "call" : "calls"}, ${r.losses ?? 0} lost`;
    el.querySelector(".mgbadge").textContent = BRAND.badge(amt(s.bond), windowS);
    el.querySelector(".down").textContent = S.down[a.id] ? "not responding" : "";
    el.querySelector(".role").style.display = S.down[a.id] ? "none" : "";
  }
}

function renderCase() {
  const id = S.caseId;
  const d = id ? S.disputes[id] : null;
  const caseBox = $("case"), jur = $("jurors"), res = $("result");
  const votes = (id && S.votes[id]) || [];
  const r = id ? S.resolved[id] : null;
  const isRule = d && d.type && d.type !== "content";
  const atk = (id && S.attacks[id]) || null;

  // Case card
  if (!d) {
    const cur = S.scenes[S.current];
    caseBox.innerHTML = `<div class="case-head"><span class="case-kind">No dispute</span></div><div class="idle">${
      S.call ? `The seller was paid at once. Its bond covers a refund for ${Math.round((S.call.windowMs || DEFAULT_WINDOW_MS) / 1000)} s.` : cur ? "Waiting for the call…" : "The panel is idle until a buyer claims a refund."}</div>`;
  } else if (!isRule) {
    const sellerKnown = d.sellerOfferPct !== undefined && d.sellerOfferPct !== null;
    const revealed = sellerKnown || !!r;
    const buyerOffer = revealed && d.buyerOfferPct !== undefined
      ? `<div class="big">${d.buyerOfferPct}%</div><div class="offer-sub">revealed</div>`
      : `<div class="sealed">${lockSvg}sealed</div><div class="offer-sub">committed on chain, hidden</div>`;
    const sellerOffer = sellerKnown
      ? `<div class="big">${d.sellerOfferPct}%</div><div class="offer-sub">seller's answer</div>`
      : `<div class="sealed">waiting…</div><div class="offer-sub">seller must answer</div>`;
    caseBox.innerHTML = `
      <div class="case-head"><span class="case-kind">${atk ? "Forged ballot" : "Content dispute"}</span><span class="parties"><b>${esc(d.buyer)}</b> vs <b>${esc(d.seller)}</b></span><span class="stake">stake ${amt(d.stake)}</span></div>
      <div class="offers">
        <div class="offer buyer"><label>Buyer's refund offer</label>${buyerOffer}</div>
        <div class="offer seller"><label>Seller's refund offer</label>${sellerOffer}</div>
      </div>`;
  } else {
    const label = d.type === "non_delivery" ? "Non-delivery claim" : d.type === "error" ? "Seller error (HTTP ≥ 500)" : "Rule claim";
    caseBox.innerHTML = `
      <div class="case-head"><span class="case-kind">${label}</span><span class="parties"><b>${esc(d.buyer)}</b> vs <b>${esc(d.seller)}</b></span><span class="stake">stake ${amt(d.stake)}</span></div>
      <div class="countdown"><span class="big num" id="cd">—</span><span class="offer-sub" id="cd-sub">seller must answer or deliver</span></div>`;
    tickCountdown();
  }

  // Jurors
  const panelPhase = d && !isRule;
  jur.classList.toggle("off", !!isRule);
  for (const j of S.actors.jurors) {
    const el = q(`[data-juror="${j.index}"]`);
    if (!el) continue;
    const v = votes[j.index];
    el.className = "juror";
    const sig = el.querySelector(".sig"), vote = el.querySelector(".vote"), fam = el.querySelector(".family");
    fam.textContent = `${j.family} family · own enclave`;
    fam.title = "";
    const a = atk && (atk.real ?? atk["no-check"]);
    if (a) {
      // scene 5: the ballots as submitted, one of them edited after it was signed
      const side = a.votes?.[j.index] ?? "abstain";
      const forged = j.index === a.juror;
      el.classList.add(`v-${side}`);
      if (forged) el.classList.add("forged");
      vote.innerHTML = `${esc(side.toUpperCase())}<small>${forged ? `edited ${esc(a.from)} → ${esc(a.to)}` : "&nbsp;"}</small>`;
      sig.className = `sig ${forged && atk.real?.rejected ? "bad" : ""}`;
      sig.textContent = forged ? (atk.real?.rejected ? `✕ signature rejected by contract` : "1 byte edited after signing") : "untouched ballot";
    } else if (v) {
      el.classList.add(`v-${v.vote}`);
      if (v.sigVerified) el.classList.add("verified");
      vote.innerHTML = `${esc(v.vote.toUpperCase())}<small>${v.latencyMs ? secs(v.latencyMs) : "&nbsp;"}</small>`;
      sig.className = `sig ${v.sigVerified ? "ok" : ""}`;
      sig.textContent = v.sigVerified ? "✓ signature verified by contract" : "signature not yet verified";
      const here = S.checked[id]?.[j.index];
      if (v.requestSha256 && here !== undefined) {
        fam.innerHTML = `prompt <span class="mono">${esc(v.requestSha256.slice(0, 8))}</span> · <span class="${here ? "here-ok" : "here-bad"}">${here ? "✓ in this browser" : "✕ in this browser"}</span>`;
        fam.title = `sha256 of the prompt the contract rebuilt: ${v.requestSha256}; ed25519 signature checked in this browser (WebCrypto) against ${j.pubkey}`;
      }
    } else {
      if (panelPhase && d.sellerOfferPct !== undefined && !r) { el.classList.add("waiting"); vote.innerHTML = "deciding…<small>&nbsp;</small>"; }
      else vote.innerHTML = `<span class="idle">standing by</span><small>&nbsp;</small>`;
      sig.className = "sig";
      sig.textContent = "";
    }
  }
  let note = jur.querySelector(".off-note");
  if (isRule) {
    if (!note) { note = document.createElement("div"); note.className = "off-note"; jur.appendChild(note); }
    note.textContent = "No panel: decided by rule";
  } else if (note) note.remove();

  // Result
  if (atk) {
    const real = atk.real, weak = atk["no-check"];
    res.className = "result attack";
    res.innerHTML = `${real ? `<div class="atk-real">${real.rejected ? `✕ ${esc(real.error ?? "rejected")}` : "✕ NOT REJECTED"}</div><div class="what">${real.rejected ? "real contract: forged vote refused, nothing paid" : "real contract: forged vote accepted"}</div>` : ""}${
      weak ? `<div class="atk-weak">same attack, build without the check: ${weak.rejected ? `rejected (${esc(weak.error ?? "?")})` : `forged vote counted (${esc((weak.votes ?? []).join("/"))})`}</div>` : ""}`;
  } else if (!r) {
    res.className = "result";
    res.innerHTML = `<div class="empty">${d ? (isRule ? "Waiting for the seller…" : "Waiting for the verdict…") : "No verdict needed."}</div>`;
  } else if (r.tier === "panel") {
    const b = votes.filter((v) => v?.vote === "buyer").length, s = votes.filter((v) => v?.vote === "seller").length;
    const score = votes.length ? `${b}–${s}` : String(r.votes ?? "").replace("-", "–");
    res.className = `result ${r.winner}`;
    const what = r.winner === "buyer"
      ? `for the buyer · refund ${amt(r.refund)} out of the seller's bond`
      : `for the seller · ${Number(r.refund) > 0 ? `refund ${amt(r.refund)}` : "no refund"} · buyer's stake ${amt(d?.stake ?? "0")} forfeited`;
    const replayed = String(S.mode?.panel ?? "").startsWith("replay");
    const note = replayed ? `<div class="timing">recorded answers; asked live, the panel takes a median of ${LIVE_PANEL_MEDIAN_S} s</div>` : "";
    res.innerHTML = `<div class="score">${score}<span class="in">${replayed ? "replayed in" : "in"} ${secs(r.elapsedMs)}</span></div>${note}<div class="what">${what}</div>`;
  } else {
    res.className = "result";
    const answerMs = d?.answerMs ?? answerWindow(id);
    const head = d?.type === "non_delivery" ? `seller silent ${Math.round(answerMs / 1000)} s` : `seller error`;
    res.innerHTML = `<div class="rule">${head}</div><div class="rule-sub">→ refund by rule, no panel</div><div class="what">refund ${amt(r.refund)} to ${esc(d?.buyer ?? "buyer")} · ${secs(r.elapsedMs)}</div>`;
  }
}

/** Seller's answer time of a rule claim whose feed carries no `answerMs` (older feeds). */
function answerWindow(id) {
  return S.cd?.callId === id ? S.cd.len : S.resolved[id]?.elapsedMs ?? 0;
}

function tickCountdown() {
  const el = $("cd");
  if (!el || !S.caseId) return;
  const id = S.caseId, r = S.resolved[id];
  const cd = S.cd?.callId === id ? S.cd : null;
  const rem = r || !cd || !speed ? 0 : Math.max(0, cd.len - (performance.now() - cd.start) * speed);
  el.textContent = secs(rem);
  el.classList.toggle("done", !!r);
  const sub = $("cd-sub");
  if (sub) sub.textContent = r ? "seller never answered" : rem > 0 ? "seller must answer or deliver" : "time is up";
}
setInterval(tickCountdown, 100);

function renderFooter() {
  const c = S.chain;
  if (c) {
    $("chain-event").textContent = c.event === "tx_failed" ? `${c.data?.method ?? "tx"} rejected: ${c.data?.error ?? "?"}` : c.event;
    $("chain-data").textContent = c.event === "tx_failed" ? `signer=${c.data?.signer ?? "?"}` : summarize(c.data);
    $("chain-tx").textContent = c.txHash ?? "";
  }
  document.querySelector(".bottom").classList.toggle("failed", c?.event === "tx_failed");
  const d = $("done");
  d.className = `done ${S.done ? (S.done.ok ? "ok" : "fail") : ""}`;
  d.textContent = S.done ? S.done.summary : "";
  renderReplay();
}

/** The Replay button shows once everything received so far has been played. */
function renderReplay() {
  $("replay").classList.toggle("hidden", !(S.done && !queue.length));
}

function summarize(data) {
  if (!data || typeof data !== "object") return "";
  return Object.entries(data).filter(([k]) => !k.endsWith("_ms")).map(([k, v]) => {
    let s;
    if (AMOUNT_KEYS.has(k) && /^\d+$/.test(String(v))) s = dec(Number(v) / 1e6);
    else if (k.endsWith("_bps")) s = pct(v);
    else if (Array.isArray(v)) s = v.join("/");
    else if (typeof v === "object" && v) s = "{…}";
    else s = String(v);
    if (s.length > 26) s = `${s.slice(0, 14)}…${s.slice(-6)}`;
    return `${k}=${s}`;
  }).join("  ");
}

// ---------------------------------------------------------------------------
// "Don't trust this page": the browser re-checks the testnet run on chain (verify.js)
// ---------------------------------------------------------------------------
const onTestnet = () => received.some((m) => m.kind === "mode" && m.network === "testnet");
const short = (h) => (h && h.length > 14 ? `${h.slice(0, 8)}…` : String(h ?? ""));
const nbTx = (h) => `${TESTNET.explorer}/txns/${encodeURIComponent(h)}`;
const nbAcct = (a) => `${TESTNET.explorer}/address/${encodeURIComponent(a)}`;
const mark = (ok) => (ok === true ? '<b class="vk ok">✓</b>' : ok === false ? '<b class="vk bad">✕</b>' : '<b class="vk na">–</b>');
let vrun = 0;

async function openVerify() {
  if (!onTestnet()) return;
  $("verify-panel").classList.remove("hidden");
  const run = ++vrun;
  renderVerify({ checks: [], jurors: [], events: [], running: "Starting…" });
  const out = await verifyOnChain(received, { onStep: (o) => { if (run === vrun) renderVerify(o); } });
  if (run === vrun) renderVerify({ ...out, finished: true });
}
function closeVerify() {
  vrun++;
  $("verify-panel").classList.add("hidden");
}

/** What the browser computed, step by step; from the recorded feed only the transaction hashes, call id and account names. */
function renderVerify(o) {
  const c = o.case, contract = o.contract;
  const sigs = o.jurors.filter((j) => j.sig === true).length;
  const failed = o.checks.find((x) => x.ok === false);
  let head;
  if (!o.finished) head = `<div class="vstatus run">${esc(o.running ?? "Checking…")}</div>`;
  else if (sigs === 3 && !failed) head = `<div class="vstatus ok">✓ 3 of 3 juror signatures valid, against keys read from the contract just now</div>`;
  else head = `<div class="vstatus bad">✕ ${o.jurors.length ? `${sigs} of 3 juror signatures valid` : "Not verified"}${failed ? `; failed: ${esc(failed.label)}` : ""}</div>`;
  const checks = o.checks.map((x) => `<li>${mark(x.ok)}<span class="vl">${esc(x.label)}</span><span class="vd">${esc(x.detail ?? "")}</span></li>`).join("");
  const rows = o.jurors.map((j) => `<tr>
      <td><b>${j.index + 1}</b> ${esc(j.model)}</td>
      <td class="mono" title="${esc(j.pubkey)}">${esc(fingerprint(j.pubkey))}</td>
      <td>${mark(j.prompt)} <span class="mono" title="${esc(j.requestSha256 ?? "")}">${esc(short(j.requestSha256))}</span></td>
      <td>${mark(j.answer)}</td>
      <td>${mark(j.sig)} ${j.sig === true ? "valid" : j.sig === false ? "invalid" : esc(j.error ?? "not checked")}</td>
      <td class="vvote ${esc(j.vote)}">${esc(j.vote)}${j.loggedVote && j.loggedVote !== j.vote ? ` <span class="vd">(logged ${esc(j.loggedVote)})</span>` : ""}</td>
    </tr>`).join("");
  const table = o.jurors.length ? `<table class="vtable"><thead><tr><th>Juror (model id read from chain)</th><th>Key read from chain</th><th>Prompt rebuilt here</th><th>Answer hash</th><th>Signature</th><th>Vote</th></tr></thead><tbody>${rows}</tbody></table>` : "";
  const evs = o.events.length ? `<div class="vevents"><span class="vl">Events in the transaction</span> ${o.events.map((e) => `<code>${esc(e.event)}</code> <span class="vd">${esc(eventSummary(e))}</span>`).join(" · ")}</div>` : "";
  const links = [c && `<a href="${nbTx(c.resolveTx)}" target="_blank" rel="noopener">resolve transaction ${esc(short(c.resolveTx))} on nearblocks</a>`, contract && `<a href="${nbAcct(contract)}" target="_blank" rel="noopener">contract ${esc(contract)} on nearblocks</a>`].filter(Boolean).join(" · ");
  const hosts = o.hosts?.size ? [...o.hosts].join(", ") : "";
  const notChecked = o.finished ? `<div class="vnote">Not checked here: that each key belongs to a NEAR AI enclave (the TDX attestation is checked offline by <code>make verify</code>; Intel and NVIDIA certificate chains are not verified anywhere, see docs/VERIFY.md). The contract owner registers the juror keys.</div>` : "";
  $("verify-card").innerHTML = `
    <div class="vhead"><h3>Checked against NEAR testnet, from this browser</h3><button class="replay" type="button" id="verify-close" title="Close (Esc)">Close</button></div>
    <div class="vsub">${hosts ? `Read just now from ${esc(hosts)}; prompts rebuilt and signatures checked here (WebCrypto Ed25519). From the page's recording only the transaction hashes, the call id and the account names are taken.` : o.finished ? "Nothing could be read from the public testnet RPC, so nothing here is verified." : "Asking the public testnet RPC…"}</div>
    ${head}<ul class="vchecks">${checks}</ul>${table}${evs}<div class="vlinks">${links}</div>${notChecked}`;
  $("verify-close").addEventListener("click", closeVerify);
}

function eventSummary(e) {
  const d = e.data ?? {};
  if (e.event === "ballots_verified") return `epoch ${d.epoch}, ${(d.kinds ?? []).length} ballots, votes ${(d.votes ?? []).join("/")}`;
  if (e.event === "dispute_resolved") return `tier ${d.tier}${d.winner ? `, ${d.winner} wins` : ""}, refund ${dec(Number(d.refund ?? 0) / 1e6)}`;
  return "";
}

// ---------------------------------------------------------------------------
// phones: the stage needs ~900 px; below that (style.css) a short summary of the run instead
// ---------------------------------------------------------------------------
function renderPhone() {
  const mode = received.find((m) => m.kind === "mode");
  const where = mode?.network === "testnet" ? "NEAR testnet" : mode?.network === "sandbox" ? "a local NEAR sandbox" : mode?.network;
  $("phone-mode").textContent = mode ? `Recorded on ${where}${mode.panel === "replay" ? ", with real NEAR AI juror answers and signatures" : ""}.` : "";
  $("phone-facts").innerHTML = received.filter((m) => m.kind === "scene" && m.status !== "start")
    .map((m) => `<li><b>${esc(SCENE_SHORT[m.n] ?? m.title)}.</b> ${esc(m.caption ?? m.line ?? m.title)}</li>`).join("");
  $("phone-done").textContent = received.find((m) => m.kind === "done")?.summary ?? "";
  let c = null;
  if (mode?.network === "testnet") { try { c = findCase(received); } catch { c = null; } }
  $("phone-links").innerHTML = [
    c && `<li><a href="${nbTx(c.resolveTx)}">The scene ${esc(c.scene)} refund on NEAR testnet</a>: three NEAR AI signatures verified by the contract</li>`,
    BRAND.repoUrl && `<li><a href="${esc(BRAND.repoUrl)}">${esc(BRAND.repoUrl.replace(/^https?:\/\//, ""))}</a>: code, README, how to run it</li>`,
  ].filter(Boolean).join("");
}

// ---------------------------------------------------------------------------
// motion
// ---------------------------------------------------------------------------
function fly(text, fromEl, toEl) {
  if (!fromEl || !toEl) return;
  const stage = $("stage"), scale = stageScale;
  const sr = stage.getBoundingClientRect();
  const a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
  const f = document.createElement("div");
  f.className = "flyer";
  f.textContent = text;
  $("flyers").appendChild(f);
  const x0 = (a.left - sr.left) / scale, y0 = (a.top - sr.top) / scale + 20;
  const x1 = (b.left - sr.left) / scale, y1 = (b.top - sr.top) / scale;
  f.style.left = "0px"; f.style.top = "0px";
  const anim = f.animate([
    { transform: `translate(${x0}px, ${y0}px) scale(.8)`, opacity: 0 },
    { transform: `translate(${x0}px, ${y0 - 30}px) scale(1.1)`, opacity: 1, offset: 0.15 },
    { transform: `translate(${x1}px, ${y1}px) scale(1)`, opacity: 1, offset: 0.85 },
    { transform: `translate(${x1}px, ${y1}px) scale(.9)`, opacity: 0 },
  ], { duration: 2000, easing: "ease-in-out" });
  anim.onfinish = () => f.remove();
}

let introMinUntil = 0;
function hideIntro() {
  const el = $("intro");
  if (el.classList.contains("hidden")) return;
  const wait = Math.max(0, introMinUntil - Date.now());
  if (!live) { el.style.transition = "none"; el.classList.add("hidden"); return; }
  setTimeout(() => { el.style.transition = ""; el.classList.add("hidden"); }, wait);
}

// ---------------------------------------------------------------------------
// stage scaling, branding, overlays
// ---------------------------------------------------------------------------
let stageScale = 1;
function fit() {
  stageScale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  const st = $("stage");
  st.style.transform = `scale(${stageScale})`;
  st.style.left = `${(window.innerWidth - 1920 * stageScale) / 2}px`;
  st.style.top = `${(window.innerHeight - 1080 * stageScale) / 2}px`;
}

function applyBrand() {
  document.title = `${BRAND.name}: demo`;
  const tl = BRAND.tagline;
  const text = {
    name: BRAND.name,
    tagline: tl,
    intro: BRAND.intro,
    endline: tl,
    built: BRAND.builtAt,
  };
  for (const el of document.querySelectorAll("[data-brand]")) el.textContent = text[el.dataset.brand] ?? "";
  const repo = $("end-repo");
  repo.hidden = !BRAND.repoUrl;
  repo.href = BRAND.repoUrl || "#";
  repo.textContent = BRAND.repoUrl.replace(/^https?:\/\//, "");
}

// ?intro=7 keeps the opening card up for at least 7 s; ?intro=0 skips it.
// ?end shows the end card. Keys: I toggles the opening card, E the end card, R replays.
// ?feed=other.json plays that file instead of the live feed.
const introParam = params.get("intro");
if (introParam === "0") $("intro").classList.add("hidden");
else if (introParam) introMinUntil = Date.now() + Number(introParam) * 1000;
if (params.has("end")) $("endcard").classList.remove("hidden");
$("replay").addEventListener("click", replay);
$("verify").addEventListener("click", openVerify);
$("verify-panel").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeVerify(); });
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeVerify();
  if (e.key === "r" || e.key === "R") replay();
  if (e.key === "e" || e.key === "E") $("endcard").classList.toggle("hidden");
  if (e.key === "i" || e.key === "I") $("intro").classList.toggle("hidden");
});
window.addEventListener("resize", fit);

applyBrand();
fit();
reset();
renderAll();
connect();
