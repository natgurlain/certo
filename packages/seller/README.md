# @certo/seller

You are paid in the buyer's own payment transaction (price minus a 1.0% fee). You lock a USDC bond; your open refund
risk can never exceed it. For each call the buyer has a refund window (120 s by default) to claim the price back from
the bond. A lost dispute costs the refund plus a ruling fee (max(0.02 USDC, 5% of the price)) and raises your fee one
tier (1.0% → 1.5% → 2.5% → 5%); clean volume brings it back down.

## Quickstart

```sh
# env: NEAR_RPC_URL, NEAR_NETWORK (sandbox or testnet), CERTO_CONTRACT, CERTO_TOKEN, SELLER_ACCOUNT, SELLER_PRIVATE_KEY
npx certo seller init --bond 50 --terms terms.txt [--price 0.40] [--terms-id v1] [--window 120] [--no-panel]
```

It generates your receipt key (`~/.certo/seller-<account>.receipt-key`, mode 0600), registers you (attaches the
contract's 1 NEAR registration deposit), publishes the terms (immutable; a change is a new terms id), deposits the bond,
and prints a filled-in `protect()` snippet. Re-running skips the steps already done. A full server is
[`examples/seller.ts`](../../examples/seller.ts).

## What to know

- `protect({ contract, seller, termsId, price, receiptKey })`: `price` is in base units ("400000" = 0.40 USDC); the
  refund window and fee are read from the chain at quote time. Mount it before any body parser.
- **State is in memory.** Served responses live in the process (`ServedStore`). A restart inside a refund window
  loses them: a non-delivery claim on a call served before the restart cannot be cured and is refunded with the
  ruling fee. Keep the process up while windows are open.
- **Size cap.** `protect()` does not sign a body over 6,144 bytes (`MAX_SIGNED_BODY`): the contract cannot judge
  larger evidence (`max_response` for the panel, 16 KiB for `cure`). The buyer gets a signed 500 instead, which
  refunds the price by rule and costs no ruling fee.
- **Answer bot.** `createAnswerBot({ chain, store: mw.store }).start(1000)` answers each content dispute with your
  offer (default 0%) and cures non-delivery claims with the stored signed response. A failed transaction is retried on
  the next tick; missing the answer deadline costs a full refund plus the ruling fee.
- The 402 tells stock x402 clients how to pay: `resource.description` names the `certo-bonded` scheme and
  `npx certo call <url>` / `certo-mcp`; `extra.docs` carries the repository URL.
