import express, { type Express } from 'express';
import { ContractError } from '@certo/core';
import { PanelMissError } from './jurors.js';
import { CaseError, type PanelService } from './service.js';

/** HTTP front of the panel service: `POST /cases`, `GET /health`. */
export function createPanelApp(service: PanelService, info: Record<string, unknown> = {}): Express {
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_req, res) => void res.json({ ok: true, ...info }));
  app.post('/cases', async (req, res) => {
    try {
      res.json(await service.handleCase(req.body));
    } catch (e) {
      const status = e instanceof CaseError ? e.status : e instanceof PanelMissError ? 424 : e instanceof ContractError ? 409 : 500;
      res.status(status).json({ error: (e as Error).message, code: e instanceof ContractError ? e.code : undefined });
    }
  });
  return app;
}
