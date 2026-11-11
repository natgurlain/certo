import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chainFromEnv } from '@certo/core';
import { CertoClient } from '@certo/buyer';
import { createMcpServer } from './server.js';

/** stdio entry point; configuration from env (NEAR_RPC_URL, CERTO_CONTRACT, CERTO_TOKEN, BUYER_ACCOUNT, BUYER_PRIVATE_KEY, PANEL_URL). */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const accountId = env.BUYER_ACCOUNT;
  const privateKey = env.BUYER_PRIVATE_KEY;
  const chain = chainFromEnv(env, accountId && privateKey ? { accountId, privateKey } : undefined);
  const server = createMcpServer({ client: new CertoClient({ chain }), panelUrl: env.PANEL_URL });
  await server.connect(new StdioServerTransport());
}
