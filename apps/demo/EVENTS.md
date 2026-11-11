# Demo event feed (runner → page)

The demo runner (`apps/demo/run.ts`) serves the page and a Server-Sent Events
stream at `http://localhost:4020/events`. Each SSE `data:` line is one JSON
object with a `kind` field and `t` (ms since epoch, when the runner emitted it). The page (`apps/demo/web/`) renders only from this
feed; it never talks to the chain itself. Amounts are decimal strings with 6
decimals as shown on screen (e.g. `"49.580000"`). Times are ms since epoch.

On connect, the runner first replays every message sent so far, so a page
opened mid-run (or after the run) gets the full history. The same messages, as
one JSON array, are served at `/feed.json` and saved at the end of a run
(`$CERTO_HOME/demo/feed.json`, default `~/.certo`; `--feed-out <path>` to
choose). Without `/events` (the page served as static files) the page plays
`feed.json` from its own directory, or the file named by `?feed=`.

The page plays messages in order and holds each one on screen for a minimum
time (`apps/demo/web/pace.js`): every scene stays at least 10 s, the juror ticks
at least 5 s, and a rule claim counts the seller's answer time down in real
time. A run that finishes in seconds, or a feed opened later, plays at the same
pace; the Replay button (key R) plays everything again. Page parameters:
`?speed=2` (faster), `?speed=0` (no pacing), `?upto=N` (stop after scene N),
`?intro=0` (no opening card), `?end` (end card).

| kind | fields | meaning |
|---|---|---|
| `mode` | `panel: "live" \| "replay" \| "replay-synthetic"`, `network: "sandbox" \| "testnet"`, `recordedAt?` | Shown as a label. `replay-synthetic` must be labelled "panel answers signed with a local TEST key (synthetic)". |
| `actors` | `buyers: [{id, label}]`, `sellers: [{id, label}]`, `jurors: [{index, model, name?, family}]` | Lane setup. `name` is the short juror name shown (e.g. `"Qwen"`; `model` is the full model id). |
| `state` | `buyers: {[id]: {balance}}`, `sellers: {[id]: {balance, bond, exposed, feeBps, record: {calls, losses}}}` | Full snapshot after every transaction. |
| `scene` | `n` (1–5; 5 runs on the sandbox only), `title`, `status: "start" \| "ok" \| "fail"`, `line?` (the transcript line on finish), `caption?` (short result the page shows at the scene end, ≤ 100 chars) | Scene boundaries. |
| `call` | `scene`, `buyer`, `seller`, `request` (string), `price`, `callId`, `status` (`null` on non-delivery), `responsePreview` (≤ 300 chars; empty on non-delivery), `fee`, `feeBps`, `windowMs`, `highlight?` (substring to highlight when the answer is not what was asked, e.g. `"\"token\":\"NEO\""`) | A paid API call. |
| `dispute` | `scene`, `callId`, `buyer`, `seller`, `disputeKind: "content" \| "non_delivery" \| "error" \| "rule"`, `buyerOfferPct?`, `sellerOfferPct?`, `stake`, `answerByMs?` (chain-time deadline for the seller's answer), `answerMs?` (length of the seller's answer time, the contract's `answer_ms`; the page counts it down) | Dispute opened / offers revealed (send again when the seller's offer arrives). |
| `vote` | `scene`, `callId`, `juror` (index), `model`, `vote: "buyer" \| "seller" \| "abstain"`, `sigVerified: boolean`, `latencyMs?` | One juror ballot; `sigVerified` true only after the contract accepted it. Send the three votes in juror order, before the `chain` events of the `resolve` transaction, so the footer never shows the verdict first. |
| `attack` | `scene`, `callId` (the demo contract's call), `juror` (index of the edited ballot), `from`, `to` (its answer letter before and after the one-byte edit), `build: "real" \| "no-check"`, `rejected: boolean`, `error?` (contract error code, e.g. `E_BALLOT_SIG`), `votes` (sides of the three ballots as submitted), `winner?`, `txHash?` | Scene 5: the forged ballot submitted to this contract (`real`, `res/certo.wasm`) and to the same contract built without the signature check (`no-check`, `res/guards/certo_no_g1.wasm`). |
| `resolved` | `scene`, `callId`, `tier: "panel" \| "rule" \| "default"`, `winner: "buyer" \| "seller"`, `refund`, `votes?: "3-0"` etc. (always buyer–seller order), `elapsedMs` | Settlement done. |
| `chain` | `event` (NEP-297 event name, or `tx_failed` with `data: {method, signer, error}`), `data` (object), `txHash` | Every contract event, for the footer (red for `tx_failed`). |
| `log` | `actor`, `text` | Agent log lines, e.g. `"asked NEAR, got NEO → claim a refund"`. |
| `done` | `ok: boolean`, `summary` | Final line, e.g. `DEMO OK: 5/5 scenes, 3/3 juror signatures verified on chain`. |

`state.sellers[id].record.calls` counts the calls paid to that seller in this
run (the contract's `lifetime_calls` counts released calls only).
