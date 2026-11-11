import { fileURLToPath } from 'node:url';
import { chainFromEnv } from '@makegood/core';
import { createPanelApp } from './app.js';
import { jurorsFromEnv } from './jurors.js';
import { PanelService } from './service.js';

/** Default replay fixtures directory: `<repo>/fixtures/panel`. */
export const DEFAULT_FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures/panel', import.meta.url));

/** Starts the panel service from environment variables (resolver key, mode, port). */
export async function startPanelFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const accountId = env.RESOLVER_ACCOUNT;
  const privateKey = env.RESOLVER_PRIVATE_KEY;
  if (!accountId || !privateKey) throw new Error('RESOLVER_ACCOUNT and RESOLVER_PRIVATE_KEY must be set');
  const chain = chainFromEnv(env, { accountId, privateKey });
  const jurors = jurorsFromEnv(env, env.PANEL_FIXTURES_DIR ?? DEFAULT_FIXTURES_DIR);
  const app = createPanelApp(new PanelService({ chain, jurors }), { mode: jurors.mode, resolver: accountId });
  const port = Number(env.PANEL_PORT ?? 4021);
  const server = app.listen(port);
  await new Promise((r) => server.once('listening', r));
  console.log(`panel service (${jurors.mode}) on http://localhost:${port}`);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await startPanelFromEnv();
