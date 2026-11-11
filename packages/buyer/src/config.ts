import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chainFromEnv, CLI_NAME, type NearCertoChain } from '@certo/core';
import { certoHome } from './store.js';

/** A configuration problem, reported as one line without a stack trace. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const NO_PLAYGROUND = 'no playground running: start one with `make playground` in the certo repo';

/** `$CERTO_HOME/playground.env`, else `~/.certo/playground.env` (written by `make playground`). */
export function playgroundFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(certoHome(env), 'playground.env');
}

/** Parse `KEY=VALUE` lines (`#` comments, optional quotes). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** The playground's settings under `env` (values already in `env` win). Throws `ConfigError` if none is running. */
export function withPlayground(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  let text: string;
  try {
    text = readFileSync(playgroundFile(env), 'utf8');
  } catch {
    throw new ConfigError(NO_PLAYGROUND);
  }
  return { ...parseEnvFile(text), ...env };
}

const REQUIRED = ['CERTO_CONTRACT', 'CERTO_TOKEN', 'BUYER_ACCOUNT', 'BUYER_PRIVATE_KEY'] as const;

/** Signing buyer chain from env, or a `ConfigError` naming what to set. */
export function buyerChainFromEnv(env: NodeJS.ProcessEnv): NearCertoChain {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (missing.length) {
    throw new ConfigError(`${CLI_NAME}: set ${missing.join(', ')} (and NEAR_RPC_URL, NEAR_NETWORK), or add --playground to use a sandbox started with \`make playground\``);
  }
  try {
    return chainFromEnv(env, { accountId: env.BUYER_ACCOUNT!, privateKey: env.BUYER_PRIVATE_KEY! });
  } catch (e) {
    throw new ConfigError(`${CLI_NAME}: bad configuration: ${(e as Error).message}`);
  }
}

/** `--playground` anywhere in argv: removed, and the playground file merged under env. */
export function resolveArgs(argv: string[], env: NodeJS.ProcessEnv): { argv: string[]; env: NodeJS.ProcessEnv; playground: boolean } {
  const playground = argv.includes('--playground');
  return { argv: argv.filter((a) => a !== '--playground'), env: playground ? withPlayground(env) : env, playground };
}

/** `CERTO_EXAMPLE_URLS` (`name=url,name=url`) as pairs. */
export function exampleUrls(env: NodeJS.ProcessEnv): Array<{ name: string; url: string }> {
  return (env.CERTO_EXAMPLE_URLS ?? '').split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return i > 0 ? { name: p.slice(0, i), url: p.slice(i + 1) } : { name: p, url: p };
  });
}
