# Contract notes

Companion to [DESIGN.md](DESIGN.md) sections 4.2–4.5 and 4.8. It records the
interface the TypeScript side calls and every choice made where the design was
open. Source: `contracts/certo/src/` (`lib`, `pay`, `dispute`, `panel`,
`fees`, `queue`, `encode`, `events`, `consts`).

## Build and test

| Command | Does |
|---|---|
| `./scripts/build-contracts.sh` (`make build`) | Builds `res/certo.wasm`, `res/mock_usdc.wasm`, `res/guards/certo_no_g{1..8,16,17}.wasm`, writes `res/SHA256SUMS`. Local paths are remapped out of the wasm |
| `cargo test -p certo --lib` | Unit tests: encoders, golden vectors, fee steps, settlement table, `parse_vote`, rules, exposure, G13 property test |
| `cargo test -p certo --test sandbox` | Sandbox tests for T06/T07/T08 against `res/*.wasm` |
| `cargo test -p certo --test guards -- --nocapture` | G1–G17; for G1–G8, G16 and G17 the same attack against `res/certo.wasm` and `res/guards/certo_no_gN.wasm`, printing the pair |
| `cargo test --workspace` | All of the above |

Sandbox tests deploy the wasm in `res/`, so run the build script first after a
source change. The Rust sandbox tests use whatever nearcore binary
`near-workspaces` 0.22.4 downloads at build time (its default, 2.13.4, which
on Linux needs glibc 2.39) unless `NEAR_SANDBOX_BIN_PATH` points at another
`near-sandbox` binary. If the download fails (seen here:
`DownloadError("timeout: connect")`), download
`https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/<Darwin-arm64|Linux-x86_64|Linux-aarch64>/<version>/near-sandbox.tar.gz`
and set `NEAR_SANDBOX_BIN_PATH` to the extracted `near-sandbox`; after
`make demo` the 2.10.0 binary is at
`node_modules/near-sandbox/bin/near-sandbox-2.10.0/near-sandbox`.

### One wasm for nearcore 2.10.0 and 2.14.0

The TypeScript demo, tests and guard runner pin the nearcore **2.10.0**
sandbox (`SANDBOX_VERSION` in `apps/demo/src/sandbox.ts`): it is the newest
release whose Linux x86-64 binary needs only glibc 2.34 (Ubuntu 22.04,
Debian 12); 2.11.0 to 2.14.0 need glibc 2.38/2.39. The same committed wasm
also runs on 2.14.0 (protocol 88). Two things make that possible:

1. **`near-sdk` pinned to `=5.28.3`** (with `near-contract-standards`
   `=5.28.3`, dev-dependency `near-workspaces` 0.22, and `near-sdk-env`
   locked at 0.1.6 in `Cargo.lock`). In 5.29.1 (checked; 5.30.x as well) the
   SDK's `Promise` code references the gas-key host functions
   (`promise_batch_action_transfer_to_gas_key`,
   `promise_batch_action_add_gas_key_with_full_access`,
   `promise_batch_action_add_gas_key_with_function_call`), so every contract
   that builds a promise imports them, and nearcore 2.10.0 refuses to link it
   (`Link Error: UnknownImportError env.promise_batch_action_transfer_to_gas_key`).
   The contracts use none of the newer APIs; the source is unchanged by the
   pin. The build passes `--locked` so the lockfile pins hold.
2. **MVP lowering with binaryen `wasm-opt` 132.0.0** (npm `binaryen`, fetched
   by `npx` in the build script). rustc 1.96's precompiled wasm32 `std` uses
   sign-extension, bulk-memory and non-trapping float-to-int instructions;
   nearcore 2.10.0 rejects them (`PrepareError: Deserialization`) and
   `-C target-cpu=mvp` alone does not remove them, because `std` is not
   rebuilt. Each wasm is run through
   `wasm-opt --enable-bulk-memory --enable-bulk-memory-opt --enable-sign-ext
   --enable-nontrapping-float-to-int --enable-mutable-globals
   --enable-multivalue --enable-reference-types --signext-lowering
   --llvm-memory-copy-fill-lowering --llvm-nontrapping-fptoint-lowering
   --strip-target-features -O2`, then must validate with
   `wasm-opt --mvp-features --enable-mutable-globals` or the build fails.
   (`--all-features` is avoided: with memory64 enabled the lowering passes
   fail.) The unlowered wasm fails that validation.

Two test-harness changes came with it (contract unchanged): the Rust tests
attach 300 TGas (`TX_GAS`) instead of near-workspaces `max_gas()` (1 PGas,
over nearcore 2.10.0's per-transaction limit of 300 TGas), and G12 disputes
30 s into the window, because on 2.10.0 with all guard tests in parallel the
sweep at the old expiry landed ~6.5 s late, past a new expiry only ~2 s after
the old one.

Two TypeScript changes keep the 2.10.0 runs stable, both behaviour-neutral, both
in `signAndSend` in `packages/core/src/chain.ts`. (1) It signs and sends a
transaction again when the node answers `InvalidChain` ("Transaction parent
block hash doesn't belong to the current chain") before admitting it: on macOS
the 2.10.0 sandbox did so in 3 of 4 `make guards` runs (3 to 7 of the 8 rows
failed); 8 of 8 runs passed after the change. (2) Under load the sandbox answers
`send_tx` with `TIMEOUT_ERROR` (HTTP 408), and near-js then resent the request
with growing back-off for minutes with no output (`make guards` hung once in
four runs). Now each RPC request is made once, a transaction has 60 s in all
(`TX_TIMEOUT_MS`), and on a timeout the client looks the transaction up by hash
and, if the node does not know it, resends the **same signed bytes** (one nonce,
one hash), so it can never execute twice; past the limit it throws
`TxTimeoutError` with the hash. (3) Transactions reference the latest *final*
block, not the optimistic head near-js uses: after the merge of 2026-11-11, 2
of 12 full `make guards` runs had one setup transaction that the node knew but
never executed (`tx` answered 408 for 60 s; most likely signed against a head
that never became canonical, the same cause as `InvalidChain`). The demo prints
the sandbox version it runs.

**Linux check, 2026-11-13** (commit 28933b8, Docker on Apple Silicon, host heavily loaded): arm64
`node:20` (bookworm, glibc 2.36) running the **x86-64** nearcore 2.10.0 binary through
`qemu-x86_64-static`: `make demo` 5/5, `make guards` 10/10 (G4 and G16 need more than 120 s
under emulation, hence the 300 s per-guard limit and `GUARD_TIMEOUT_S`), `make verify`, `make test`
209/209. Native arm64 `node:20-trixie` (glibc 2.41): the same, all pass. Under Docker Desktop's
default **Rosetta** amd64 emulation the x86-64 sandbox panics at `rustix auxv.rs:302` (the
emulator's auxiliary vector), an emulator artefact. **Native x86-64:** GitHub Actions `ubuntu-22.04` (glibc 2.35), clean checkout, 2026-11-13 (run 43426231788): `make demo` 5/5, `make verify` 375 real ballots, `make guards` 10/10 in 53 s, `make test` all pass; 2 min 19 s in all.

**Current build** (split rule G17, panel-timeout rule G16 and the panel request's `max_tokens`
4096): `certo.wasm` 356,230 bytes, SHA-256 `aca96429481139397fe5e265659a9fe9a85093dddf827766d58c189ec7299b71`;
it imports `sha256` and `ed25519_verify` from `env` and none of the gas-key host
functions. Checked on macOS arm64 only, 2026-11-11, nearcore 2.10.0:
`cargo test --workspace` 63/63 (28 unit, 16 guard, 19 sandbox), `make guards` 10/10 in
three consecutive runs (60 to 70 s), the G17 guard-revert (the `no_g17` build swapped in
as `certo.wasm` fails G17; restored by hash), `npm test` 209/209 at that commit, 211 since (the MCP sandbox file
needed one rerun under load), `make verify` 375 real ballots and `make demo` `DEMO OK: 5/5`.
Not re-run on nearcore 2.14.0 for this build. The Linux rows of the table were checked on the
earlier builds below and not repeated.

Verified on 2026-11-11 with the pre-rename build (`makegood.wasm` 354,412 bytes, SHA-256 `5a6a9031…`). The rename to Certo changed only brand strings; the rebuilt `certo.wasm` (354,388 bytes, SHA-256 `9e8118ad…`) was re-checked on macOS arm64 only (demo, `npm test`, `make guards`, `cargo test` on nearcore 2.10.0):

| Where | nearcore | Result |
|---|---|---|
| macOS arm64 (Apple M2) | 2.10.0 | `make demo`, `make test` (166), `make guards` 8/8, `make verify`; `cargo test --workspace` 61/61 |
| macOS arm64 | 2.14.0 (`NEAR_SANDBOX_BIN_PATH`) | `cargo test --workspace` 61/61, `make guards` 8/8 |
| Docker `node:20-trixie` linux/arm64 (glibc 2.41), clean copy, `npm ci` | 2.10.0 (downloaded) | `make demo`, `make test`, `make guards` 8/8, `make verify` |
| Docker `node:20` linux/arm64 (Debian 12, glibc 2.36) | 2.10.0 x86-64 binary under `qemu-x86_64` 7.2 with the `node:20` amd64 glibc 2.36 libraries (`NEAR_SANDBOX_BIN_PATH`) | `make demo`, `make test`, `make guards` 8/8, `make verify` |
| Docker `node:20` linux/arm64 (glibc 2.36) | 2.10.0 aarch64 | refused with the glibc message; `make verify` passes |
| Docker `node:20` linux/amd64 on Apple silicon (Rosetta) | 2.10.0 | the binary starts, then panics in `rustix` auxv parsing (`param/auxv.rs:302`) when it applies the first chunk. Most likely an emulator artefact (the same binary passes under qemu, row above); not run on real x86-64 hardware |

Testnet runs a newer protocol than 2.14.0; that it accepts the wasm is not
verified.

Toolchain: stable rustc 1.96.1; no toolchain pin is needed. The build script
calls plain `cargo build` with the flags `cargo near build` uses: **`--cfg
near` is required** (near-sdk selects the on-chain host functions only under
this cfg; without it `sha256`, `ed25519_verify` and panics compile to
pure-Rust fallbacks, every `require!` message is lost as a wasm `unreachable`
trap, and the wasm grows to ~635 KB) and `-C link-arg=-s`. The built
`certo.wasm` imports `sha256` and `ed25519_verify` from `env`. It is about
354 KB, so the contract account needs about 3.5 NEAR for code storage.

## Encodings at the contract boundary

- 32-byte values (ed25519 public keys, SHA-256 hashes, commitments, salts):
  lower-case hex, 64 characters. Anything else panics `E_BAD_ARGS`.
- 64-byte ed25519 signatures (receipts, ballots): standard base64 with padding.
- Token amounts: decimal strings (`U128`). Times: integer JSON numbers (ms).
- `quote_id`: 32 lower-case hex characters; `call_id = "<seller>/<quote_id>"`.
- Events: NEP-297 `EVENT_JSON:{"standard":"certo","version":"1.0.0","event":…,"data":{…}}`;
  `data` is one object (not an array).
- Renaming: user-visible names (receipt prefix, event standard, system prompt)
  are constants in `src/consts.rs`.

## Methods (exact JSON argument names)

Init and owner:

```text
new({owner, token, resolver, cfg: Config, jurors: [JurorArg; 3], gateway_key: hex|null})
set_jurors({jurors: [JurorArg; 3], gateway_key: hex|null})         owner; epoch += 1
set_resolver({account})                                             owner
withdraw_treasury({amount, to})                                     owner
Config  = {min_bond, min_price, window_min_ms, window_max_ms, answer_ms, resolver_exclusive_ms,
           panel_deadline_ms, stake_min, stake_bps, max_terms, max_request, max_response,
           accept_gateway: bool}
JurorArg = {model_id, pubkey: hex, attestation_sha256: hex}
```

Seller:

```text
register_seller({receipt_pubkey: hex, window_ms})                   attach 1 NEAR
add_terms({terms_id, text, required_fields?: [string], as_of_field?: string|null, max_age_s?: u32|null, panel: bool})
withdraw_bond({amount})                                             returns the transfer promise
answer({call_id, offer_bps})                                        no deposit (function-call key works)
cure({call_id, response_hash: hex, status_code, served_at_ms, sig: b64, response_body})
```

Through `token.ft_transfer_call({receiver_id: <contract>, amount, msg})`, 1 yocto, 100 TGas;
`msg` is a JSON string:

```text
{"action":"bond"}                                                   sender must be a registered seller
{"action":"pay","seller","quote_id","terms_id","request_hash"}      amount = price
{"action":"dispute","kind":"non_delivery","call_id"}                amount = stake
{"action":"dispute","kind":"content","call_id","response_hash","status_code","served_at_ms","sig","offer_commit"}
```

Buyer and anyone:

```text
claim_error({call_id, response_hash, status_code, served_at_ms, sig})
claim_rule({call_id, response_hash, status_code, served_at_ms, sig, response_body})
resolve({call_id, buyer_offer_bps, salt: hex, request_canon, response_body, ballots: [Ballot]})   attach 200 TGas
resolve_default({call_id, buyer_offer_bps?: u16, salt?: hex})
release({seller, max?: u32})                                        returns items consumed
withdraw_claimable({})
Ballot = {response_body: string (raw juror response), signature: b64, kind: "provider_tee"|"gateway"}
```

Views:

```text
get_config({}) -> {owner, token, resolver, cfg, treasury, fee_bps: [..], sweep_max, receipt_prefix}
get_jurors({}) -> {epoch, jurors: [JurorArg], gateway_key, accept_gateway}
get_seller({id}) -> null | {bond, reserved, disputed_reserved, free_capacity, fee_idx, fee_bps, window_ms,
                     lifetime_calls, lifetime_losses, splits, lifetime_volume, clean_calls_since_step,
                     clean_volume_since_step, recovery_volume, receipt_pubkey, queue_len}
get_terms({seller, terms_id}) -> null | {text, required_fields, as_of_field, max_age_s, panel}
get_call({call_id}) -> null | {call_id, buyer, seller, terms_id, price, fee, reserve, request_hash,
                     paid_at_ms, expires_at_ms, status: "Open"|"NonDeliveryClaimed"|"Disputed"|"Answered",
                     dispute: null | {kind, opened_at_ms, answer_by_ms, stake, buyer_commit, response_hash,
                                      status_code, served_at_ms, seller_offer_bps, answered_at_ms}}
get_buyer({id}) -> {disputes_won, disputes_lost, stake_mult_log2, stake_multiplier, splits}
quote({seller, price}) -> {fee, fee_bps, stake, reserve, free_capacity, would_fit}
build_panel_request({juror_idx, terms_text, request_canon, response_body, buyer_bps, seller_bps}) -> string
receipt_text({call_id, response_hash, status_code, served_at_ms}) -> string
verify_ballot({juror_idx, kind, request_body, response_body, signature}) -> bool
claimable_of({id}) -> amount
```

Events: `jurors_set`, `resolver_set`, `treasury_withdrawn`, `seller_registered`,
`terms_added`, `bond_changed`, `call_paid`, `call_released`, `fee_tier_changed`,
`dispute_opened`, `dispute_answered`, `cured`, `ballots_verified`,
`dispute_resolved` (`tier`: `rule` | `settled` | `panel` | `default`),
`transfer_failed`.

## Choices where the design was open

1. **Extra error strings.** The design's list is kept; added: `E_BAD_ARGS`
   (malformed hex/base64/msg, wrong ballot count, bad window), `E_NO_CALL`
   (unknown or already ended call), `E_DEPOSIT`, `E_REGISTERED`, `E_OWNER_ONLY`,
   `E_TREASURY_LOW`, `E_NOTHING_CLAIMABLE`. Invalid `terms_id` or oversized terms
   text is `E_TERMS`. A second registration is `E_REGISTERED`.
2. **L3-gateway behind `cfg.accept_gateway`.** Each ballot names its `kind`.
   `provider_tee`: text `<model_id>:<sha(req)>:<sha(resp)>`, juror key.
   `gateway`: text `<sha(req)>:<sha(resp)>`, `gateway_key`; accepted only when
   `accept_gateway` is true and a gateway key is set, otherwise `E_BALLOT_SIG`.
   The two kinds may be mixed in one `resolve`. The request body is always rebuilt
   by the contract, so a gateway ballot is still bound to its juror's model id.
3. **`parse_vote`.** The `<think>` block is stripped only if the content starts
   with `<think>` at byte 0 and contains `</think>`; whitespace is ASCII
   space/tab/LF/FF/CR (not VT, not NBSP). This matches `packages/core` and
   `fixtures/vectors.json`.
4. **Settlement shortcut** (`seller_offer ≥ buyer_offer`) ignores ballots; an
   empty `ballots` array is fine. The panel path needs exactly three.
5. **`resolve_default` after the panel deadline: no verdict pays the seller's
   offer.** A reveal that does not match the commitment panics `E_COMMIT_MISMATCH`
   (it is not treated as "no reveal"). If a valid reveal is at or below the
   seller's offer, it settles at the buyer's offer (`reason: "settled"`), as
   `resolve` would; otherwise the **seller's offer** is paid and the stake returned
   (`"seller_offer"`); without a reveal, the seller's offer applies and the stake
   goes to the treasury (`"no_reveal"`). None of these changes either party's
   record.
   Why: only the buyer holds its reveal, and the panel cannot rule without it. The
   earlier rule (midpoint with a valid reveal) let a buyer dispute an honest call at
   100 %, keep its reveal from the panel, and take 50 % of the price plus its stake
   back after 300 s, risk-free (guard G16 shows it on the weakened build). Under the
   new rule withholding the reveal never pays more than the seller offered. The
   buyer can always force a verdict itself: `resolve` is open to **any** account
   once `resolver_exclusive_ms` (60 s) has passed after the answer, and it stays
   callable until someone calls `resolve_default`; so a buyer whose panel service is
   down runs the three jurors with its own NEAR AI key (`npx certo resolve`) in the
   240 s between 60 s and the 300 s deadline. A buyer who does nothing gets what the
   seller offered and its stake back (with the reveal), no loss on its record: the
   same as accepting the offer. The seller cannot force a panel (it lacks the
   reveal) but gains nothing from the deadline beyond its own offer. Known residual:
   after the deadline anyone, including the seller, may call `resolve_default`
   without the reveal, which sends the buyer's stake to the treasury; a buyer should
   resolve or call `resolve_default` with its reveal before 300 s.
6. **Rule refunds.** `claim_error`, `claim_rule` and a `cure` with status ≥ 500
   refund the price, return any stake, charge no ruling fee and record a seller
   loss. Only the no-answer default (`seller_no_answer`) also charges the seller
   the base ruling fee. A buyer win is recorded only when a dispute (with stake)
   existed.
7. **`claim_rule` checks, in order:** body is JSON (`not_json`); each
   `required_fields` name at top level (`missing_field:<name>`); if both
   `as_of_field` and `max_age_s` are set, the field must be a non-negative integer
   (else `missing_field:<as_of_field>`) and `served_at_ms/1000 − as_of > max_age_s`
   gives `stale:<age_s>`. Future `as_of` is not stale. Body cap 16 KB, as `cure`.
8. **Stake.** The whole amount sent with a dispute is the stake (no change is
   returned); it must be at least `stake_for(price) × 2^k`.
9. **Counters.** `lifetime_calls` and `lifetime_volume` count released (clean)
   calls only, as the sweep rule says; losses are counted in `lifetime_losses`.
10. **Repeated non-delivery claims** after a cure are allowed (known gap in 4.3).
11. **Views simulate the sweep** for at most `SWEEP_MAX` = 32 items, the same as
    `pay` and `withdraw_bond`, so `quote.would_fit` predicts `pay`.
12. **`release(seller, max)`**: `max` is optional (default and cap 32).
13. **`verify_ballot`** (the T07 test method) is an ordinary view: it checks one
    signature over given request and response bodies and ignores
    `accept_gateway`. `Ballot.request_hash` is accepted in JSON and ignored by the
    real contract; only `no_g8` uses it.
14. **Guard features.** All ten `no_gN` features are built into `res/guards/`
    (the design lists six; `no_g4` and `no_g6` cost nothing extra; `no_g16` was
    added with the panel-timeout rule of item 5, `no_g17` with the split rule of item 17):
    G1 ballot signature check, G2 exposure check in `pay`, G3 status check when a
    dispute opens, G4 window check (disputes, `claim_error`, `claim_rule`), G5
    receipt signature check, G6 exposure check in `withdraw_bond`, G7 evidence
    hash check in `resolve`, G8 contract-built request hash (the weakened build
    trusts `Ballot.request_hash`), G16 panel-timeout payout (the weakened build pays
    the midpoint of the two offers with a valid reveal, as before item 5 changed),
    G17 split-panel payout (the weakened build pays the midpoint of the two offers on
    a split instead of the seller's offer).
15. **No real NEAR AI recording exists yet.** Ballot tests sign with generated
    ed25519 keys in the exact `provider_tee` / `gateway` text format. The test
    `t07_recorded_nearai_signatures_verify_on_chain` reads every
    `fixtures/panel/*.json` (4.4 replay format; signature and key as hex, `0x`hex
    or base64), checks that `signature.text` equals the text the contract
    rebuilds, registers the recorded key with `set_jurors`, and calls
    `verify_ballot`. With no recordings it passes and prints that nothing was
    verified. `CERTO_PANEL_DIR` points it at another directory (checked here
    with three synthetic recordings).
16. **`get_seller.free_capacity`** includes the simulated sweep; `reserved` is
    the stored (possibly stale-high) value.
17. **Split panel: the seller's offer, at once, on both records (G17).** When
    `resolve` carries exactly three ballots, all three signatures verify over the
    prompts the contract builds, and there is no majority (fewer than two equal
    X/Y votes; abstentions are signed answers that are neither), the dispute
    settles in that transaction: the buyer gets `price × seller_offer_bps / 10000`
    from the bond plus its whole stake; no seller loss, no fee step, no ruling fee,
    no change to the buyer's stake multiplier; `splits` (u32) += 1 on both the
    seller's and the buyer's record (`get_seller`, `get_buyer`; `certo_quote`
    shows `seller_record.split_disputes`). Nothing reads `splits` for fees: it is
    information for the other side of the next call. The call is removed.
    Events: `ballots_verified` as for a majority, then
    `dispute_resolved{call_id, tier: "split", votes, refund, refund_bps, stake_returned}`.
    `E_NO_MAJORITY` no longer exists. Fewer than three verifying ballots still fail
    with `E_BALLOT_SIG`, so a split cannot be faked to close a dispute. The same
    resolver window applies as for any `resolve` (resolver only for 60 s, then
    anyone with the reveal, i.e. the buyer).
    Why: before, a split failed with `E_NO_MAJORITY` and waited for the
    panel-timeout rule, which pays the seller's offer anyway; in the kill test one
    seller-planted line split a case the panel otherwise gave the buyer 3–0
    (`docs/KILLTEST.md` run 2, INJ-R-B2-01). A midpoint on a split was rejected
    (maintainer decision, 2026-11-11): a buyer could provoke abstentions with its own
    request text (up to 1,024 bytes, inside the prompt) or collect them by re-asking,
    and take half the price from honest sellers. Under this rule no money moves to the
    buyer without a majority; a planter keeps the seller's offer, but not a clean
    record, and the planted text is public in the transaction arguments.
    Known costs: a split is final, so the buyer cannot re-ask for a majority; a buyer
    that re-asks until a split can add a split to an honest seller's record (it gains
    no money and the split is on its own record too).

## Measured (`res/certo.wasm` of this build, macOS arm64; nearcore 2.10.0, 2.14.0 in brackets where different)

| Transaction | Gas burnt, all receipts | Reproduce |
|---|---|---|
| `resolve` with three `provider_tee` ballots, buyer wins, one refund transfer | 10.64 TGas | `cargo test -p certo --test sandbox t08_panel_buyer_wins -- --nocapture` (line `GAS resolve`) |
| `resolve` with a gateway/provider_tee mix | 10.63 TGas | `… t08_gateway_ballots -- --nocapture` |
| `ft_transfer_call` pay with payout | 11.56 TGas (11.79) | `… t06_pay_moves -- --nocapture` |
| 600 payments from 20 concurrent buyers | 51 s wall clock (36 s) | `cargo test -p certo --test guards g9 -- --nocapture` |
