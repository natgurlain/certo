// A bonded paid endpoint. First run `npx certo seller init --bond 50 --terms terms.txt` (it prints these values).
// env: NEAR_RPC_URL, NEAR_NETWORK, CERTO_CONTRACT, CERTO_TOKEN, SELLER_ACCOUNT, SELLER_PRIVATE_KEY, RECEIPT_KEY_FILE
// run: npx tsx examples/seller.ts   (state is in memory: keep it running while refund windows are open)
import { readFileSync } from 'node:fs';
import express from 'express';
import { chainFromEnv, fromHex } from '@certo/core';
import { createAnswerBot, protect } from '@certo/seller';

const env = process.env;
const chain = chainFromEnv(env, { accountId: env.SELLER_ACCOUNT!, privateKey: env.SELLER_PRIVATE_KEY! });
const mw = protect({
  contract: chain, seller: env.SELLER_ACCOUNT!, termsId: env.TERMS_ID ?? 'v1', price: env.PRICE ?? '400000', // base units: 0.40 USDC
  receiptKey: fromHex(readFileSync(env.RECEIPT_KEY_FILE!, 'utf8').trim()),
});
const app = express();
app.get('/v1/answer', mw, (_req, res) => void res.json({ answer: 42 }));
app.listen(Number(env.PORT ?? 8080), () => console.log(`bonded endpoint on :${env.PORT ?? 8080}/v1/answer`));
createAnswerBot({ chain, store: mw.store }).start(1000); // answers content disputes (offer 0%), cures non-delivery claims
