// A bonded paid endpoint. First run `npx certo seller init --bond 50 --terms terms.txt` (it prints these values).
// env: NEAR_RPC_URL, NEAR_NETWORK, CERTO_CONTRACT, CERTO_TOKEN, SELLER_ACCOUNT, RECEIPT_KEY_FILE, BOT_KEY_FILE
// run: npx tsx examples/seller.ts   (state is in memory: keep it running while refund windows are open)
import { readFileSync } from 'node:fs';
import express from 'express';
import { chainFromEnv, fromHex } from '@certo/core';
import { createAnswerBot, protect } from '@certo/seller';

const env = process.env;
const read = (f: string) => readFileSync(f, 'utf8').trim();
const chain = chainFromEnv(env); // views only: protect() needs no account key
const bot = chainFromEnv(env, { accountId: env.SELLER_ACCOUNT!, privateKey: read(env.BOT_KEY_FILE!) }); // may call only answer and cure
const mw = protect({ contract: chain, seller: env.SELLER_ACCOUNT!, termsId: 'v1', price: '400000', receiptKey: fromHex(read(env.RECEIPT_KEY_FILE!)) }); // 0.40 USDC
const app = express();
app.get('/v1/answer', mw, (_req, res) => void res.json({ answer: 42 }));
app.listen(8080, () => console.log('bonded endpoint on http://localhost:8080/v1/answer'));
createAnswerBot({ chain: bot, store: mw.store }).start(1000); // answers content disputes (offer 0%), cures non-delivery claims
