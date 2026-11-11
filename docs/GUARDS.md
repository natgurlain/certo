# Guard tests: `make guards`

Each guard of [DESIGN.md 4.8](DESIGN.md) is one check in the contract. `make guards`
(`npx tsx tests/guards/run.ts`) shows that each check is what stops its attack:

1. It starts one local NEAR sandbox (nearcore 2.10.0) and, for every guard G1–G8, deploys two
   fresh markets: one with the committed contract `res/certo.wasm`, one with
   `res/guards/certo_no_gN.wasm`, the same source built with only that check compiled out
   (`--features no_gN`, see `./scripts/build-contracts.sh`; hashes in `res/SHA256SUMS`).
2. It runs the same attack against both, through the TypeScript chain client.
3. A row passes only if the real contract rejects the attack with the named error **and** the
   attack goes through on the weakened build (the "attack succeeded" column says what it achieved).
   Any other result prints `WRONG` and the command exits 1.

No Rust toolchain is needed. G9–G15 have no weakened build; they are covered by
`cargo test -p certo --test guards` (`docs/CONTRACT_NOTES.md`).

| # | Guard | Attack |
|---|---|---|
| G1 | Juror signature | Seller-favouring panel; one byte of juror 0's answer changed (Y → X), signature kept |
| G2 | Exposure limit | Bond 1.00; pay 0.40 twice, then a third time |
| G3 | One dispute per call | Second non-delivery claim on the same call |
| G4 | Window | Dispute 1 s after the 60 s window (sandbox clock fast-forwarded) |
| G5 | Receipt signature | Content dispute with a receipt over an invented body, signed by another key |
| G6 | Bond withdrawal | Bond 1.00, one open call (reserve 0.42); withdraw 0.580001 |
| G7 | Evidence binding | Resolver submits another response body than the receipt commits to, with ballots for it |
| G8 | Prompt binding | Real signatures for a prompt with an added "NOTE TO ARBITERS" line, plus the weakened build's `request_hash` hint |

Juror keys in this test are generated test keys; the attacks do not depend on NEAR AI.

## Output

Recorded on 2026-11-11 against `res/certo.wasm` SHA-256 `9e8118ad…` (55.2 s, macOS arm64 under load, nearcore 2.10.0 sandbox; at most three guard pairs run at once):

```text
guard  check                 real contract (res/certo.wasm)  guard removed (res/guards/certo_no_gN.wasm)                                    verdict
-----  --------------------  ------------------------------  -----------------------------------------------------------------------------  --------------------------------
G1     juror signature       rejected E_BALLOT_SIG           attack succeeded: forged vote counted, winner buyer                            rejected / succeeds-when-removed
G2     exposure limit        rejected E_EXPOSURE             attack succeeded: third payment taken: reserved 1.260000 > bond 1.000000       rejected / succeeds-when-removed
G3     one dispute per call  rejected E_STATUS               attack succeeded: stake taken twice (0.020000 more)                            rejected / succeeds-when-removed
G4     dispute window        rejected E_WINDOW_CLOSED        attack succeeded: dispute opened after the window (status NonDeliveryClaimed)  rejected / succeeds-when-removed
G5     receipt signature     rejected E_BAD_RECEIPT_SIG      attack succeeded: dispute opened on invented evidence (status Disputed)        rejected / succeeds-when-removed
G6     bond withdrawal       rejected E_WITHDRAW_EXPOSED     attack succeeded: bond 0.419999 < reserved 0.420000                            rejected / succeeds-when-removed
G7     evidence binding      rejected E_EVIDENCE_HASH        attack succeeded: panel ruled on substituted evidence, winner buyer            rejected / succeeds-when-removed
G8     prompt binding        rejected E_BALLOT_SIG           attack succeeded: ballots for another prompt accepted, winner buyer            rejected / succeeds-when-removed

GUARDS OK: 8/8 guards rejected on the real contract and bypassed when removed (55.2 s)
```

Run a subset with `npx tsx tests/guards/run.ts --only G1,G4`.
