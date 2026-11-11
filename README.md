# Makegood

Bonded chargebacks for API calls paid by AI agents, on NEAR. Built at NEAR HACKATHON (November 2026).

<!-- FILL: repository URL --> · <!-- FILL: X post URL --> · Licence: MIT ([LICENSE](LICENSE))

## 1. What it is

A seller of a paid HTTP API deposits a bond in a NEAR contract. A buyer agent pays per call through the contract, and the seller receives the price minus a fee in the same transaction, as long as the seller's open refund risk fits inside its bond. For 120 s after each call the buyer can get the price back out of the bond: by rule for a seller-signed HTTP 5xx receipt, a missing delivery, or a broken published rule, and through a panel of three models (Qwen, GLM, DeepSeek on NEAR AI Cloud) for an answer that is well-formed but wrong. The contract rebuilds each juror's exact prompt, checks the three ed25519 signatures with `env::ed25519_verify`, counts the votes, and moves the money; no account decides the outcome.

**The problem.** A payment by an agent for an API call is final: if the response is an error, missing, or wrong, the agent has no way to get the money back. Escrow fixes this by making the seller wait, which honest sellers pay for on every call. Here the seller is paid at once and the bond carries the refund risk.

## 2. Try it: do X, see Y

Requirements: Node ≥ 20 (`.nvmrc`: 20) on macOS arm64, Linux x86-64 with glibc ≥ 2.34 (Ubuntu 22.04+, Debian 12+), or Linux aarch64 with glibc ≥ 2.39 (Ubuntu 24.04+, Debian 13+). No keys, no accounts, no Rust. The first run downloads the nearcore 2.10.0 sandbox binary through the `near-sandbox` npm package (26 MB download on macOS arm64, 33 MB on Linux x86-64, 31 MB on Linux aarch64; 66–90 MB unpacked). 2.10.0 is pinned because it is the newest nearcore whose Linux x86-64 sandbox runs on glibc 2.34; the Linux aarch64 sandbox builds checked (2.6.5, 2.7.0, 2.8.0, 2.9.0, 2.10.0) all need glibc 2.39, so Debian 12 on ARM cannot run the sandbox (the runner says so; `make verify` needs no chain). The committed wasm also runs on nearcore 2.14.0 ([CONTRACT_NOTES](docs/CONTRACT_NOTES.md#one-wasm-for-nearcore-2100-and-2140)). Checked on macOS arm64, on Linux aarch64 (Docker, glibc 2.41), and with the Linux x86-64 sandbox binary on glibc 2.36 under `qemu-x86_64`; not yet on x86-64 hardware, and Docker linux/amd64 on Apple silicon (Rosetta) crashes the sandbox ([table](docs/CONTRACT_NOTES.md#one-wasm-for-nearcore-2100-and-2140)). If the download fails, download `https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/<Darwin-arm64|Linux-x86_64|Linux-aarch64>/2.10.0/near-sandbox.tar.gz`, unpack it, and set `NEAR_SANDBOX_BIN_PATH` to the extracted `near-sandbox` file.

```sh
npm ci
make demo
```

**The panel answers in this demo are synthetic.** No NEAR AI key existed when this was written, so `fixtures/panel/` holds ballots signed with published local test keys (`fixtures/jurors.synthetic.json`, seed `makegood-synthetic-jurors-v1`). The run proves that the contract rebuilds the prompts, verifies three ed25519 signatures and settles on the votes; it proves nothing about NEAR AI or about how the models decide. The runner prints this itself (`NOTE: SYNTHETIC panel …`) and marks the lines `(synthetic test keys)`. Switching to real answers is described below the steps and **has not been run yet**.

Output of `make demo` on 2026-11-11 (macOS arm64, Apple M2, nearcore 2.10.0 sandbox), exit 0, 21.8 s:

1. `make demo` → see scene 1, the seller paid in the paying transaction:
   ```text
   Scene 1 honest call: scout paid chainfacts 0.400000, fee 0.004000 (1.0%), seller balance +0.396000 in the paying transaction Dd7bcAu6…
   ```
2. → see scene 2, a seller answers about NEO when asked for NEAR; the panel votes for the buyer, the contract verifies three signatures, the refund comes from the bond and the seller's fee steps up:
   ```text
   Scene 2 asked NEAR, got NEO: content dispute, votes buyer/buyer/buyer, 3 signatures verified by contract (synthetic test keys), refund 0.400000, bond 50.000000 → 49.580000, fee 1.0% → 1.5%
   ```
3. → see scene 3, a buyer disputes correct data and loses its stake:
   ```text
   Scene 3 lying buyer: scout-liar disputed correct data, votes seller/seller/seller, buyer stake 0.020000 forfeited; chainfacts bond 50.000000 unchanged, fee stays 1.0%
   ```
4. → see scene 4, the seller process is stopped after being paid; no answer within the window, refund by rule:
   ```text
   Scene 4 seller dead: seller did not answer in 5 s (demo setting; 30 s on testnet), refund 0.400000 by rule, no panel, bond 49.580000 → 49.160000, fee 1.5% → 2.5% (second loss)
   DEMO OK: 4/4 scenes, 3/3 juror signatures verified on chain (synthetic test keys)
   ```
   Every amount in these lines is read from the chain and compared with the expected value; a mismatch fails the scene and the exit code is 1 (`apps/demo/src/demo.ts`).
5. `make guards` → see each of eight contract checks reject its attack on `res/makegood.wasm` and let it through on a build with only that check removed (18.4 s):
   ```text
   G1     juror signature       rejected E_BALLOT_SIG              attack succeeded: forged vote counted, winner buyer                            rejected / succeeds-when-removed
   …
   G8     prompt binding        rejected E_BALLOT_SIG              attack succeeded: ballots for another prompt accepted, winner buyer            rejected / succeeds-when-removed
   GUARDS OK: 8/8 guards rejected on the real contract and bypassed when removed (18.4 s)
   ```
   G1 changes one byte of one juror's answer (Y → X) and keeps the signature. The full table and the attacks are in [docs/GUARDS.md](docs/GUARDS.md).
6. `make verify` (no chain, no network) → see the attestation reports checked against the committed juror keys and every recorded ballot checked offline:
   ```text
   VERIFY OK: 6 ballots (0 real, 6 synthetic) — synthetic ballots are signed with published test keys and prove nothing about NEAR AI
   Attestation check is key+nonce binding only; Intel/NVIDIA certificate chains are not verified (docs/VERIFY.md).
   ```
7. `make demo ARGS=--keep-open`, then open http://localhost:4020 → see three lanes (buyer agent, seller with bond bar and fee badge, panel with three juror badges), a mode label (`replay-synthetic` is shown as signed with a local TEST key) and the last contract event with its transaction hash. Stop with Ctrl-C. Screenshots: `apps/demo/web/screenshots/`.
8. `make test` → see 166 TypeScript tests pass in 27 s, including 12 end-to-end tests on the sandbox against the committed wasm (`tests/e2e/sandbox.test.ts`):
   ```text
   > @makegood/buyer@0.1.0 test
         Tests  10 passed (10)
   > @makegood/core@0.1.0 test
         Tests  122 passed (122)
   > @makegood/mcp@0.1.0 test
         Tests  3 passed (3)
   > @makegood/panel@0.1.0 test
         Tests  10 passed (10)
   > @makegood/seller@0.1.0 test
         Tests  9 passed (9)
   > @makegood/tests@0.1.0 test
         Tests  12 passed (12)
   ```
9. `cargo test --workspace` (needs Rust) → see 61 Rust tests pass: 28 unit tests (encoders, golden vectors, fee steps, settlement table, `parse_vote`, rules, G13 solvency property test), 14 guard tests (G1–G12, G14, G15), 19 sandbox tests. 202 s on the nearcore 2.10.0 sandbox, 287 s on 2.14.0 (macOS arm64, after compilation); both pass. If the `near-workspaces` build script fails with `DownloadError("timeout: connect")`, set `NEAR_SANDBOX_BIN_PATH` as above (after `make demo` the binary is at `node_modules/near-sandbox/bin/near-sandbox-2.10.0/near-sandbox`). Without it `near-workspaces` 0.22 downloads nearcore 2.13.4, which on Linux needs glibc 2.39.

### Switching to real NEAR AI answers (not run yet)

1. Put `NEARAI_API_KEY=…` in `.env` (copy `.env.example`; `.env` is git-ignored).
2. `make probe`: one call per juror; checks that each answer carries an ed25519 `provider_tee` signature over `sha256(sent body)` (DESIGN 2.1, K4) and picks the verification level.
3. `make killtest`: 60 labelled cases and 30 injection variants against the live panel, thresholds K1–K6 ([docs/KILLTEST.md](docs/KILLTEST.md)).
4. `make record`: records the demo's six ballots with their real signatures into `fixtures/panel/`. After that `make demo` runs in `replay` mode with the NEAR AI keys of `fixtures/jurors.json`, and `PANEL_MODE=live NEARAI_API_KEY=… make demo` asks the live panel during the run.

Results: <!-- FILL: date of the first real recording; K1–K6 values from docs/KILLTEST.md; verification level chosen after `make probe` -->

## 3. How NEAR is used

| NEAR feature | Where | Shown by |
|---|---|---|
| Contract verifies NEAR AI Cloud enclave signatures with `env::ed25519_verify` and `env::sha256`, over prompts it builds itself (and seller receipts the same way) | `contracts/makegood/src/panel.rs`, `encode.rs`, `dispute.rs` | `make guards` rows G1, G8; `cargo test -p makegood --test sandbox t07_verify_ballot_view_checks_juror_signature` |
| NEAR AI Cloud: three juror models of three families (`Qwen/Qwen3.8-27B`, `z-ai/glm-5.3-flash`, `deepseek-ai/DeepSeek-V4.1-Flash-1017`), each with its own enclave key; attestation reports (Intel TDX + NVIDIA) fetched without a key and committed | `fixtures/jurors.json`, `fixtures/attestations/2026-11-10/`, `scripts/fetch-attestations.ts` | `make verify` (key and nonce bound in the TDX quote's REPORTDATA). Chat answers: not yet recorded (section 2) |
| NEP-141 `ft_transfer_call` → `ft_on_transfer`: payment, bond deposit and dispute stake each enter the contract in one transaction; the payout to the seller is an `ft_transfer` in the same transaction | `contracts/makegood/src/pay.rs`, `dispute.rs` | Scene 1 line; `cargo test -p makegood --test sandbox t06_pay_moves_price_minus_fee_to_seller_in_same_tx` |
| NEP-297 events (`standard: "makegood"`) for every state change; the demo page and transcript read them | `contracts/makegood/src/events.rs` | `make demo ARGS=--keep-open`, footer of the page |
| Named sub-accounts: `v1.makegood.testnet`, `usdc.…`, `resolver.…`, `<seller>.sellers.makegood.testnet` | `.env.example`, `docs/TESTNET.md` | `make testnet-demo` (not run yet; section 8) |
| Function-call key for the seller's `answer` / `cure` (neither method is payable, so a key limited to these two methods can call them) | `contracts/makegood/src/dispute.rs` | Not demonstrated: the demo signs with full-access keys |
| NEAR Intents (refund in another asset) | — | Not built (section 5) |

## 4. Feature checklist for verification

| # | Feature | Files | Test | Command |
|---|---|---|---|---|
| M1 | Seller registration with bond; terms; pay through `ft_transfer_call` with payout in the same transaction; payment above free bond capacity bounces (`E_EXPOSURE`); lazy window expiry; bond withdrawal limited by open exposure (`E_WITHDRAW_EXPOSED`) | `contracts/makegood/src/{lib,pay,queue}.rs` | `t06_pay_moves_price_minus_fee_to_seller_in_same_tx`, `t06_lazy_release_and_withdraw`, guards G2, G6, `g9_history_never_raises_exposure`, `g13_solvency_property` | `cargo test --workspace`; `make guards` |
| M2 | Seller middleware: 402 quote, checks the paid call on chain (hash, terms, price, status), signs a receipt over the response bytes, also for 5xx | `packages/seller/src/` | `packages/seller/test/seller.test.ts`; e2e `seller refuses to serve a request body other than the one paid for` | `npm test -w @makegood/seller`; `npm test -w @makegood/tests -- -t "seller refuses"` |
| M2 | Demo seller behaviours: correct data, wrong token, HTTP 503, process stopped | `apps/demo/src/seller.ts`, `fixtures/demo/demo.json` | scenes 1–4; e2e `signed 5xx: claim_error refunds by rule, no stake, no panel` | `make demo`; `npm test -w @makegood/tests -- -t "signed 5xx"` |
| M3 | Buyer SDK and CLI: 402 → pay → retry with proof → verify receipt → decide to dispute | `packages/buyer/src/` | `packages/buyer/test/buyer.test.ts`; e2e `clean call: 402 → pay → retry → signed receipt; seller paid 0.396 in the paying transaction`, `buyer SDK refuses a response whose bytes differ from the signed receipt, keeping the call id for a claim` | `npm test -w @makegood/buyer`; `npm test -w @makegood/tests -- -t "clean call"` |
| M4 | Panel service, live and replay; checks evidence hashes and the sealed offer, takes the prompts from the contract view `build_panel_request`, verifies ballots offline before submitting | `packages/panel/src/` | `packages/panel/test/panel.test.ts` (live mode against a mock NEAR AI server only) | `npm test -w @makegood/panel` |
| M5 | Rule refund on a signed 5xx receipt; non-delivery claim with cure or default; content dispute with two offers; `resolve` verifies three juror signatures on chain (level L3) | `contracts/makegood/src/{dispute,panel}.rs` | `t08_*` (14 tests), e2e `upheld content dispute …`, `rejected content dispute …`, `non-delivery …`; guards G1, G3, G4, G5, G7, G8 | `cargo test -p makegood --test sandbox`; `make test`; `make guards` |
| M6 | Fee step from the dispute record (1.0% → 1.5% after one loss); exposure stays 1× bond in every tier | `contracts/makegood/src/fees.rs` | `t08_panel_buyer_wins_scene2_numbers_and_gas`, `g9_history_never_raises_exposure` | `make demo` (scene 2, 4 lines); `cargo test -p makegood --test guards g9` |
| M7 | Demo page: three lanes, balances, bond bar, fee badge, juror badges, event footer; fed by Server-Sent Events | `apps/demo/web/`, `apps/demo/src/feed.ts`, `apps/demo/EVENTS.md` | screenshots in `apps/demo/web/screenshots/` | `make demo ARGS=--keep-open`, open http://localhost:4020 |
| M8 | One-command demo, tests, guard tests against weakened builds, this README, licence | `Makefile`, `tests/guards/run.ts`, `res/guards/` | — | `make demo`; `make test`; `make guards` |
| S2 | Sealed buyer offer: commitment at dispute, reveal at `resolve` (`E_COMMIT_MISMATCH`) | `contracts/makegood/src/panel.rs` | `g10_sealed_offer` | `cargo test -p makegood --test guards g10` |
| S3 | Contract-checked rules: not JSON, missing field, stale (`claim_rule`) | `contracts/makegood/src/dispute.rs` | `t08_claim_rule_stale_missing_not_json`; e2e `rule claim: …` | `npm test -w @makegood/tests -- -t "rule claim"` |
| S4 | Offline check of recorded ballots and attestation binding | `scripts/verify-recorded.ts`, [docs/VERIFY.md](docs/VERIFY.md) | tamper table in docs/VERIFY.md | `make verify` |
| S5 | MCP server for the buyer side: `makegood_call`, `makegood_dispute`, `makegood_status` | `packages/mcp/src/` | `packages/mcp/test/mcp.test.ts` | `npm test -w @makegood/mcp` |
| S6 | Buyer record: ruling stake doubles after each lost dispute | `contracts/makegood/src/fees.rs` | e2e `rejected content dispute: panel 0–3, buyer stake to the treasury, buyer record doubles the next stake` | `npm test -w @makegood/tests -- -t "rejected content dispute"` |
| S1 | Testnet deployment and run | `scripts/deploy-testnet.ts`, `apps/demo/src/testnet.ts`, [docs/TESTNET.md](docs/TESTNET.md) | exercised against a local sandbox with testnet account names only | `npx tsx scripts/deploy-testnet.ts --dry-run`; `make testnet-demo` (not run on testnet yet) |

Encoder agreement between TypeScript and the contract: e2e `encoder agreement (contract views = @makegood/core) on every golden vector` and `t07_build_panel_request_matches_golden_vectors` (`fixtures/vectors.json`).

## 5. What is real / what is stubbed

| Area | Real | Stubbed or absent |
|---|---|---|
| Money | Contract logic on a local NEAR sandbox (nearcore 2.10.0; also tested on 2.14.0) with a NEP-141 token. Testnet code path written (`make testnet-demo`) | Token is a mock USDC with open `mint`. No mainnet, no real value. Not yet run on testnet |
| Jurors | Juror model ids and their ed25519 enclave keys, read from NEAR AI Cloud attestation reports on 2026-11-10; the contract verifies juror signatures with `ed25519_verify` | **No NEAR AI chat answer has been recorded yet.** `make demo` replays synthetic ballots signed with published test keys. Real recording (`make record`) and the live path need a NEAR AI key and have not been run |
| Attestation | Reports fetched from `cloud-api.near.ai` and committed; `make verify` checks that each TDX quote's REPORTDATA is `public key ‖ our nonce` and the MRTD matches | Intel and NVIDIA certificate chains, quote signatures and TCB status are not verified, by the contract or by the script. Juror keys are registered by the contract owner |
| Buyer and seller | HTTP server, middleware and client; buyer agent is a script with a fixed policy | Sellers are ours and serve fixture data; no third-party seller or buyer |
| x402 | v2 header names and object shapes (`PAYMENT-REQUIRED`, `PAYMENT-SIGNATURE`, `PAYMENT-RESPONSE`) | Own scheme `makegood-bonded`; no facilitator; a stock x402 client will not understand the scheme |
| Cross-chain refund | — | Not built. Refunds are always mock USDC on NEAR |
| Disputes | Rule tier (5xx receipt, non-delivery, not JSON, missing field, stale), content disputes with final-offer choice, sealed buyer offer, defaults on timeouts | No appeal. Re-asking is limited, not prevented. Responses over 6 KB cannot go to the panel |
| Track record | Fee tiers and counters in the contract; buyer stake multiplier | No time decay; counters are lifetime and since-last-step |
| Function-call keys | The seller's `answer` / `cure` need no deposit, so such a key can call them | Not demonstrated |

## 6. Trust model and limits

| Who | Can | Cannot |
|---|---|---|
| Contract owner | Replace the three juror keys (`set_jurors`, epoch + 1, event `jurors_set`), change the resolver, withdraw the treasury (fees and ruling fees) | Move bonds or stakes; decide a dispute |
| Resolver account (panel service) | Submit `resolve` alone for 60 s after the seller's answer; then anyone can | Forge a vote: each ballot must verify against a registered juror key over the prompt the contract builds (`make guards` G1, G8) |
| Seller | Answer a content dispute with an offer, cure a non-delivery claim by publishing the response | Deny a receipt it signed; withdraw bond below open exposure (G6) |
| Buyer | Dispute within the window, with a stake | Invent a receipt (G5); dispute twice (G3); dispute after the window (G4) |

Limits, each stated in DESIGN.md 4.3–4.4:

- **Re-asking.** A valid signature shows that an enclave serving model M produced this answer to this prompt, not that the model was asked once. The request is pinned (temperature 0, seed 7, no free parameters) and only the resolver may submit for 60 s, but the resolver operator could ask again until it gets the answer it wants. Removing this needs the caller to run in an enclave that attests a single ask, or an idempotency key at the provider. Not built.
- **Key registration.** The contract trusts the juror keys the owner registered. Anyone can compare them with the committed attestation reports (`make verify`), but the contract does not check the attestation itself.
- **Attestation check is key + nonce binding only.** `make verify` shows that the key and our nonce are inside a TDX quote with the expected MRTD; it does not verify the quote's signature, Intel's certificate chain, the NVIDIA evidence, or the event log ([docs/VERIFY.md](docs/VERIFY.md)). Instances of one model share a key, so a signature does not identify the instance.
- **Evidence is public at resolve.** Terms, request, response and the three raw juror answers are transaction arguments of `resolve`; a cured non-delivery publishes the response in the `cure` transaction. Not suitable for private data.
- **The buyer's sealed offer** is revealed to the panel service before `resolve`; the service is trusted not to pass it to the seller in that interval (the seller's offer is already fixed on chain).
- **False non-delivery claims** cost the buyer gas only (the stake is returned on cure); the seller pays one transaction per claim.
- **Size caps:** terms 1024 bytes, request 1024 bytes, response 6144 bytes for the panel tier (`E_EVIDENCE_SIZE`).
- **Exposure:** a seller's open refund risk (price + ruling fee per open call) never exceeds its bond; a payment that would exceed it bounces (G2). A clean record lowers the fee, never raises the limit (`g9_history_never_raises_exposure`).
- **Adoption:** sellers will bond only if buyers prefer bonded sellers. Not solvable in a hackathon; not tested.

## 7. Measured numbers

| Measure | Value | Reproduce |
|---|---|---|
| `make demo`, four scenes, replay-synthetic panel | 21.8 s, exit 0 (macOS arm64, Apple M2, nearcore 2.10.0 sandbox, 2026-11-11) | `make demo` |
| `make test` | 166 tests, 27 s | `make test` |
| `make guards` | 8/8, 18.4 s (13 s on nearcore 2.14.0) | `make guards` |
| `cargo test --workspace` | 61 tests; 202 s on nearcore 2.10.0, 287 s on 2.14.0 (compiled already) | `cargo test --workspace` |
| Gas: `resolve` with three `provider_tee` ballots, buyer wins, one refund | 10.64 TGas burnt (5 receipts; nearcore 2.10.0 and 2.14.0) | `cargo test -p makegood --test sandbox t08_panel_buyer_wins -- --nocapture` (line `GAS resolve`) |
| Gas: `ft_transfer_call` pay with payout | 11.57 TGas burnt (11.80 on nearcore 2.14.0) | `cargo test -p makegood --test sandbox t06_pay_moves -- --nocapture` |
| Contract size | `res/makegood.wasm` 354,412 bytes (~3.5 NEAR storage), SHA-256 `5a6a9031832a22767d533d4ca2e7bd7a87cd526ea8ebc108f8f03e8150e110a0` | `shasum -a 256 res/makegood.wasm`; `cat res/SHA256SUMS` |
| Cost per ruling | about 0.002 USD, **computed** from the NEAR AI price list for ~2,500 input and ~300 output tokens per juror (DESIGN 2.1), not measured | — |
| Kill test K1–K6 (accuracy on 60 labelled cases, flips on 30 injected cases, latency, signature level, abstentions, repeatability) | <!-- FILL: K1–K6 from `make killtest` (docs/KILLTEST.md) --> | `make killtest` |
| Panel latency: three answers + three signatures, wall clock | <!-- FILL: K3 numbers --> | `make killtest` |
| Testnet run time | <!-- FILL: elapsed time printed by `make testnet-demo` --> | `make testnet-demo` |

The kill-test cases are synthetic, written by us (evidence class: exploratory); a pass would show the panel decides clear cases and resists the injection lines we wrote, not how it behaves on real sellers' data.

## 8. Testnet deployment

Not deployed yet. The path is implemented: `make testnet-demo` deploys the market if needed (idempotent) and runs the same four scenes on testnet with a 30 s answer window and explorer links in the transcript. Procedure, expected output and errors: [docs/TESTNET.md](docs/TESTNET.md). Check the configuration without sending anything: `npx tsx scripts/deploy-testnet.ts --dry-run`.

<!-- FILL after the first `make testnet-demo` that ends in DEMO OK (docs/TESTNET.md step 7): -->

| Item | Value |
|---|---|
| Date, panel mode (live / replay / synthetic) | <!-- FILL --> |
| Contract | <!-- FILL: v1.makegood.testnet + explorer link --> |
| Token (mock USDC) | <!-- FILL: usdc.makegood.testnet + explorer link --> |
| Sellers | <!-- FILL: chainfacts.sellers.makegood.testnet, cheapfacts.sellers.makegood.testnet --> |
| Buyers, resolver | <!-- FILL --> |
| Deploy transactions | <!-- FILL --> |
| Scene 1 pay transaction | <!-- FILL --> |
| Scene 2 resolve transaction (panel for the buyer) | <!-- FILL --> |
| Scene 3 resolve transaction (panel for the seller) | <!-- FILL --> |
| Scene 4 resolve_default transaction | <!-- FILL --> |

<!-- FILL: the four scene lines and the DEMO OK line of that run, verbatim. If the panel mode was synthetic, keep: "The juror keys on this testnet contract are the published TEST keys; anyone can sign rulings on it." -->

## 9. Built at NEAR HACKATHON: window and disclosure

- Built for NEAR HACKATHON, window 2026-10-19 to 2026-11-14. First commit: <!-- FILL: date and hash of the first commit -->. No code from before the window: <!-- FILL: confirm, or name the pre-existing code and link the diff (HACKATHON.md Q-003) -->.
- Design document written 2026-11-10: [docs/DESIGN.md](docs/DESIGN.md).
- AI coding agents: Claude Code (Anthropic) wrote code and documents in this repository. <!-- FILL: other agents used (e.g. Codex), and what the humans wrote -->
- Team: <!-- FILL: names / handles -->
- Other projects submitted by the same person (HACKATHON.md Q-015): <!-- FILL: none, or name and link -->
- Templates or boilerplate: <!-- FILL: none, or name them -->. Libraries used (from npm and crates.io):

| Side | Libraries |
|---|---|
| Contract (Rust) | `near-sdk` 5.28.3, `near-contract-standards` 5.28.3 (pinned, [CONTRACT_NOTES](docs/CONTRACT_NOTES.md#one-wasm-for-nearcore-2100-and-2140)), `serde_json`; tests: `near-workspaces` 0.22, `tokio`, `ed25519-dalek`, `rand`, `sha2`, `hex`, `base64`, `anyhow`, `futures` |
| TypeScript | `@near-js/accounts`, `@near-js/crypto`, `@near-js/providers`, `@near-js/signers`, `@near-js/transactions`, `@near-js/types` (2.5), `near-sandbox` 0.3.5, `express` 5, `@modelcontextprotocol/sdk`, `zod`; dev: `typescript`, `tsx`, `vitest`, `@types/node`, `@types/express` |
| Local chain | nearcore 2.10.0 sandbox binary (downloaded at first run); wasm build: binaryen `wasm-opt` 132.0.0 via `npx` (MVP lowering, `make build` only) |
| External services | NEAR AI Cloud (`cloud-api.near.ai`): attestation reports (no key); chat completions and signatures (key, not yet used). NEAR testnet RPC `rpc.testnet.fastnear.com` (read-only `view_account` queries so far) |

## 10. Prior art and how this differs

x402r and KAMIYO x402Resolve hold the buyer's payment in escrow and ask both sides to trust an arbiter or an oracle quorum; Inari refunds only on timeout. Here the seller is paid at once against its own bond, and the NEAR contract checks three enclave-signed model votes before the bond pays out. Sources and the search method: DESIGN.md 5.3–5.4 (README and submission-name search of this hackathon's entries, 2026-11-10). `[NV]` marks what was not verified from a primary source.

| | Seller paid | Bad content covered | Who decides | Decision checkable on chain |
|---|---|---|---|---|
| x402r (Base) | After escrow release | Yes | "Independent arbiter" (unnamed) | No `[NV]` |
| KAMIYO x402Resolve (Solana devnet) | After escrow | Yes, 0–100% scale | Oracle quorum | Oracle signatures `[NV]` |
| Pact Network (Arbitrum Sepolia) | At once | No: 5xx, timeout, schema only, from a premium pool | Rules | Yes (rules) |
| Fortytwo x402escrow, Okay3 | After escrow / dispute period | `[NV]` | `[NV]` | `[NV]` |
| Inari (NEAR, this hackathon) | After worker signature | No: timeout refund only | Rule | Yes |
| Agora (NEAR, this hackathon) | After three reviewers pass tests | Software jobs with test suites | 3 reviewer agents in TEEs from different model families, then a DAO vote | Its README: "The release is final, so there are no chargebacks" |
| KAVREN, rubric-near (NEAR, this hackathon) | After acceptance / AI judge | Per job | Hosted evaluator / one AI judge | Partly |
| **Makegood** | **In the paying transaction, up to the bond** | **Yes** | Rules, then 3 models of 3 families | **Yes: the contract rebuilds the prompt and verifies the 3 signatures** |

Closest on single components: Agora (three model families in TEEs; escrow, no chargebacks), Demerit (a bond that pays the wronged client and pricing that follows the record; no payment flow, no judge), Covenant (bond slashed automatically, for Intents solvers, rule only). Pact Network is the rule tier of this project as a whole product. An IETF individual draft, `draft-hopley-x402-refund-receipt-02`, defines a refund-receipt format for x402 (seen in search results, not read); the receipt format here is our own (`makegood-receipt:v1|…`, DESIGN 4.3). Ten entries of this hackathon verify a NEAR AI Cloud signature or attestation; in their READMEs, none verifies it inside a contract for a money decision `[NV: READMEs searched, not code]`. Entries named Bonded, AgentBond, Taskbond and "Writ: Who Pays When Your AI Agent Gets Fooled" had no README to read `[NV]`. <!-- FILL: result of checking their X posts (DESIGN 7.1 H5), or delete this sentence -->

Not built, described as future work: an adapter to x402's `exact` scheme (FastNEAR's facilitator settles USDC on NEAR with a plain transfer to the payee, while this protocol needs the payment to pass through the contract); refunds in another asset through NEAR Intents (mainnet only); running the panel caller in an enclave (OutLayer) to attest a single ask per dispute.

## 11. Layout, development, licence

```text
contracts/makegood/   Rust contract (near-sdk 5.28.3): pay, queue, dispute, panel, fees, encode, events; tests/ sandbox.rs, guards.rs
contracts/mock-usdc/  NEP-141 test token with open mint
res/                  committed wasm builds, guards/makegood_no_g{1..8}.wasm, SHA256SUMS
packages/core/        canonical encoders (receipt, panel prompt, JSON escaping), chain client, types, golden-vector tests
packages/seller/      Express middleware protect() and the seller's answer bot
packages/buyer/       MakegoodClient SDK and the `makegood` CLI
packages/panel/       panel service (live | replay), resolver
packages/mcp/         stdio MCP server for the buyer side
apps/demo/            demo runner (4 scenes; sandbox or testnet), demo sellers, event feed, page in web/
fixtures/             jurors.json, attestations/, panel/ (ballots), demo/, killtest/, vectors.json
scripts/              build-contracts.sh, fetch-attestations, probe, killtest, record, verify-recorded, deploy-testnet
tests/                e2e/sandbox.test.ts, guards/run.ts
docs/                 DESIGN.md, CONTRACT_NOTES.md, TS_NOTES.md, GUARDS.md, KILLTEST.md, VERIFY.md, TESTNET.md, HACKATHON.md
```

| Command | Needs | Does |
|---|---|---|
| `make demo` | Node ≥ 20 | Local sandbox, both contracts from `res/`, four scenes, page at http://localhost:4020 (`ARGS=--keep-open` keeps it up) |
| `make test` | Node ≥ 20 | Unit tests of all packages and end-to-end tests on the sandbox |
| `make guards` | Node ≥ 20 | Attack vs. real and weakened contract, G1–G8 |
| `make verify` | Node only, no network | Offline check of attestation binding and recorded ballots |
| `make build` | Rust, `wasm32-unknown-unknown` target, Node (`npx` fetches binaryen 132.0.0) | Rebuilds every wasm in `res/` and `res/SHA256SUMS` (`./scripts/build-contracts.sh`). Each wasm is lowered to the WebAssembly MVP feature set with `wasm-opt` and must validate as MVP, because rustc 1.96's `std` emits sign-extension, bulk-memory and float-to-int instructions that nearcore 2.10.0 rejects; `near-sdk` is pinned to 5.28.3 because later versions import gas-key host functions 2.10.0 lacks ([docs/CONTRACT_NOTES.md](docs/CONTRACT_NOTES.md#one-wasm-for-nearcore-2100-and-2140)) |
| `make probe` / `make killtest` / `make record` | `NEARAI_API_KEY` | Signature probe / kill test / record demo ballots (exit 2 without a key) |
| `make testnet-demo` | testnet accounts and keys in `.env` | Deploy if needed, then the four scenes on testnet ([docs/TESTNET.md](docs/TESTNET.md)) |
| `npx tsc -b` | Node | Type-checks all TypeScript |

Design and decisions: [docs/DESIGN.md](docs/DESIGN.md) (specification), [docs/CONTRACT_NOTES.md](docs/CONTRACT_NOTES.md) (contract interface), [docs/TS_NOTES.md](docs/TS_NOTES.md) (TypeScript choices), [apps/demo/EVENTS.md](apps/demo/EVENTS.md) (page feed).

Licence: MIT, see [LICENSE](LICENSE).
