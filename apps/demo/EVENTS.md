# Demo event feed (runner → page)

The demo runner (`apps/demo/run.ts`) serves the page and a Server-Sent Events
stream at `http://localhost:4020/events`. Each SSE `data:` line is one JSON
object with a `kind` field and `t` (ms since epoch, when the runner emitted it). The page (`apps/demo/web/`) renders only from this
feed; it never talks to the chain itself. Amounts are decimal strings with 6
decimals as shown on screen (e.g. `"49.580000"`). Times are ms since epoch.

On connect, the runner first replays every message sent so far, so a page
opened mid-run (or after the run) shows the full state.

| kind | fields | meaning |
|---|---|---|
| `mode` | `panel: "live" \| "replay" \| "replay-synthetic"`, `network: "sandbox" \| "testnet"`, `recordedAt?` | Shown as a label. `replay-synthetic` must be labelled "panel answers signed with a local TEST key (synthetic)". |
| `actors` | `buyers: [{id, label}]`, `sellers: [{id, label}]`, `jurors: [{index, model, family}]` | Lane setup. |
| `state` | `buyers: {[id]: {balance}}`, `sellers: {[id]: {balance, bond, exposed, feeBps, record: {calls, losses}}}` | Full snapshot after every transaction. |
| `scene` | `n` (1–4, 5 optional), `title`, `status: "start" \| "ok" \| "fail"`, `line?` (the transcript line on finish) | Scene boundaries. |
| `call` | `scene`, `buyer`, `seller`, `request` (string), `price`, `callId`, `status` (`null` on non-delivery), `responsePreview` (≤ 300 chars; empty on non-delivery), `fee`, `feeBps`, `windowMs`, `highlight?` (substring to highlight, e.g. `"\"token\":\"NEO\""`) | A paid API call. |
| `dispute` | `scene`, `callId`, `buyer`, `seller`, `disputeKind: "content" \| "non_delivery" \| "error" \| "rule"`, `buyerOfferPct?`, `sellerOfferPct?`, `stake`, `answerByMs?` (deadline for the seller's answer, for the countdown) | Dispute opened / offers revealed (send again when the seller's offer arrives). |
| `vote` | `scene`, `callId`, `juror` (index), `model`, `vote: "buyer" \| "seller" \| "abstain"`, `sigVerified: boolean`, `latencyMs?` | One juror ballot; `sigVerified` true only after the contract accepted it. Send the three votes staggered (≥ 400 ms apart, in juror order) so the badges light one after another. |
| `resolved` | `scene`, `callId`, `tier: "panel" \| "rule" \| "default"`, `winner: "buyer" \| "seller"`, `refund`, `votes?: "3-0"` etc. (always buyer–seller order), `elapsedMs` | Settlement done. |
| `chain` | `event` (NEP-297 event name), `data` (object), `txHash` | Every contract event, for the footer. |
| `log` | `actor`, `text` | Agent log lines, e.g. `"asked NEAR, got NEO → claim a makegood"`. |
| `done` | `ok: boolean`, `summary` | Final line, e.g. `DEMO OK: 4/4 scenes, 3/3 juror signatures verified on chain`. |
