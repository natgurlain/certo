import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LocalChain } from '../src/sandbox.js';

// near-sandbox's tearDown() waits for the node's "exit" event with no limit, so a node that had
// already died made `make guards` hang after its last guard. LocalChain.stop() must return anyway.
describe('LocalChain.stop', () => {
  it('returns and removes the home directory when the node has already died', async () => {
    const chain = await LocalChain.start(['usdc']);
    const sb = (chain as unknown as { sandbox: { childProcess: import('node:child_process').ChildProcess; homeDir: string } }).sandbox;
    sb.childProcess.kill('SIGKILL');
    await new Promise<void>((ok) => sb.childProcess.once('exit', () => ok()));
    const t = Date.now();
    await chain.stop();
    expect(Date.now() - t).toBeLessThan(10_000);
    expect(existsSync(sb.homeDir)).toBe(false);
  }, 60_000);
});
