/**
 * Demo seller: an Express app behind `protect()` from `@certo/seller` that
 * serves fixed fixture bodies byte for byte (so the panel prompts, and hence
 * the recordings, are identical in every run), plus its answer bot.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { createAnswerBot, protect, type ProtectMiddleware } from '@certo/seller';
import type { Ed25519Key, CertoChain } from '@certo/core';

export type Behaviour = 'fixture' | 'error503';

export interface DemoSellerOptions {
  id: string;
  /** Signing chain client of this seller (views for the middleware; `answer`/`cure` for the bot). */
  chain: CertoChain;
  receiptKey: Ed25519Key;
  termsId: string;
  price: string;
  /** path-with-query → exact response body. */
  responses: Record<string, string>;
  behaviour?: Behaviour;
  /** Offer the answer bot states in content disputes (bps). */
  offerBps?: number;
  onBot?: Parameters<typeof createAnswerBot>[0]['onAction'];
  /** Answer-bot polling interval (default 400 ms; the testnet run uses a slower one to spare the public RPC). */
  botPollMs?: number;
}

export interface DemoSeller {
  id: string;
  url: string;
  mw: ProtectMiddleware;
  behaviour: Behaviour;
  /** Stop the HTTP server and the bot, dropping open connections ("the process died"). */
  kill(): Promise<void>;
  alive: boolean;
}

export async function startDemoSeller(o: DemoSellerOptions): Promise<DemoSeller> {
  const mw = protect({ contract: o.chain, seller: o.id, termsId: o.termsId, price: o.price, receiptKey: o.receiptKey });
  const app = express();
  const state = { behaviour: o.behaviour ?? 'fixture' };
  app.use(mw);
  app.all(/.*/, (req, res) => {
    if (state.behaviour === 'error503') {
      res.status(503).type('application/json').send('{"error":"upstream index unavailable"}');
      return;
    }
    const body = o.responses[req.originalUrl];
    if (body === undefined) {
      res.status(404).type('application/json').send('{"error":"unknown request"}');
      return;
    }
    res.status(200).type('application/json').send(body);
  });
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const bot = createAnswerBot({ chain: o.chain, store: mw.store, offerBps: o.offerBps ?? 0, onAction: o.onBot });
  bot.start(o.botPollMs ?? 400);
  const seller: DemoSeller = {
    id: o.id,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    mw,
    get behaviour() { return state.behaviour; },
    set behaviour(b: Behaviour) { state.behaviour = b; },
    alive: true,
    async kill() {
      if (!seller.alive) return;
      seller.alive = false;
      bot.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  return seller;
}
