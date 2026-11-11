/**
 * Local NEAR chain for the demo, the e2e tests and the guard runner.
 *
 * Uses the `near-sandbox` npm package (the sandbox launcher that
 * `near-workspaces` wraps), pinned to nearcore `SANDBOX_VERSION`, which it
 * downloads on first use. 2.10.0 is the newest release whose Linux x86-64
 * binary loads with glibc 2.34 (Ubuntu 22.04, Debian 12); later ones need
 * glibc 2.39 (README "Requirements"). `NEAR_SANDBOX_BIN_PATH` points it at an
 * existing binary instead. Accounts are created in genesis, so no
 * account-creation transactions are needed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Account } from '@near-js/accounts';
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { actionCreators } from '@near-js/transactions';
import { GenesisAccount, Sandbox } from 'near-sandbox';
import { NearMakegoodChain, ONE_NEAR, signAndSend, TGAS, type NearChainOptions } from '@makegood/core';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const repoFile = (rel: string) => fileURLToPath(new URL(rel, new URL('../../../', import.meta.url)));

/** nearcore version of the local sandbox (the committed wasm also runs on 2.14.0, docs/CONTRACT_NOTES.md). */
export const SANDBOX_VERSION = '2.10.0';
/** Oldest glibc each published Linux build of `SANDBOX_VERSION` loads with (checked with `objdump -T`). */
const MIN_GLIBC: Partial<Record<NodeJS.Architecture, string>> = { x64: '2.34', arm64: '2.39' };

/**
 * On Linux, fail with a clear message when the C library is older than the
 * sandbox binary needs (near-sandbox itself reports only "Binary doesn't
 * respond, probably is corrupted"). Skipped when `NEAR_SANDBOX_BIN_PATH` is set
 * or the glibc version is unknown (e.g. musl).
 */
function checkGlibc(): void {
  const need = MIN_GLIBC[process.arch];
  if (process.platform !== 'linux' || process.env.NEAR_SANDBOX_BIN_PATH || !need) return;
  const have = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
  if (!have) return;
  const [a, b] = [have, need].map((v) => v.split('.').map(Number));
  if (a[0] > b[0] || (a[0] === b[0] && (a[1] ?? 0) >= (b[1] ?? 0))) return;
  throw new Error(`the nearcore ${SANDBOX_VERSION} sandbox binary for Linux ${process.arch} needs glibc >= ${need}; this system has ${have}. `
    + 'Use a newer distribution (README "Requirements"), or set NEAR_SANDBOX_BIN_PATH to a near-sandbox binary that runs here. `make verify` needs no chain.');
}

export const WASM = {
  makegood: 'res/makegood.wasm',
  usdc: 'res/mock_usdc.wasm',
  guard: (n: number) => `res/guards/makegood_no_g${n}.wasm`,
};

export interface Keyed {
  accountId: string;
  privateKey: string;
}

/** A running sandbox with funded genesis accounts. */
export class LocalChain {
  readonly provider: JsonRpcProvider;
  private constructor(readonly sandbox: Sandbox, readonly rpcUrl: string, private readonly keys: Map<string, string>) {
    this.provider = new JsonRpcProvider({ url: rpcUrl });
  }

  /**
   * Start a sandbox whose genesis contains `accountIds`, each with 100 NEAR and
   * its own fresh full-access key.
   */
  static async start(accountIds: string[]): Promise<LocalChain> {
    const keys = new Map<string, string>();
    const extra = accountIds.map((id) => {
      const kp = KeyPair.fromRandom('ed25519');
      keys.set(id, kp.toString());
      return new GenesisAccount(id, kp.getPublicKey().toString(), kp.toString(), 100n * ONE_NEAR);
    });
    checkGlibc();
    if (!process.env.NEAR_SANDBOX_BIN_PATH && !existsSync(join(dirname(createRequire(import.meta.url).resolve('near-sandbox')), '..', '..', 'bin', `near-sandbox-${SANDBOX_VERSION}`, 'near-sandbox'))) {
      console.error(`downloading the nearcore ${SANDBOX_VERSION} sandbox binary, about 30 MB (first run only; set NEAR_SANDBOX_BIN_PATH to use an existing one)`);
    }
    const sandbox = await Sandbox.start({ config: { additionalAccounts: extra }, version: SANDBOX_VERSION });
    // the sandbox is a child process; make sure it does not outlive this process
    const child = (sandbox as unknown as { childProcess?: { kill(sig: string): void } }).childProcess;
    process.once('exit', () => child?.kill('SIGKILL'));
    return new LocalChain(sandbox, sandbox.rpcUrl, keys);
  }

  key(accountId: string): Keyed {
    const privateKey = this.keys.get(accountId);
    if (!privateKey) throw new Error(`no genesis account ${accountId}`);
    return { accountId, privateKey };
  }

  account(accountId: string): Account {
    const k = this.key(accountId);
    return new Account(accountId, this.provider, KeyPairSigner.fromSecretKey(k.privateKey as KeyPairString));
  }

  /** Deploy `wasm` (repo-relative) to an existing genesis account and call its init method in the same transaction. */
  async deploy(accountId: string, wasm: string, init?: { method: string; args: Record<string, unknown> }): Promise<void> {
    const code = readFileSync(repoFile(wasm));
    const actions = [actionCreators.deployContract(new Uint8Array(code))];
    if (init) actions.push(actionCreators.functionCall(init.method, init.args, 100n * TGAS, 0n));
    await signAndSend(this.account(accountId), { receiverId: accountId, actions });
  }

  /** Signed function call from a genesis account (throws on failure). */
  async call(from: string, receiverId: string, method: string, args: Record<string, unknown>, opts: { gas?: bigint; deposit?: bigint } = {}) {
    return signAndSend(this.account(from), {
      receiverId,
      actions: [actionCreators.functionCall(method, args, opts.gas ?? 100n * TGAS, opts.deposit ?? 0n)],
    });
  }

  view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.provider.callFunction(contractId, method, args) as Promise<T>;
  }

  /** Latest block timestamp in ms. */
  async nowMs(): Promise<number> {
    const b = await this.provider.viewBlock({ finality: 'optimistic' });
    return Math.floor(Number(BigInt(b.header.timestamp_nanosec) / 1_000_000n));
  }

  /** `sandbox_fast_forward`: produce `blocks` blocks at once (block time advances with them). */
  async fastForward(blocks: number): Promise<void> {
    const r = await fetch(this.rpcUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ff', method: 'sandbox_fast_forward', params: { delta_height: blocks } }),
    });
    const j = (await r.json()) as { error?: unknown };
    if (j.error) throw new Error(`sandbox_fast_forward: ${JSON.stringify(j.error)}`);
  }

  /** Fast-forward until the latest block time is strictly after `tsMs`. */
  async advancePast(tsMs: number): Promise<void> {
    for (;;) {
      const now = await this.nowMs();
      if (now > tsMs) return;
      await this.fastForward(Math.max(1, Math.ceil((tsMs - now) / 500)));
    }
  }

  /** A `MakegoodChain` client signed by `accountId` (any subclass, e.g. the demo's instrumented one). */
  client<C extends NearMakegoodChain = NearMakegoodChain>(
    contractId: string, tokenId: string, accountId?: string,
    make: (o: NearChainOptions) => C = (o) => new NearMakegoodChain(o) as C,
  ): C {
    return make({
      rpcUrl: this.rpcUrl, contractId, tokenId, network: 'near:sandbox',
      ...(accountId ? this.key(accountId) : {}),
    });
  }

  async stop(): Promise<void> {
    await this.sandbox.tearDown().catch(() => undefined);
  }
}

/** Contract configuration used by the demo and the tests (DESIGN 4.2, `answer_ms` 5 s as in `make demo`). */
export function demoConfig(acceptGateway = false) {
  return {
    min_bond: '1000000', min_price: '10000',
    window_min_ms: 60_000, window_max_ms: 86_400_000,
    answer_ms: 5_000, resolver_exclusive_ms: 60_000, panel_deadline_ms: 300_000,
    stake_min: '20000', stake_bps: 500,
    max_terms: 1024, max_request: 1024, max_response: 6144,
    accept_gateway: acceptGateway,
  };
}

export interface JurorArg {
  model_id: string;
  pubkey: string;
  attestation_sha256: string;
}
