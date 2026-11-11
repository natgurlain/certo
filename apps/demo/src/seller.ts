/**
 * Demo seller: an Express app behind `protect()` from `@certo/seller` that
 * serves fixed fixture bodies byte for byte (so the panel prompts, and hence
 * the recordings, are identical in every run), plus its answer bot.
 */
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { createAnswerBot, protect, type ProtectMiddleware } from '@certo/seller';
import { decodeHeader, HDR_PAYMENT_SIGNATURE, type Ed25519Key, type CertoChain, type PaymentSignature } from '@certo/core';

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
  /** HTTP port (default: any free port; a taken port also falls back to a free one). */
  port?: number;
  /** Called for each paid request the seller answers (after `protect()` checked the payment on chain). */
  onPaid?: (served: { callId: string; status: number; body: string }) => void;
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
  // sell only what can be served: an unknown request gets a plain 404 before any 402, so nobody pays for it
  app.use((req, res, next) => {
    if (o.responses[req.originalUrl] !== undefined) return next();
    res.status(404).type('application/json').send(JSON.stringify({
      error: 'not sold here, nothing charged: this demo seller answers only the requests listed in "sold"', sold: Object.keys(o.responses),
    }));
  });
  app.use(mw);
  app.all(/.*/, (req, res) => {
    const [status, body] = state.behaviour === 'error503' ? [503, '{"error":"upstream index unavailable"}'] : [200, o.responses[req.originalUrl]!];
    res.status(status).type('application/json').send(body);
    const callId = decodeHeader<PaymentSignature>(req.get(HDR_PAYMENT_SIGNATURE)!).payload.callId;
    o.onPaid?.({ callId, status, body });
  });
  const listen = (port: number) => new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  const server: Server = await listen(o.port ?? 0).catch(() => listen(0));
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
