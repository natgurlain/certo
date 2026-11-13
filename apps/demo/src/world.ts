/**
 * Market setup on a `LocalChain`: token, contract, sellers with bonds and
 * terms, funded buyers. Shared by the demo runner, the e2e tests and the
 * guard runner.
 */
import {
  ContractError, NearCertoChain, ONE_NEAR, ed25519FromLabel, toHex,
  type Ed25519Key, type NearChainOptions, type TxResult,
} from '@certo/core';
import { demoConfig, type JurorArg, type LocalChain } from './sandbox.js';

/** A chain client that reports every signed transaction (success or failure). */
export class TracedChain extends NearCertoChain {
  onTx?: (method: string, tx: TxResult, error?: ContractError) => void;

  constructor(o: NearChainOptions, onTx?: TracedChain['onTx']) {
    super(o);
    this.onTx = onTx;
  }

  override async call(method: string, args: Record<string, unknown>, opts: { receiverId?: string; gas?: bigint; deposit?: bigint } = {}): Promise<TxResult> {
    const label = opts.receiverId && opts.receiverId !== this.contractId ? `${method}(${String((JSON.parse(String(args.msg ?? '{}')) as { action?: string }).action ?? '')})` : method;
    try {
      const tx = await super.call(method, args, opts);
      this.onTx?.(label, tx);
      return tx;
    } catch (e) {
      if (e instanceof ContractError && e.tx) this.onTx?.(label, e.tx, e);
      throw e;
    }
  }
}

/** Bond each demo seller holds at the start of a run, and each buyer's starting funds (base units). */
export const DEMO_BOND = '50000000';
export const DEMO_BUYER_FUNDS = '10000000';

/**
 * What the demo runner needs from a chain, so the same four scenes run on the
 * local sandbox and on testnet. Actors are named by their demo label
 * (`agent`, `honest-api`, `resolver`, …); `id(label)` is the account id
 * (the label itself on the sandbox, e.g. `agent.certo.testnet` on testnet).
 */
export interface DemoWorld {
  network: 'sandbox' | 'testnet';
  contract: string;
  token: string;
  id(label: string): string;
  /** Client signed by the actor `label` (view-only without a label). */
  client(label?: string, onTx?: TracedChain['onTx']): TracedChain;
  balance(accountId: string): Promise<bigint>;
  /** Latest block timestamp in ms. */
  nowMs(): Promise<number>;
  /** Receipt key the seller `label` registered with. */
  receiptKey(label: string): Ed25519Key;
  /** Explorer link of a transaction (null on the sandbox). */
  txUrl(hash: string): string | null;
  stop(): Promise<void>;
  /** The local market (sandbox only): its chain holds every genesis key. */
  local?: Market;
}

export interface MarketSpec {
  chain: LocalChain;
  contract: string;
  token: string;
  owner: string;
  resolver: string;
  /** Repo-relative wasm path of the certo contract. */
  wasm: string;
  jurors: JurorArg[];
  gatewayKey: string | null;
  acceptGateway?: boolean;
  /** Deploy the mock token too (once per sandbox). */
  deployToken?: boolean;
  cfg?: Record<string, unknown>;
  /** Default transaction observer for every client of this market. */
  onTx?: TracedChain['onTx'];
}

export interface Market {
  chain: LocalChain;
  contract: string;
  token: string;
  owner: string;
  resolver: string;
  /** Client signed by `accountId` (or view-only). */
  client(accountId?: string, onTx?: TracedChain['onTx']): TracedChain;
  mint(accountId: string, amount: string): Promise<void>;
  balance(accountId: string): Promise<bigint>;
}

export async function deployMarket(s: MarketSpec): Promise<Market> {
  const { chain } = s;
  const initArgs = {
    owner: s.owner, token: s.token, resolver: s.resolver, cfg: s.cfg ?? demoConfig(s.acceptGateway ?? false),
    jurors: s.jurors, gateway_key: s.gatewayKey,
  };
  await Promise.all([
    s.deployToken ? chain.deploy(s.token, 'res/mock_usdc.wasm', { method: 'new', args: {} }) : Promise.resolve(),
    chain.deploy(s.contract, s.wasm, { method: 'new', args: initArgs }),
  ]);
  const m: Market = {
    chain, contract: s.contract, token: s.token, owner: s.owner, resolver: s.resolver,
    client: (accountId, onTx) => chain.client(s.contract, s.token, accountId, (o) => new TracedChain(o, onTx ?? s.onTx)),
    // the token's `mint` is open: any account may sign it; each account mints for itself to avoid nonce races
    mint: async (accountId, amount) => { await chain.call(accountId, s.token, 'mint', { account_id: accountId, amount }); },
    balance: async (accountId) => BigInt(await chain.view<string>(s.token, 'ft_balance_of', { account_id: accountId })),
  };
  return m;
}

export interface SellerSpec {
  id: string;
  /** Receipt key; default derived from the account id (test key). */
  receiptKey?: Ed25519Key;
  windowMs?: number;
  /** Bond in base units (minted to the seller and deposited). */
  bond: string;
  terms: Array<{ terms_id: string; text: string; required_fields?: string[]; as_of_field?: string | null; max_age_s?: number | null; panel: boolean }>;
}

/** Register a seller, add its terms and deposit its bond (all signed by the seller). */
export async function addSeller(m: Market, s: SellerSpec): Promise<{ id: string; receiptKey: Ed25519Key; chain: TracedChain }> {
  const receiptKey = s.receiptKey ?? ed25519FromLabel(`demo-seller-receipt:${s.id}`);
  const c = m.client(s.id);
  await c.registerSeller({ receipt_pubkey: toHex(receiptKey.publicKey), window_ms: s.windowMs ?? 120_000 }, ONE_NEAR);
  for (const t of s.terms) {
    await c.addTerms({
      terms_id: t.terms_id, text: t.text, required_fields: t.required_fields ?? [], as_of_field: t.as_of_field ?? null,
      max_age_s: t.max_age_s ?? null, panel: t.panel,
    });
  }
  if (BigInt(s.bond) > 0n) {
    await m.mint(s.id, s.bond);
    await c.depositBond(s.bond);
  }
  return { id: s.id, receiptKey, chain: c };
}

