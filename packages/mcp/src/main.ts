import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { parseAmountInput } from '@certo/core';
import { CertoClient, buyerChainFromEnv, ConfigError, defaultStateDir, exampleUrls, FileCallStore, resolveArgs } from '@certo/buyer';
import { createMcpServer } from './server.js';

function setup(argv: string[], env0: NodeJS.ProcessEnv) {
  const { env } = resolveArgs(argv, env0);
  const chain = buyerChainFromEnv(env);
  if (env.CERTO_MAX_PRICE !== undefined) {
    try {
      parseAmountInput(env.CERTO_MAX_PRICE);
    } catch (e) {
      throw new ConfigError(`certo-mcp: CERTO_MAX_PRICE: ${(e as Error).message}`);
    }
  }
  const client = new CertoClient({ chain, maxPrice: env.CERTO_MAX_PRICE, store: new FileCallStore(defaultStateDir(env)) });
  return createMcpServer({ client, panelUrl: env.PANEL_URL, examples: exampleUrls(env) });
}

/**
 * stdio entry point: `certo-mcp [--playground]`. Configuration from env (NEAR_RPC_URL, NEAR_NETWORK, CERTO_CONTRACT,
 * CERTO_TOKEN, BUYER_ACCOUNT, BUYER_PRIVATE_KEY, PANEL_URL, CERTO_MAX_PRICE, CERTO_STATE_DIR, CERTO_EXAMPLE_URLS);
 * `--playground` fills what is missing from the file `make playground` writes. A configuration problem prints one
 * line to stderr and exits 2 before the MCP handshake.
 */
export async function main(argv = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let server;
  try {
    server = setup(argv, env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(e.message);
    process.exitCode = 2;
    return;
  }
  await server.connect(new StdioServerTransport());
}
