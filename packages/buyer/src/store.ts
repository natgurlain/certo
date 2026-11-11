import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLI_NAME } from '@certo/core';

/** How a dispute ended, as seen by this buyer. Amounts in base units. */
export interface Outcome {
  /** `refunded`: the whole price came back; `partly_refunded`; `not_refunded`; `cured`: the seller proved delivery. */
  result: 'refunded' | 'partly_refunded' | 'not_refunded' | 'cured' | 'settled_elsewhere';
  refund: string;
  /** Stake returned to the buyer (0 when forfeited). */
  stakeBack: string;
  /** Stake lost to the treasury. */
  stakeLost: string;
  /** `rule`, `default`, `settled`, `panel` (contract `dispute_resolved.tier`), or `cure`. */
  tier: string;
  reason?: string;
  winner?: string;
  votes?: string[];
  tx?: string;
  atMs: number;
  /** Panel run that produced a `panel`/`settled` verdict: `replay` or `live`; `synthetic` = test-key jurors. */
  panel?: { mode?: string; synthetic?: boolean };
}

/** Everything a buyer keeps about one call, persisted as one JSON file per call id. */
export interface SavedCall {
  /** Written right after the payment, before delivery. */
  paid?: { callId: string; seller: string; price: string; payTx: string; url: string; atMs: number };
  /** The delivered call with its receipt; `bodyB64` holds the exact bytes. */
  result?: Record<string, unknown> & { bodyB64: string };
  /** Sealed offer (salt!) of a content dispute, or the stake of a non-delivery claim. Saved before the transaction. */
  dispute?: { callId: string; kind: 'content' | 'non_delivery'; offerBps: number; salt: string; commit: string; stake: string };
  /** Panel case already sent. */
  panelSent?: boolean;
  outcome?: Outcome;
}

/** Persistence for call records and sealed-offer salts, shared by the CLI and the MCP server. */
export interface CallStore {
  load(callId: string): SavedCall | undefined;
  save(callId: string, s: SavedCall): void;
}

/**
 * `$CERTO_STATE_DIR`, else `$CERTO_HOME/calls/<NEAR_NETWORK>/<CERTO_CONTRACT>` (`$CERTO_HOME` defaults to `~/.certo`):
 * records of one network and contract are never read for another.
 */
export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const part = (v: string | undefined) => (v || 'default').replace(/[^A-Za-z0-9._-]/g, '_');
  return env.CERTO_STATE_DIR ?? join(certoHome(env), 'calls', part(env.NEAR_NETWORK), part(env.CERTO_CONTRACT));
}

/** `$CERTO_HOME`, else `~/.certo`. */
export function certoHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CERTO_HOME ?? join(homedir(), `.${CLI_NAME}`);
}

/** One JSON file per call id in `dir` (written atomically). */
export class FileCallStore implements CallStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(id: string): string {
    return join(this.dir, `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  }

  load(callId: string): SavedCall | undefined {
    try {
      return JSON.parse(readFileSync(this.file(callId), 'utf8')) as SavedCall;
    } catch {
      return undefined;
    }
  }

  save(callId: string, s: SavedCall): void {
    mkdirSync(this.dir, { recursive: true }); // the playground clears its directory when it restarts
    const f = this.file(callId);
    writeFileSync(`${f}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 });
    renameSync(`${f}.tmp`, f);
  }
}

/** In-memory store (the default when none is given). */
export class MemoryCallStore implements CallStore {
  private readonly m = new Map<string, SavedCall>();
  load(callId: string) { return this.m.get(callId); }
  save(callId: string, s: SavedCall) { this.m.set(callId, structuredClone(s)); }
}
