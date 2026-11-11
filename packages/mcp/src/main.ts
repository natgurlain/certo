import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chainFromEnv } from '@makegood/core';
import { MakegoodClient } from '@makegood/buyer';
import { createMcpServer } from './server.js';

/** stdio entry point; configuration from env (NEAR_RPC_URL, MAKEGOOD_CONTRACT, MAKEGOOD_TOKEN, BUYER_ACCOUNT, BUYER_PRIVATE_KEY, PANEL_URL). */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const accountId = env.BUYER_ACCOUNT;
  const privateKey = env.BUYER_PRIVATE_KEY;
  const chain = chainFromEnv(env, accountId && privateKey ? { accountId, privateKey } : undefined);
  const server = createMcpServer({ client: new MakegoodClient({ chain }), panelUrl: env.PANEL_URL });
  await server.connect(new StdioServerTransport());
}
