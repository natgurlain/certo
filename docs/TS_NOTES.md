# TypeScript packages: decisions where DESIGN.md is ambiguous

Each entry is the simplest reading that meets the acceptance checks. Where the
contract must agree, the choice is marked **(contract)**.

## Encodings on the wire and in contract arguments

- **32-byte values as arguments (contract):** `request_hash`, `response_hash`,
  `offer_commit`, `salt`, `receipt_pubkey` are passed as 64-char lower-case
  hex strings. Signatures (`sig`, ballot `signature`) are base64 of 64 bytes,
  as the spec says. Views may return 32-byte values as hex, base64 or a JSON
  byte array: `toHex32` in `packages/core/src/chain.ts` normalises all three,
  so the contract's choice of view serialisation does not matter to TS.
- **`ft_transfer_call` msg (contract):** a JSON string,
  `{"action":"pay","seller","quote_id","terms_id","request_hash"}`,
  `{"action":"bond"}`, `{"action":"dispute","kind":"non_delivery","call_id"}`,
  `{"action":"dispute","kind":"content","call_id","response_hash","status_code","served_at_ms","sig","offer_commit"}`.
- **View argument names (contract):** `get_seller({id})`, `get_buyer({id})`,
  `claimable_of({id})`, `get_terms({seller, terms_id})`, `get_call({call_id})`,
  `quote({seller, price})`, `build_panel_request({juror_idx, terms_text,
  request_canon, response_body, buyer_bps, seller_bps})`,
  `receipt_text({call_id, response_hash, status_code, served_at_ms})`,
  `release({seller, max})`, `answer({call_id, offer_bps})`. `get_jurors` may
  return either `[Juror;3]` or `{jurors, gateway_key, epoch}`; both are read.
- **NEAR AI ed25519 `signature` field:** its encoding is not documented. Core
  accepts 128-char hex (with or without `0x`) or base64 (`decodeSignature`);
  `signing_address` may be hex, `0x`hex, base64 or `ed25519:<base58>`.
  Synthetic ballots use plain lower-case hex for both. The resolver always
  re-encodes signatures as base64 for the contract.

## Encoders

- `esc` rejects strings with lone UTF-16 surrogates (they have no UTF-8 form,
  so the contract can never receive them); otherwise it equals
  `JSON.stringify(s).slice(1, -1)`, checked on every BMP code point.
- `parseVote`: "strip one leading `<think>…</think>`" is read as: the content
  must **start** with `<think>` (no whitespace before it); if there is no
  closing tag the vote is an abstention. "Trim ASCII whitespace" is Rust's
  `trim_ascii` set (space, `\t`, `\n`, `\f`, `\r`; not `\v`, not NBSP).
- `buildCase` offer text: `N = floor(offer_bps / 100)`; offers are multiples of
  100 so this is exact.
- `stakeFor` (client-side helper only) floors `price × stake_bps / 10000`. The
  contract's `quote` view is authoritative; the buyer SDK uses it.

## Synthetic ballots

No NEAR AI key exists yet. `makeSyntheticBallot` produces a recording in the
exact replay-fixture shape (`fixtures/panel/<sha256 of request body>.json`)
with `synthetic: true`, signed by `syntheticJurorKey(i, seed)` =
ed25519 seed `sha256("<seed>:juror:<i>")` (gateway: `"<seed>:gateway"`),
default seed `certo-synthetic-jurors-v1`. A sandbox contract initialised
with these public keys accepts them; `make record` replaces them.

The contract in `contracts/certo` (read on 11 Nov) uses the same choices:
hex for 32-byte arguments and view fields, `Base64VecU8` for signatures,
`get_config` nests the settings under `cfg` (the TS wrapper flattens it).

## Packages

- **Source-only workspaces.** Each package's `exports` points at
  `src/index.ts`; everything runs under `tsx` / `vitest`, and the `certo`
  and `certo-mcp` bins are small JS shims that register `tsx`. No build
  step; `npx tsc -b` at the root type-checks all packages (`noEmit`).
- **Chain access.** `@near-js/{accounts,providers,signers,transactions}` 2.x,
  not `near-api-js` 7 (which declares Node ≥ 22.22). `NearCertoChain` takes
  an RPC URL, contract, token and an `ed25519:…` secret key (or any signer), so
  a near-workspaces sandbox account works via `keyPair.toString()`.
  `CertoChain` is the injectable interface; `@certo/core/testing`
  exports `FakeChain`, an in-memory stand-in used only by unit tests (it is
  not a model of the contract).
- **Seller `protect()`.** Option `contract` is the chain client. The
  middleware must be mounted before any body parser: it reads the raw body,
  computes `request_canon` from `req.method`, `req.originalUrl` and the raw
  body, and hands the handler the raw body as a string in `req.body`. A paid
  request that does not match (hash, terms, price, status, seller) gets a 402
  with an `error` field and a fresh quote. Window and fee in the 402 come from
  `get_seller`. When free capacity looks short it fires `release(seller, 32)`
  if its client can sign. Served calls are cached in memory (a repeat with the
  same `call_id` and request returns the same bytes and receipt).
- **Answer bot.** `createAnswerBot` polls `get_call` for the calls this
  middleware served: answers content disputes with a fixed offer (default 0)
  and cures non-delivery claims with the stored body and receipt. A seller
  that never served the call cannot cure it (as intended for the dead seller).
- **Buyer.** `call()` refuses before paying if the quote's `payTo`/`asset`
  differ from the configured contract/token, the price exceeds `maxPrice`,
  the seller or terms are unknown, or `quote().would_fit` is false. After
  paying it throws `CertoError` with `callId` set (`TIMEOUT`,
  `NO_RECEIPT`, `RECEIPT_MISMATCH`, `BAD_RECEIPT_SIG`) so the agent can claim
  non-delivery. Ruling stake = `quote().stake × 2^get_buyer().stake_mult_log2`.
  The CLI keeps results and sealed offers in `~/.certo/calls/` (override
  `CERTO_STATE_DIR`) so `dispute`/`panel`/`claim-*` work across commands.
- **Panel.** `POST /cases` requires status `Answered`, checks both evidence
  hashes and the commitment, gets the three bodies from the contract view
  `build_panel_request` and refuses if they differ from core's. With
  `seller_offer_bps ≥ buyer_offer_bps` it submits `resolve` with three
  placeholder ballots (settlement shortcut; the contract ignores them). It
  verifies each ballot offline against `get_jurors()` before submitting and
  does not submit without a 2-of-3 majority. Replay misses return HTTP 424
  with the message from 4.4. `RecordingJurors(live, dir)` is the recorder for
  `make record`. `startPanelFromEnv` reads `RESOLVER_ACCOUNT`,
  `RESOLVER_PRIVATE_KEY`, `PANEL_MODE`, `NEARAI_API_KEY`, `PANEL_PORT` (4021),
  `PANEL_FIXTURES_DIR` (default `fixtures/panel`).
- **MCP.** Tools `certo_call`, `certo_dispute` (`kind`: content, error,
  non_delivery), `certo_status` (call and/or seller lookup; this is the
  spec's `certo_seller`). Env: as the CLI plus `PANEL_URL`.

## Not done / not verified

- `NearCertoChain` signed calls are tested against a local sandbox
  (`tests/e2e/sandbox.test.ts`, `packages/mcp/test/sandbox.test.ts`) and ran
  on testnet on 2026-11-13 (README section 7); no automated test runs on testnet.
- Self-service `certo resolve <call_id>` (buyer or seller running the panel
  with their own key after 60 s) is not in the CLI; use `PanelService`
  directly.
- Live NEAR AI calls are tested only against a mock server; the real
  signature encoding is checked on the 375 recorded ballots in
  `fixtures/panel/` (`make verify`).
