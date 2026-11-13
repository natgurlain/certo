// Landing page behaviour: the hero money flow, its static frames in "How it works", the on-demand video
// and the inline verify check. No dependencies; the verify check is apps/demo/web/verify.js (via verify-view.js).
import { mountVerify } from "/verify-view.js";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------------------------------------------------------------- money flow
// Amounts per beat, from the testnet run: 0.40 paid, 0.396 to the seller after the 1% fee,
// 0.40 refunded, bond down 0.42 (refund plus the 0.02 ruling fee).
const AMOUNTS = {
  0: { agent: 10, api: 0, bond: 50 },
  1: { agent: 9.6, api: 0, bond: 50 },
  2: { agent: 9.6, api: 0.396, bond: 50 },
  3: { agent: 9.6, api: 0.396, bond: 50 },
  4: { agent: 10, api: 0.396, bond: 49.58 },
};
/** 10 -> "10.00", 0.396 -> "0.396": at least two decimals, at most three. */
const fmt = (n) => n.toFixed(3).replace(/0$/, "");
const BEAT_MS = 2400, HOLD_MS = 2000, RESET_MS = 700;

function setAmounts(root, step, animate) {
  for (const [key, to] of Object.entries(AMOUNTS[step])) {
    const el = root.querySelector(`[data-amt="${key}"]`);
    if (!el) continue;
    const from = Number(el.textContent);
    if (!animate || from === to) { el.textContent = fmt(to); continue; }
    const t0 = performance.now(), dur = 700, delay = key === "agent" && step === 4 ? 1100 : key === "api" ? 150 : 200;
    const tick = (now) => {
      const p = Math.min(1, Math.max(0, (now - t0 - delay) / dur));
      const e = p * (2 - p);
      el.textContent = fmt(from + (to - from) * e);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

const flow = document.getElementById("flow");
if (flow) {
  const svg = flow.querySelector(".flow-svg");
  // static frames for "How it works": copies of the hero drawing, frozen at one beat
  for (const box of document.querySelectorAll("[data-frame]")) {
    const copy = svg.cloneNode(true);
    copy.removeAttribute("aria-labelledby");
    copy.setAttribute("aria-hidden", "true");
    copy.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    const step = Number(box.dataset.frame);
    box.dataset.step = String(step);
    setAmounts(copy, step, false);
    box.append(copy);
  }

  const dots = [...flow.querySelectorAll("[data-go]")];
  const playBtn = flow.querySelector(".flow-play");
  let step = 4, timer = 0, playing = !reduced, visible = true;

  function show(n, animate = true) {
    step = n;
    flow.dataset.step = String(n);
    for (const d of dots) {
      if (Number(d.dataset.go) === Math.max(1, n)) d.setAttribute("aria-current", "step");
      else d.removeAttribute("aria-current");
    }
    setAmounts(flow, n, animate && !reduced);
  }
  function restart() {
    // jump back to the start without transitions, then play beat 1
    flow.classList.add("flow-reset");
    show(0, false);
    void flow.offsetWidth;
    flow.classList.remove("flow-reset");
    timer = setTimeout(() => { show(1); schedule(); }, RESET_MS);
  }
  function schedule() {
    clearTimeout(timer);
    if (!playing || !visible) return;
    if (step >= 4) timer = setTimeout(restart, BEAT_MS + HOLD_MS);
    else timer = setTimeout(() => { show(step + 1); schedule(); }, BEAT_MS);
  }
  function setPlaying(p) {
    playing = p;
    playBtn.dataset.playing = String(p);
    playBtn.setAttribute("aria-label", p ? "Pause the illustration" : "Play the illustration");
    if (p) { if (step >= 4) restart(); else schedule(); } else clearTimeout(timer);
  }
  for (const d of dots) d.addEventListener("click", () => { setPlaying(false); show(Number(d.dataset.go)); });
  playBtn.addEventListener("click", () => setPlaying(!playing));

  if (reduced) { setPlaying(false); show(4, false); }
  else {
    new IntersectionObserver((entries) => {
      const v = entries[0].isIntersecting;
      if (v === visible) return;
      visible = v;
      if (visible && playing) { if (step >= 4) restart(); else schedule(); } else clearTimeout(timer);
    }, { threshold: 0.25 }).observe(flow);
    document.addEventListener("visibilitychange", () => { visible = !document.hidden; if (visible && playing) schedule(); else clearTimeout(timer); });
    show(4, false);
    restart();
  }
}

// ---------------------------------------------------------------- video, loaded only when asked for
const openBtn = document.getElementById("video-open");
if (openBtn) {
  openBtn.addEventListener("click", () => {
    const box = document.getElementById("video-box"), video = document.getElementById("video");
    const opening = box.hidden;
    box.hidden = !opening;
    openBtn.setAttribute("aria-expanded", String(opening));
    openBtn.textContent = opening ? "Hide the video" : "Watch the 60-second video";
    if (opening) {
      const src = video.querySelector("source[data-src]");
      if (src) { src.src = src.dataset.src; src.removeAttribute("data-src"); video.load(); }
      video.play().catch(() => {});
      box.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    } else video.pause();
  });
}

// ---------------------------------------------------------------- verify
const vroot = document.querySelector("[data-verify]");
if (vroot) {
  const btn = vroot.querySelector("[data-verify-run]");
  let running = false;
  btn.addEventListener("click", async () => {
    if (running) return;
    running = true;
    btn.disabled = true;
    btn.textContent = "Checking…";
    await mountVerify(vroot);
    btn.disabled = false;
    btn.textContent = "Check again";
    running = false;
  });
}
