import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultStateDir, withPlayground } from '@certo/buyer';
import { playgroundEnv, playgroundEnvPath, playgroundStateDir, writePlaygroundEnv, type PlaygroundInfo } from '../src/playground.js';

const info: PlaygroundInfo = {
  rpcUrl: 'http://127.0.0.1:3030', contract: 'certo', token: 'usdc', buyer: 'agent', buyerPrivateKey: 'ed25519:abc',
  panelUrl: 'http://127.0.0.1:5000',
  exampleUrls: { chainfacts: 'http://127.0.0.1:4030/v1/holders?token=NEAR&top=5', cheapfacts: 'http://127.0.0.1:4031/v1/holders?token=NEAR&top=5' },
};

describe('playground.env', () => {
  it('has exactly the keys certo-mcp --playground reads, unquoted', () => {
    const vars = Object.fromEntries(playgroundEnv(info).split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }));
    expect(vars).toEqual({
      NEAR_NETWORK: 'sandbox', NEAR_RPC_URL: 'http://127.0.0.1:3030', CERTO_CONTRACT: 'certo', CERTO_TOKEN: 'usdc',
      BUYER_ACCOUNT: 'agent', BUYER_PRIVATE_KEY: 'ed25519:abc', PANEL_URL: 'http://127.0.0.1:5000',
      CERTO_EXAMPLE_URLS: 'chainfacts=http://127.0.0.1:4030/v1/holders?token=NEAR&top=5,cheapfacts=http://127.0.0.1:4031/v1/holders?token=NEAR&top=5',
    });
  });

  it('lives in CERTO_HOME (default ~/.certo) and is written private', () => {
    expect(playgroundEnvPath({ CERTO_HOME: '/x/y' })).toBe('/x/y/playground.env');
    expect(playgroundEnvPath({ HOME: '/h' })).toMatch(/\.certo\/playground\.env$/);
    const path = join(mkdtempSync(join(tmpdir(), 'certo-pg-')), 'sub', 'playground.env');
    writePlaygroundEnv(info, path);
    expect(readFileSync(path, 'utf8')).toBe(playgroundEnv(info));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('a new playground starts with no call records: those of an earlier sandbox are cleared', () => {
    const home = mkdtempSync(join(tmpdir(), 'certo-pg-'));
    const path = join(home, 'playground.env');
    const calls = playgroundStateDir(info, path);
    expect(calls).toBe(join(home, 'calls', 'sandbox', 'certo'));
    mkdirSync(calls, { recursive: true });
    writeFileSync(join(calls, 'cheapfacts_old.json'), '{"outcome":{"result":"refunded"}}');
    writePlaygroundEnv(info, path);
    // the directory certo --playground and certo-mcp --playground use for this sandbox
    expect(defaultStateDir(withPlayground({ CERTO_HOME: home }))).toBe(calls);
    expect(existsSync(join(calls, 'cheapfacts_old.json'))).toBe(false);
  });

  it('refuses a value that would need quoting', () => {
    expect(() => playgroundEnv({ ...info, panelUrl: 'http://x/a b' })).toThrow(/quoting/);
  });
});
