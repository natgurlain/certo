// The "Don't trust this page" check, as four plain sentences (landing) or with the full report (/verify).
// All the checking is apps/demo/web/verify.js, the same module the replay's verify button uses: it reads the
// contract and the ruling transaction from NEAR testnet and checks the three juror signatures with WebCrypto.
// From our side only the recorded feed is used, for the transaction IDs and account names.
import { TESTNET, verifyOnChain, fingerprint } from "/demo/verify.js";

const FEED_URL = "/demo/feed.json";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usdc = (base) => (Number(base) / 1e6).toFixed(2);
const short = (h) => (h && h.length > 14 ? `${h.slice(0, 8)}…` : String(h ?? ""));
const txUrl = (h) => `${TESTNET.explorer}/txns/${encodeURIComponent(h)}`;
const acctUrl = (a) => `${TESTNET.explorer}/address/${encodeURIComponent(a)}`;

/** The four sentences: state "run" | "ok" | "bad" | "na", plus a reason when not ok. */
export function summarize(o, finished) {
  const check = (id) => o.checks.find((c) => c.id === id);
  const pending = finished ? "na" : "run";
  const stopped = o.checks.find((c) => c.ok === false && ["feed", "crypto", "pay", "keys"].includes(c.id));
  const fromCheck = (c, extra = true) => (!c ? (stopped ? "na" : pending) : c.ok && extra ? "ok" : "bad");

  const tx = check("tx");
  const dr = o.events.find((e) => e.event === "dispute_resolved")?.data;
  const refunded = dr && dr.winner === "buyer" && Number(dr.refund) > 0;
  const lines = {
    tx: { state: fromCheck(tx, refunded), why: tx && !(tx.ok && refunded) ? tx.detail : stopped?.detail, refund: dr ? usdc(dr.refund) : null },
    code: { state: fromCheck(check("code")), why: check("code")?.ok === false ? check("code").detail : null },
  };

  const sigs = o.jurors.filter((j) => j.sig === true).length;
  const epoch = check("epoch");
  const jurorsDone = o.jurors.length === 3 && (finished || o.jurors.every((j) => j.sig !== null || j.error));
  lines.sigs = {
    sigs,
    state: !jurorsDone ? (finished || stopped || (tx && !tx.ok) ? "na" : "run") : sigs === 3 && epoch?.ok !== false ? "ok" : "bad",
    why: jurorsDone && sigs < 3 ? o.jurors.find((j) => j.sig !== true)?.error ?? "a signature did not verify" : epoch?.ok === false ? epoch.detail : null,
  };
  const ev = check("evidence");
  const bound = o.jurors.length === 3 && o.jurors.every((j) => j.prompt === true && j.answer === true);
  lines.evidence = {
    state: !ev || !jurorsDone ? (finished || stopped ? "na" : "run") : ev.ok && bound ? "ok" : "bad",
    why: ev && !ev.ok ? ev.detail : jurorsDone && !bound ? "a juror's rebuilt prompt or answer hash does not match the ruling" : null,
  };
  return lines;
}

function renderLines(root, o, finished) {
  const s = summarize(o, finished);
  for (const [id, line] of Object.entries(s)) {
    const li = root.querySelector(`[data-line="${id}"]`);
    if (!li) continue;
    li.dataset.state = line.state;
    let d = li.querySelector(".vdetail");
    if (line.state === "bad" || (line.state === "na" && finished)) {
      if (!d) { d = document.createElement("span"); d.className = "vdetail"; li.lastElementChild.append(d); }
      d.textContent = line.state === "na" ? "Not checked: an earlier step failed." : line.why ?? "";
    } else d?.remove();
  }
  if (s.tx.refund) root.querySelectorAll("[data-refund]").forEach((n) => (n.textContent = s.tx.refund));
  if (s.sigs.state === "ok" || s.sigs.state === "bad") root.querySelectorAll("[data-sigs]").forEach((n) => (n.textContent = String(s.sigs.sigs)));
  return s;
}

const mark = (ok) => (ok === true ? '<b class="mk ok">✓</b>' : ok === false ? '<b class="mk bad">✕</b>' : '<b class="mk na">–</b>');

function renderReport(el, o) {
  const checks = o.checks.map((c) => `<li>${mark(c.ok)}<span class="vl">${esc(c.label)}</span><span class="vd">${esc(c.detail)}</span></li>`).join("");
  const rows = o.jurors.map((j) => `<tr>
      <td data-th="Juror (model id read from the contract)"><b>${j.index + 1}</b> ${esc(j.model)}</td>
      <td data-th="Key read from the contract" class="mono" title="${esc(j.pubkey)}">${esc(fingerprint(j.pubkey))}</td>
      <td data-th="Prompt rebuilt in this browser">${mark(j.prompt)} <span class="mono" title="${esc(j.requestSha256)}">${esc(short(j.requestSha256))}</span></td>
      <td data-th="Answer hash">${mark(j.answer)}</td>
      <td data-th="Signature (Ed25519)">${mark(j.sig)} ${j.sig === true ? "valid" : j.sig === false ? "invalid" : esc(j.error ?? "not checked")}</td>
      <td data-th="Vote" class="vote-${esc(j.vote)}">${j.vote === "buyer" ? "for the buyer" : j.vote === "seller" ? "for the seller" : esc(j.vote)}</td>
    </tr>`).join("");
  const c = o.case;
  el.innerHTML = `
    <h2>Every check</h2>
    <ul class="vchecks">${checks || '<li><b class="mk na">–</b><span class="vl">Nothing checked yet</span><span class="vd"></span></li>'}</ul>
    ${rows ? `<h2>The three votes of the <span class="exp">experimental</span> AI panel</h2>
    <table class="jurors"><thead><tr><th>Juror (model id read from the contract)</th><th>Key read from the contract</th><th>Prompt rebuilt in this browser</th><th>Answer hash</th><th>Signature (Ed25519)</th><th>Vote</th></tr></thead><tbody>${rows}</tbody></table>` : ""}
    ${o.events.length ? `<p class="vevents">Events in the ruling transaction: ${o.events.map((e) => `<code>${esc(e.event)}</code>`).join(" · ")}</p>` : ""}
    <p class="vlinks">${[c && `<a href="${txUrl(c.resolveTx)}">Ruling transaction ${esc(short(c.resolveTx))} on NearBlocks <span aria-hidden="true">↗</span></a>`,
      c && `<a href="${txUrl(c.payTx)}">Payment ${esc(short(c.payTx))} <span aria-hidden="true">↗</span></a>`,
      o.contract && `<a href="${acctUrl(o.contract)}">Contract ${esc(o.contract)} <span aria-hidden="true">↗</span></a>`].filter(Boolean).join(" · ")}</p>`;
}

/**
 * Run the check and render it into `root`: `[data-line]` items, `[data-verify-meta]`, and when present
 * `[data-verify-report]` (the full report) and `[data-verify-tx]` (a NearBlocks link, pointed at the ruling checked).
 */
export async function mountVerify(root) {
  const meta = root.querySelector("[data-verify-meta]");
  const report = root.querySelector("[data-verify-report]");
  const empty = { checks: [], jurors: [], events: [], hosts: new Set() };
  meta.classList.remove("bad");
  meta.textContent = "Asking NEAR testnet…";
  renderLines(root, empty, false);

  let feed;
  try {
    const r = await fetch(FEED_URL, { cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    feed = await r.json();
  } catch (e) {
    feed = null;
  }
  const out = await verifyOnChain(feed ?? [], { onStep: (o) => { renderLines(root, o, false); if (report) renderReport(report, o); } });
  const s = renderLines(root, out, true);
  if (report) renderReport(report, out);

  const txLink = root.querySelector("[data-verify-tx]");
  if (txLink && out.case) txLink.href = txUrl(out.case.resolveTx);
  const hosts = [...(out.hosts ?? [])];
  const allOk = Object.values(s).every((l) => l.state === "ok");
  const nearblocks = txLink ? txLink.href : out.case ? txUrl(out.case.resolveTx) : TESTNET.explorer;
  if (!hosts.length) {
    meta.classList.add("bad");
    meta.innerHTML = `Could not reach NEAR testnet from this browser. <a href="${esc(nearblocks)}">Open the transaction on NearBlocks instead <span aria-hidden="true">↗</span></a>`;
  } else if (allOk) {
    meta.textContent = `Read just now from ${hosts.join(", ")}, in your browser.`;
  } else {
    meta.classList.add("bad");
    meta.textContent = `Read just now from ${hosts.join(", ")}, in your browser. Not every check passed: the reasons are above.`;
  }
  return out;
}
