# Testnet run: `make testnet-demo`

`make testnet-demo` runs the four scenes of `make demo` on NEAR testnet instead of the local
sandbox. Before the scenes it deploys and sets up the market if needed (the same code as
`scripts/deploy-testnet.ts`; every step is skipped when it is already done). This page is the
procedure for the human who owns the accounts. Nothing in the repository creates accounts or
holds keys; keys live only in `.env` (git-ignored).

Status on 2026-11-13: deployed and run. `make testnet-demo` ended `DEMO OK: 4/4 scenes, 3/3 juror
signatures verified on chain` with the final contract; the transactions are listed in the README
(section "Testnet"). Two fixes came out of the first runs: transactions now wait for finality on
public networks (testnet RPC endpoints are load-balanced, so a read right after an optimistic
execution can miss it), and reads retry a rate-limit refusal or a dropped connection. The sellers'
answer bots poll every 4 s on testnet (fastnear's free tier rate-limits faster polling). The faucet
gave 10 NEAR per new account; a second faucet account topped `certo.testnet` up.

## What runs where

| Item | Value |
|---|---|
| RPC | `NEAR_RPC_URL`, default `https://rpc.testnet.fastnear.com` |
| Explorer links in the output | `NEAR_EXPLORER_URL` + `/txns/<hash>`, default `https://testnet.nearblocks.io` |
| Contract | `res/certo.wasm` on `CERTO_CONTRACT`; owner `CERTO_OWNER`, resolver `RESOLVER_ACCOUNT` |
| Token | `res/mock_usdc.wasm` (mock USDC, 6 decimals, open `mint`) on `CERTO_TOKEN` |
| Contract settings | as `make demo`, except the seller's answer/cure window: **30 s** (`answer_ms` 30000; 5 s in `make demo`). Dispute window 120 s, resolver slot 60 s, panel deadline 300 s |
| Sellers | `chainfacts`, `cheapfacts` registered with the demo terms `holders-v1`; bond topped up to 50.000000 before each run. Their receipt keys are derived from each seller's NEAR secret key (not published) |
| Buyers | `scout`, `scout-liar`; balance topped up to 10.000000 mock USDC before each run |
| HTTP | The two demo sellers and the panel service run on this machine (127.0.0.1), as in `make demo` |
| Juror keys on the contract | `fixtures/jurors.json` (NEAR AI keys) by default; the published TEST keys only with `TESTNET_JURORS=synthetic` |

## Step 1: tools

- Node ≥ 20 and `npm ci` (as for `make demo`).
- A NEAR CLI to create accounts. The commands below are for `near-cli` 4.x (JavaScript;
  `npm i -g near-cli`), which saves each new key to `~/.near-credentials/testnet/<account>.json`.
  Any other wallet or CLI works if you end up with each account's `ed25519:…` secret key.

## Step 2: accounts (DESIGN 7.1, H4)

Funding needed per account (the dry run in step 4 checks these minimums):

| Account | Env variable | Minimum | Why |
|---|---|---|---|
| `certo.testnet` | `CERTO_OWNER` | 0.1 NEAR left after funding the others | contract owner; parent of the others |
| `v1.certo.testnet` | `CERTO_CONTRACT` | 5 NEAR | code storage of a 354 KB wasm (~3.5 NEAR) plus state |
| `usdc.certo.testnet` | `CERTO_TOKEN` | 2 NEAR | code storage of a 167 KB wasm (~1.7 NEAR) plus balances |
| `resolver.certo.testnet` | `RESOLVER_ACCOUNT` | 0.5 NEAR | gas for `resolve` |
| `sellers.certo.testnet` | (none) | 0.1 NEAR left | parent of the seller accounts only |
| `chainfacts.sellers.certo.testnet` | `SELLER_CHAINFACTS_ACCOUNT` | 1.5 NEAR | 1 NEAR registration deposit, gas |
| `cheapfacts.sellers.certo.testnet` | `SELLER_CHEAPFACTS_ACCOUNT` | 1.5 NEAR | as above |
| `scout.certo.testnet` | `BUYER_SCOUT_ACCOUNT` | 0.5 NEAR | gas |
| `scout-liar.certo.testnet` | `BUYER_SCOUT_LIAR_ACCOUNT` | 0.5 NEAR | gas |

Total about 13 NEAR. How much the faucet gives a new account is not verified here; check with
`near state certo.testnet` after the first command and top up from https://near-faucet.io
(HACKATHON.md Q-008) if it is below 13.5 NEAR.

```sh
near create-account certo.testnet --useFaucet
near state certo.testnet                      # need ≥ 13.5 NEAR before the next commands

near create-account v1.certo.testnet        --masterAccount certo.testnet --initialBalance 5.5
near create-account usdc.certo.testnet      --masterAccount certo.testnet --initialBalance 2.5
near create-account resolver.certo.testnet  --masterAccount certo.testnet --initialBalance 0.6
near create-account scout.certo.testnet     --masterAccount certo.testnet --initialBalance 0.6
near create-account scout-liar.certo.testnet --masterAccount certo.testnet --initialBalance 0.6
near create-account sellers.certo.testnet   --masterAccount certo.testnet --initialBalance 3.4
near create-account chainfacts.sellers.certo.testnet --masterAccount sellers.certo.testnet --initialBalance 1.6
near create-account cheapfacts.sellers.certo.testnet --masterAccount sellers.certo.testnet --initialBalance 1.6
```

If a name is taken, choose others and put them in `.env`; any `.testnet` names work.

## Step 3: keys into `.env`

This writes `.env` from `.env.example` with the eight keys filled in, without printing any key.
Run it from the repository root; it overwrites an existing `.env`, so copy `NEARAI_API_KEY` back
in afterwards if you had one.

```sh
grep -v '_PRIVATE_KEY=' .env.example > .env
for pair in \
  CERTO_OWNER_PRIVATE_KEY:certo.testnet \
  CERTO_CONTRACT_PRIVATE_KEY:v1.certo.testnet \
  CERTO_TOKEN_PRIVATE_KEY:usdc.certo.testnet \
  RESOLVER_PRIVATE_KEY:resolver.certo.testnet \
  SELLER_CHAINFACTS_PRIVATE_KEY:chainfacts.sellers.certo.testnet \
  SELLER_CHEAPFACTS_PRIVATE_KEY:cheapfacts.sellers.certo.testnet \
  BUYER_SCOUT_PRIVATE_KEY:scout.certo.testnet \
  BUYER_SCOUT_LIAR_PRIVATE_KEY:scout-liar.certo.testnet; do
  echo "${pair%%:*}=$(node -p "require(process.env.HOME + '/.near-credentials/testnet/${pair#*:}.json').private_key")" >> .env
done
chmod 600 .env
```

`CERTO_OWNER_PRIVATE_KEY` is optional; it is used only when the juror keys on an existing
contract must change (`set_jurors`). Keep it set if you plan to switch from synthetic to real keys.
If you changed account names in step 2, edit the `*_ACCOUNT` / `CERTO_*` lines too.

## Step 4: dry run (sends nothing)

```sh
npx tsx scripts/deploy-testnet.ts --dry-run
```

It validates `.env` (account-id syntax, `.testnet` suffix, distinct accounts, `ed25519:` +
base58 keys of 64 bytes whose public half matches), refuses a mainnet RPC, and sends one
read-only `view_account` query per account: exists, balance against the minimum, and for the
contract and token accounts whether they hold no code, this repository's wasm, or other code.
It prints each key's public key prefix, never the secret. Exit 0 when ready, 2 otherwise.
`NEAR_NETWORK=testnet npx tsx apps/demo/run.ts --dry-run` does the same.

Expected when ready:

```text
DRY RUN OK: configuration complete, all accounts exist and are funded; `make testnet-demo` will deploy (if needed) and run the scenes
```

Output today, with no `.env` and no accounts (run 2026-11-11):

```text
no .env file at the repository root; settings from the environment only (cp .env.example .env)
dry run: no transactions are sent; read-only view_account queries to https://rpc.testnet.fastnear.com
role                       account                              key                 on chain
-------------------------  -----------------------------------  ------------------  ---------------------------------------------------
CERTO_OWNER             certo.testnet                     not set (optional)  UNKNOWN_ACCOUNT (create it, docs/TESTNET.md step 2)
CERTO_CONTRACT          v1.certo.testnet                  MISSING             UNKNOWN_ACCOUNT (create it, docs/TESTNET.md step 2)
…
CONFIG: CERTO_CONTRACT_PRIVATE_KEY is empty (key of v1.certo.testnet, certo contract (code storage ~3.5 NEAR))
…
RPC https://rpc.testnet.fastnear.com: reachable
DRY RUN NOT READY: 7 configuration problem(s), 8 account problem(s) (see docs/TESTNET.md)
```

## Step 5: choose the juror keys, then run

The contract verifies each juror signature against the keys it holds, so the keys on the
contract must match the panel answers the run submits. Three choices:

| Panel answers | Needs | Command |
|---|---|---|
| **Live** NEAR AI calls during the run (the run DESIGN S1 asks for) | `NEARAI_API_KEY` in `.env`; current keys in `fixtures/jurors.json` (refresh: `npx tsx scripts/fetch-attestations.ts`) | `PANEL_MODE=live make testnet-demo` |
| **Replay of real recordings** | `make record` run first, so `fixtures/panel/` holds real ballots | `make testnet-demo` |
| **Synthetic** (today's `fixtures/panel/`) | nothing; deploys the published TEST keys, prints a warning banner; anyone can sign rulings on that contract | `TESTNET_JURORS=synthetic make testnet-demo` |

The order that gives the strongest README claim: key in `.env` → `make probe` → `make killtest`
→ `make record` → `PANEL_MODE=live make testnet-demo`. Juror keys can be changed later on the
same contract with `CERTO_OWNER_PRIVATE_KEY` set (the run calls `set_jurors`; epoch + 1).
`accept_gateway` is fixed at the first deployment: the runner sets it to true for live mode and for
replays that contain gateway signatures; `scripts/deploy-testnet.ts --accept-gateway` sets it when
deploying by hand. To change it, deploy to a fresh contract account (`CERTO_CONTRACT=v2.certo.testnet`).

Deploying without the scenes: `npx tsx scripts/deploy-testnet.ts` (real keys) or
`npx tsx scripts/deploy-testnet.ts --jurors synthetic`; it ends with `DEPLOY OK: …`.

## Step 6: what the output looks like

First the setup, one line per transaction with its explorer link (skipped steps say
"already deployed" / "registered"):

```text
token usdc.certo.testnet: deploying res/mock_usdc.wasm and calling new
  deploy token: https://testnet.nearblocks.io/txns/<hash>
contract v1.certo.testnet: deploying res/certo.wasm and calling new
  deploy contract: https://testnet.nearblocks.io/txns/<hash>
  register_seller chainfacts: https://testnet.nearblocks.io/txns/<hash>
  …
buyer scout-liar scout-liar.certo.testnet: 10.000000 mock USDC
```

Then the same numbered transcript as `make demo`, with explorer links in place of short hashes,
the four scene lines, a list of every transaction of the run, and the final line:

```text
Scene 1 honest call: scout paid chainfacts 0.400000, fee 0.004000 (1.0%), seller balance +0.396000 in the paying transaction https://testnet.nearblocks.io/txns/<hash>
Scene 2 asked NEAR, got NEO: content dispute, votes buyer/buyer/buyer, 3 signatures verified by contract, refund 0.400000, bond 50.000000 → 49.580000, fee 1.0% → 1.5%
Scene 3 lying buyer: scout-liar disputed correct data, votes seller/seller/seller, buyer stake 0.020000 forfeited; chainfacts bond 50.000000 unchanged, fee stays 1.0%
Scene 4 seller dead: seller did not answer in 30 s (testnet setting), refund 0.400000 by rule, no panel, bond 49.580000 → 49.160000, fee 1.5% → 2.5% (loss recorded)
testnet transactions of this run (14):
  scout      ft_transfer_call(pay)      https://testnet.nearblocks.io/txns/<hash>
  …
DEMO OK: 4/4 scenes, 3/3 juror signatures verified on chain
```

With synthetic keys the scene 2 line and the final line end in `(synthetic test keys)`.
The page at http://localhost:4020 shows "Chain: NEAR testnet" (`make testnet-demo` does not pass
`--keep-open`; use `NEAR_NETWORK=testnet npx tsx apps/demo/run.ts --keep-open` to keep it up).

On a second run on the same accounts the numbers differ where the contract keeps history, and
the runner checks the step instead of the absolute value: `cheapfacts` starts in a higher fee
tier (2.5% → 5.0%, then capped at 5.0%), and `scout-liar`'s stake doubles after each lost
dispute (0.040000, 0.080000, …). Bonds and buyer balances are topped up, so the bond figures repeat.
For README numbers, use the first run on fresh accounts.

How long a run takes on testnet has not been measured; scene 4 alone waits the 30 s answer window.

## Errors and what to do

| Message | Fix |
|---|---|
| `CONFIG: … is empty` / `… must start with "ed25519:"` | Step 3 |
| `UNKNOWN_ACCOUNT` | Step 2 |
| `… (LOW: needs ≥ N NEAR)` | send NEAR to that account (`near send-near certo.testnet <account> 1`) |
| `… is not an access key of …` | the key in `.env` belongs to another account |
| `fixtures/panel holds SYNTHETIC ballots …` | step 5: record real ballots, or `TESTNET_JURORS=synthetic` |
| `the juror keys on … are not the … set` | set `CERTO_OWNER_PRIVATE_KEY`, or use a fresh contract account |
| `… already holds other code` | the account has another contract; use a fresh account name. The script never upgrades a deployed contract |
| `… was initialised with another owner/token/resolver` | use a fresh contract account |
| `… is registered with another receipt key` | the seller's NEAR key changed since registration; use a fresh seller account |
| HTTP 429 from the RPC | set `NEAR_RPC_URL` to another testnet provider (https://docs.near.org/api/rpc/providers) |

## Step 7: fill README section 8

After a run that ends in `DEMO OK`, replace the `<!-- FILL: … -->` markers in README section 8:

1. The account table: the names you used.
2. Contract and token: `https://testnet.nearblocks.io/address/<account>` (open one link to check
   the explorer URL pattern).
3. The deploy transaction links from the setup output (first run).
4. One link per scene from the scene lines and the transaction list: scene 1 the `pay` transaction,
   scenes 2 and 3 the `resolve` transaction, scene 4 the `resolve_default` transaction.
5. The panel mode of the run (live / replay / synthetic) and the date, and paste the four scene
   lines and the final `DEMO OK` line verbatim.
6. If the panel mode was synthetic, keep the sentence that says so.
