# `make verify`: offline check of recorded ballots and juror attestations

`make verify` runs `npx tsx scripts/verify-recorded.ts`. It needs Node only: no chain,
no API key, no network. It passes with the line

```
VERIFY OK: N ballots (R real, S synthetic)
```

and exits 1 with a list of problems otherwise.

## What it checks

**Attestation (`fixtures/jurors.json` against `fixtures/attestations/<date>/*.json`)**

1. Each saved report's SHA-256 (over the raw bytes as received) equals `report_sha256`.
2. The report has exactly one model attestation, for the right model, with
   `signing_algo` `ed25519`, and its `request_nonce` and the NVIDIA payload nonce equal
   the nonce we sent (stored as `nonce`).
3. The ed25519 public key in the report equals `public_key` in `jurors.json`.
4. **Binding:** in the Intel TDX quote of the model and of the gateway, REPORTDATA
   (64 bytes) is `public key (32) ‖ nonce (32)`, and the quote's MRTD equals the one in
   `info.tcb_info`. So the key was put into the quote by code inside that TD, after our
   nonce existed.
5. Reports of earlier epochs (`previous_epochs`) are still present with their hashes.

**Ballots (`fixtures/panel/*.json`, one file per ballot, DESIGN 4.4)**

1. The file name is `sha256(request_body)`; `request_body` names the recording's model,
   which is one of the three jurors.
2. The signed text is rebuilt from `sha256(request_body)` and `sha256(decoded response
   bytes)`: `<model>:<req>:<resp>` for `provider_tee`, `<req>:<resp>` for `gateway`.
3. The ed25519 signature verifies under the registered key: the model's key for
   `provider_tee`, the gateway key for `gateway`, from the current or an earlier epoch.
4. **Synthetic ballots** (`synthetic: true`, made by `makeSyntheticBallot` in
   `@makegood/core`) verify only under the deterministic test keys derived from the
   published seed, and are counted as synthetic. A ballot signed with a test key but not
   marked synthetic fails. Synthetic ballots prove nothing about NEAR AI.
5. The vote (`parseVote`, same rule as the contract) is tallied per model.

## What it does not check

- The TDX quote's own ECDSA signature, the PCK certificate chain to Intel's root, TCB
  status and collateral; the NVIDIA GPU evidence and its certificate chain; replay of
  the event log into the RTMRs; that the compose hash describes the expected image.
  Without these, the binding check shows "a quote with this key and our nonce", and
  trusting that the quote is genuine is an assumption. Full verification is STRETCH
  (for example NEAR's `nearai-cloud-verification-example`, or Intel DCAP tooling).
- That a juror was asked only once (DESIGN 4.4, re-asking).
- That the panel ruled correctly; only that the recorded answers are the jurors' signed answers.

## Files

`fixtures/jurors.json` (written by `npx tsx scripts/fetch-attestations.ts`):

```
{ version, epoch, fetched_at, source, signing_algo: "ed25519", binding_check,
  gateway: { public_key, report_path, report_pointer: "/gateway_attestation", report_sha256, nonce, binding_ok },
  jurors: [ { index, model, buyer_letter, public_key, report_path, report_sha256, report_bytes, nonce, binding_ok, fetch_ms } ×3 ],
  previous_epochs: [ { epoch, fetched_at, gateway_public_key, jurors: [ { model, public_key, report_path, report_sha256 } ] } ] }
```

Keys are 64-char lower-case hex. The epoch increases when a refetch returns a different
key; old keys stay in `previous_epochs` so older recordings still verify. The contract's
`set_jurors` takes `model`, `public_key`, `report_sha256` and `epoch` from this file.

Recordings: `{model, request_body, response_body_b64, chat_id, signature: {text,
signature, signing_address, signing_algo, signature_kind}, latency_ms, recorded_at,
synthetic?}` (`PanelRecording` in `@makegood/core`). Written by `scripts/probe.ts`,
`scripts/killtest.ts` and `scripts/record.ts` (`--synthetic` for test-key ballots). A real
recording is never replaced by a synthetic one.

## Tamper check (T17 acceptance)

Run on 2026-11-10 against a copy of `fixtures/` holding the real attestation reports and
9 synthetic ballots (`record.ts --synthetic --ids B1-03,G2-01,G4-04`), then one change each:

| Change | Result |
|---|---|
| none | `VERIFY OK: 9 ballots (0 real, 9 synthetic)`, exit 0 |
| one byte of a ballot's answer flipped (`Y` → `X` inside the response bytes) | `FAILS: signed text does not match the hashes`, exit 1 |
| one hex digit of a ballot's signature changed | `FAILS: bad ed25519 signature`, exit 1 |
| `synthetic: true` changed to `false` | `FAILS: signed by a synthetic test key but not marked synthetic`, exit 1 |
| one byte of an attestation report flipped | `report SHA-256 differs from jurors.json`, exit 1 |

The same answer-byte flip on a ballot from the mock panel (registered key, `provider_tee`)
fails the same way. Reproduce with `--root <copy of fixtures>`:

```
cp -R fixtures /tmp/f && npx tsx scripts/record.ts --synthetic --ids B1-03 --out /tmp/f/panel
npx tsx scripts/verify-recorded.ts --root /tmp/f          # OK
# edit one byte in /tmp/f/panel/*.json or /tmp/f/attestations/*/*.json, rerun → VERIFY FAILED
```
