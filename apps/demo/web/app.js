"use strict";

// ---------------------------------------------------------------------------
// Product naming. The ONLY place the name, tagline and badge text live
// (docs/DESIGN.md 1.2). Rename here.
// ---------------------------------------------------------------------------
const BRAND = {
  name: "Makegood",
  tagline: "Agents pay instantly. Bad calls get made good.",
  badge: (bond, windowS) => `${BRAND.name} ✓ · bonded ${bond} USDC · refunds for ${windowS} s`,
  intro: "Your agent paid 0.40 for data. The data was wrong. Now what?",
  builtAt: "Built at NEAR HACKATHON",
  repoUrl: "", // filled in once the repository is public
};

// Refund window shown in the badge. The feed does not carry it yet; demo value from DESIGN 4.2.
const DEFAULT_WINDOW_MS = 120000;
const FEED_URL = "/events";
const SCENE_SHORT = { 1: "Honest seller", 2: "Wrong token", 3: "Lying buyer", 4: "Seller down", 5: "Stale data" };
const AMOUNT_KEYS = new Set(["price", "fee", "stake", "refund", "ruling_fee", "amount", "bond"]);
const DISPUTE_TYPES = new Set(["content", "non_delivery", "error", "rule"]);

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
// state (rebuilt from scratch on every (re)connect: the runner replays history)
// ---------------------------------------------------------------------------
let S;
let live = false; // false while the runner replays history: no animations
let quietTimer = null;
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
    resolved: {},
    caseId: null,
    chain: null, done: null,
    down: {}, // seller id -> true while not responding
  };
}

// ---------------------------------------------------------------------------
// feed
// ---------------------------------------------------------------------------
function connect() {
  const es = new EventSource(FEED_URL);
  es.onopen = () => {
    reset();
    live = false;
    buildActors();
    renderAll();
    armQuiet();
  };
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg);
    renderAll();
    armQuiet();
  };
  es.onerror = () => {
    if (!S.done) setCaption("Feed disconnected; reconnecting…", "fail");
  };
}
function armQuiet() {
  if (live) return;
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => { live = true; }, 250);
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
      S.scenes[m.n] = { ...(S.scenes[m.n] ?? {}), title: m.title, status: m.status, line: m.line };
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
      if (!S.votes[m.callId]) S.votes[m.callId] = [];
      if (S.caseId !== m.callId) S.buyerNote[m.buyer] = null;
      S.caseId = m.callId;
      break;
    }
    case "vote":
      (S.votes[m.callId] ??= [])[m.juror] = m;
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
      <div><div class="model">${esc(j.model)}</div><div class="family">${esc(j.family)} family · own enclave</div><div class="sig"></div></div>
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
    if (m.panel === "live") { label = "Panel: live answers from NEAR AI Cloud enclaves"; box.classList.add("live"); }
    else if (m.panel === "replay") {
      const when = m.recordedAt ? new Date(isNaN(Number(m.recordedAt)) ? m.recordedAt : Number(m.recordedAt)).toISOString().slice(0, 10) : "earlier";
      label = `Panel answers recorded ${when}, signatures verified live`;
      box.classList.add("replay");
    } else if (m.panel === "replay-synthetic") { label = "Panel answers signed with a local TEST key (synthetic)"; box.classList.add("synthetic"); }
    else label = `Panel: ${m.panel}`;
    $("mode-panel").textContent = label;
    $("mode-net").textContent = m.network === "testnet" ? "Chain: NEAR testnet" : m.network === "sandbox" ? "Chain: local NEAR sandbox" : `Chain: ${m.network ?? "?"}`;
  }
  const ns = Object.keys(S.scenes).map(Number);
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
    if (cur.status === "start") setCaption(`Scene ${S.current} · ${cur.title}`, "");
    else setCaption(cur.line ?? `Scene ${S.current} · ${cur.title}`, cur.status === "fail" ? "fail" : "ok");
  } else if (S.mode) setCaption("Ready: waiting for scene 1", "");
}

function setCaption(text, cls) {
  const c = $("caption");
  c.className = `caption ${cls}`;
  const span = $("caption-text");
  if (span.textContent !== text) span.textContent = text;
  span.style.fontSize = "";
  if (span.scrollWidth > c.clientWidth - 64) span.style.fontSize = "21px";
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
    el.querySelector(".log").innerHTML = logs.map((l) => `<li class="${/makegood|claim/i.test(l) ? "claim" : ""}" title="${esc(l)}">${esc(l)}</li>`).join("");
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

  box.innerHTML = `
    <div class="call-head"><b>${esc(c.buyer)}</b> → <b>${esc(c.seller)}</b><span class="spacer"></span>${c.highlight ? '<span class="mismatch">mismatch</span>' : ""}<span class="http ${ok ? "ok" : "bad"}">${statusTxt}</span></div>
    <code class="req">${reqHtml}</code>
    <div class="pay"><span class="neg">−${amt(c.price)}</span> ${esc(c.buyer)} → <span class="pos">+${dec(net)}</span> ${esc(c.seller)} · fee ${dec(fee)}${feeBps !== undefined ? ` (${pct(feeBps)})` : ""}<br><span class="same">paid in the same transaction</span></div>
    ${respHtml}`;
}

function renderSellers() {
  const { seller } = activePair();
  const windowS = Math.round((S.mode?.windowMs ?? DEFAULT_WINDOW_MS) / 1000);
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

  // Case card
  if (!d) {
    const cur = S.scenes[S.current];
    caseBox.innerHTML = `<div class="case-head"><span class="case-kind">No dispute</span></div><div class="idle">${
      S.call ? `The seller was paid at once. Its bond covers a refund for ${Math.round((S.mode?.windowMs ?? DEFAULT_WINDOW_MS) / 1000)} s.` : cur ? "Waiting for the call…" : "The panel is idle until a buyer claims a makegood."}</div>`;
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
      <div class="case-head"><span class="case-kind">Content dispute</span><span class="parties"><b>${esc(d.buyer)}</b> vs <b>${esc(d.seller)}</b></span><span class="stake">stake ${amt(d.stake)}</span></div>
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
    const sig = el.querySelector(".sig"), vote = el.querySelector(".vote");
    if (v) {
      el.classList.add(`v-${v.vote}`);
      if (v.sigVerified) el.classList.add("verified");
      vote.innerHTML = `${esc(v.vote.toUpperCase())}<small>${v.latencyMs ? secs(v.latencyMs) : "&nbsp;"}</small>`;
      sig.className = `sig ${v.sigVerified ? "ok" : ""}`;
      sig.textContent = v.sigVerified ? "✓ signature verified by contract" : "signature not yet verified";
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
  if (!r) {
    res.className = "result";
    res.innerHTML = `<div class="empty">${d ? (isRule ? "Waiting for the seller…" : "Waiting for the verdict…") : "No verdict needed."}</div>`;
  } else if (r.tier === "panel") {
    const b = votes.filter((v) => v?.vote === "buyer").length, s = votes.filter((v) => v?.vote === "seller").length;
    const score = votes.length ? `${b}–${s}` : String(r.votes ?? "").replace("-", "–");
    res.className = `result ${r.winner}`;
    const what = r.winner === "buyer"
      ? `for the buyer · refund ${amt(r.refund)} out of the seller's bond`
      : `for the seller · ${Number(r.refund) > 0 ? `refund ${amt(r.refund)}` : "no refund"} · buyer's stake ${amt(d?.stake ?? "0")} forfeited`;
    res.innerHTML = `<div class="score">${score}<span class="in">in ${secs(r.elapsedMs)}</span></div><div class="what">${what}</div>`;
  } else {
    res.className = "result";
    const answerMs = answerWindow(id);
    const head = d?.type === "non_delivery" ? `seller silent ${Math.round(answerMs / 1000)} s` : `seller error`;
    res.innerHTML = `<div class="rule">${head}</div><div class="rule-sub">→ refund by rule, no panel</div><div class="what">refund ${amt(r.refund)} to ${esc(d?.buyer ?? "buyer")} · ${secs(r.elapsedMs)}</div>`;
  }
}

function answerWindow(id) {
  const d = S.disputes[id];
  const by = S.answerBy[id];
  if (by && d?.openedAt) return Math.max(0, by - d.openedAt);
  return S.resolved[id]?.elapsedMs ?? 0;
}

function tickCountdown() {
  const el = $("cd");
  if (!el || !S.caseId) return;
  const id = S.caseId, d = S.disputes[id], r = S.resolved[id];
  const by = S.answerBy[id] ?? (d.openedAt + 5000);
  const rem = r ? 0 : Math.max(0, by - Date.now());
  el.textContent = secs(rem);
  el.classList.toggle("done", !!r);
  const sub = $("cd-sub");
  if (sub) sub.textContent = r ? "seller never answered" : rem > 0 ? "seller must answer or deliver" : "time is up";
}
setInterval(tickCountdown, 100);

function renderFooter() {
  const c = S.chain;
  if (c) {
    $("chain-event").textContent = c.event;
    $("chain-data").textContent = summarize(c.data);
    $("chain-tx").textContent = c.txHash ?? "";
  }
  const d = $("done");
  d.className = `done ${S.done ? (S.done.ok ? "ok" : "fail") : ""}`;
  d.textContent = S.done ? S.done.summary : "";
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
  if (!live && wait === 0) { el.style.transition = "none"; el.classList.add("hidden"); return; }
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
    repo: BRAND.repoUrl,
    built: BRAND.builtAt,
  };
  for (const el of document.querySelectorAll("[data-brand]")) el.textContent = text[el.dataset.brand] ?? "";
}

// ?intro=7 keeps the opening card up for at least 7 s; ?intro=0 skips it.
// ?end shows the end card. Keys: I toggles the opening card, E the end card.
const introParam = params.get("intro");
if (introParam === "0") $("intro").classList.add("hidden");
else if (introParam) introMinUntil = Date.now() + Number(introParam) * 1000;
if (params.has("end")) $("endcard").classList.remove("hidden");
window.addEventListener("keydown", (e) => {
  if (e.key === "e" || e.key === "E") $("endcard").classList.toggle("hidden");
  if (e.key === "i" || e.key === "I") $("intro").classList.toggle("hidden");
});
window.addEventListener("resize", fit);

applyBrand();
fit();
reset();
renderAll();
connect();
