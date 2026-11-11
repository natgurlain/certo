/**
 * `make playground`: after the demo scenes, the sandbox, both sellers (with
 * their answer bots), the panel service and a funded buyer stay up until
 * Ctrl-C. `playground.env` tells `certo --playground` and
 * `certo-mcp --playground` where they are; it is deleted on exit.
 */
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { defaultStateDir } from '@certo/buyer';

/** `CERTO_HOME`, default `~/.certo`. */
export const certoHome = (env: NodeJS.ProcessEnv = process.env) => env.CERTO_HOME || join(homedir(), '.certo');
export const playgroundEnvPath = (env: NodeJS.ProcessEnv = process.env) => join(certoHome(env), 'playground.env');

export interface PlaygroundInfo {
  rpcUrl: string;
  contract: string;
  token: string;
  buyer: string;
  buyerPrivateKey: string;
  panelUrl: string;
  /** Seller name → URL of its demo request. */
  exampleUrls: Record<string, string>;
}

/** The env file: exactly these keys, one `KEY=value` per line, values unquoted. */
export function playgroundEnv(p: PlaygroundInfo): string {
  const vars: Record<string, string> = {
    NEAR_NETWORK: 'sandbox',
    NEAR_RPC_URL: p.rpcUrl,
    CERTO_CONTRACT: p.contract,
    CERTO_TOKEN: p.token,
    BUYER_ACCOUNT: p.buyer,
    BUYER_PRIVATE_KEY: p.buyerPrivateKey,
    PANEL_URL: p.panelUrl,
    CERTO_EXAMPLE_URLS: Object.entries(p.exampleUrls).map(([name, url]) => `${name}=${url}`).join(','),
  };
  for (const [k, v] of Object.entries(vars)) {
    if (/[\s#"'\\]/.test(v)) throw new Error(`${k} would need quoting in playground.env: ${v}`);
  }
  return `# written by \`make playground\`; deleted when it stops (sandbox test key, worthless outside it)\n${
    Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n')}\n`;
}

/** Where `certo --playground` and `certo-mcp --playground` keep call records for this sandbox (next to the env file). */
export const playgroundStateDir = (p: Pick<PlaygroundInfo, 'contract'>, path = playgroundEnvPath()) =>
  defaultStateDir({ CERTO_HOME: dirname(path), NEAR_NETWORK: 'sandbox', CERTO_CONTRACT: p.contract });

/**
 * Write the env file (mode 600) and delete it when this process exits. Returns its path. The call records of
 * the sandbox's contract are cleared at both ends: a new sandbox has never seen the calls of an earlier one.
 */
export function writePlaygroundEnv(p: PlaygroundInfo, path = playgroundEnvPath()): string {
  const calls = playgroundStateDir(p, path);
  rmSync(calls, { recursive: true, force: true });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, playgroundEnv(p), { mode: 0o600 });
  process.once('exit', () => {
    if (existsSync(path)) unlinkSync(path);
    rmSync(calls, { recursive: true, force: true });
  });
  return path;
}

/** The block printed once the playground is ready. */
export function playgroundBanner(o: { pageUrl: string | null; envPath: string; exampleUrls: Record<string, string> }): string[] {
  const { cheapfacts, chainfacts } = o.exampleUrls;
  return [
    '',
    'PLAYGROUND READY: sandbox, sellers chainfacts and cheapfacts, panel and a funded buyer `agent` (10 USDC) stay up until Ctrl-C',
    ...(o.pageUrl ? [`  page (Replay button replays the scenes):  ${o.pageUrl}`] : []),
    `  env file (deleted on exit):  ${o.envPath}`,
    '  add to Claude Code:  claude mcp add certo -- npx certo-mcp --playground',
    '  then ask it:',
    `    1. "Use certo to buy the top 5 NEAR holders from ${cheapfacts}"`,
    '    2. "Is that answer about the token you asked for? If not, dispute it with certo and tell me the refund."',
    `    3. "Buy the same data from ${chainfacts} and check the seller was paid in the same transaction."`,
  ];
}
