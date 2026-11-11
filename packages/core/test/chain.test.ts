import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Account } from '@near-js/accounts';
import { KeyPair } from '@near-js/crypto';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { NearCertoChain, sha256Hex, signAndSend, toBase64, fromHex, TxTimeoutError } from '../src/index.js';

// Minimal JSON-RPC stand-in answering `query/call_function` like a NEAR node.
const views: Record<string, (args: Record<string, unknown>) => unknown> = {
  get_config: () => ({ owner: 'o.near', token: 'usdc.near', cfg: { min_bond: '1000000', answer_ms: 5000, stake_bps: 500 }, treasury: '4000' }),
  get_call: (a) => (a.call_id === 's.near/aa' ? {
    call_id: 's.near/aa', buyer: 'b.near', seller: 's.near', terms_id: 't', price: '400000', fee: '4000', reserve: '420000',
    request_hash: toBase64(fromHex(sha256Hex('r'))), paid_at_ms: 1, expires_at_ms: 2, status: 'Disputed',
    dispute: { opened_at_ms: 1, stake: '20000', buyer_commit: Array.from(fromHex(sha256Hex('c'))), response_hash: sha256Hex('x').toUpperCase(), status_code: 200, served_at_ms: 1, seller_offer_bps: null, answered_at_ms: 0 },
  } : null),
  get_jurors: () => ({ epoch: 2, jurors: [{ model_id: 'm', pubkey: sha256Hex('k'), attestation_sha256: sha256Hex('a') }], gateway_key: null }),
  ft_balance_of: (a) => (a.account_id === 'b.near' ? '123' : '0'),
};
const seen: Array<{ account_id: string; method_name: string; args: unknown }> = [];
let server: Server;
let url = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const rpc = JSON.parse(body);
      const p = rpc.params;
      const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString());
      seen.push({ account_id: p.account_id, method_name: p.method_name, args });
      const result = Array.from(Buffer.from(JSON.stringify(views[p.method_name]!(args))));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { result, logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' } }));
    });
  });
  server.listen(0);
  await new Promise((r) => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('NearCertoChain views (mock RPC)', () => {
  it('calls the contract and token with 4.2 argument names and normalises the results', async () => {
    const c = new NearCertoChain({ rpcUrl: url, contractId: 'mg.near', tokenId: 'usdc.near' });
    expect(c.network).toBe('near:sandbox');
    expect(await c.getConfig()).toMatchObject({ owner: 'o.near', min_bond: '1000000', answer_ms: 5000, treasury: '4000' });
    const call = (await c.getCall('s.near/aa'))!;
    expect(call.request_hash).toBe(sha256Hex('r'));
    expect(call.dispute!.buyer_commit).toBe(sha256Hex('c'));
    expect(call.dispute!.response_hash).toBe(sha256Hex('x'));
    expect(await c.getCall('nope')).toBeNull();
    expect(await c.getJurors()).toEqual({ epoch: 2, jurors: [{ model_id: 'm', pubkey: sha256Hex('k'), attestation_sha256: sha256Hex('a') }], gateway_key: null });
    expect(await c.ftBalanceOf('b.near')).toBe('123');
    expect(seen.map((s) => [s.account_id, s.method_name, s.args])).toEqual([
      ['mg.near', 'get_config', {}], ['mg.near', 'get_call', { call_id: 's.near/aa' }], ['mg.near', 'get_call', { call_id: 'nope' }],
      ['mg.near', 'get_jurors', {}], ['usdc.near', 'ft_balance_of', { account_id: 'b.near' }],
    ]);
  });
  it('refuses to sign without an account', async () => {
    const c = new NearCertoChain({ rpcUrl: url, contractId: 'mg.near', tokenId: 'usdc.near', network: 'near:testnet' });
    await expect(c.answer('s.near/aa', 0)).rejects.toThrow(/no signing account/);
  });
});

describe('signAndSend (scripted RPC)', () => {
  // A node answering access-key and block queries, and `send_tx` / `tx` from a script.
  type Reply = { status?: number; result?: unknown; error?: unknown };
  const OUTCOME = { status: { SuccessValue: '' }, transaction: {}, transaction_outcome: { id: 'h', outcome: { logs: [], status: { SuccessValue: '' } } }, receipts_outcome: [] };
  const TIMEOUT: Reply = { status: 408, error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR', info: {} }, code: -32000, message: 'Server error', data: 'Timeout' } };
  const UNKNOWN: Reply = { error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION', info: {} }, code: -32000, message: 'Server error', data: 'Transaction doesn\'t exist' } };
  const invalid = (e: string): Reply => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION', info: {} }, code: -32000, message: 'Server error', data: { TxExecutionError: { InvalidTxError: e } } } });
  let script: Record<'send_tx' | 'tx', Reply[]>;
  let log: Array<{ method: string; params: Record<string, unknown> }>;
  let rpcUrl = '';
  let node: Server;
  beforeAll(async () => {
    node = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { id, method, params } = JSON.parse(body);
        log.push({ method, params });
        let r: Reply = { result: OUTCOME };
        if (method === 'query') r = { result: { nonce: 7, permission: 'FullAccess', block_height: 1, block_hash: '1'.repeat(32) } };
        else if (method === 'block') r = { result: { header: { hash: '1'.repeat(32), height: 1 } } };
        else if (method === 'send_tx' || method === 'tx') r = script[method as 'send_tx' | 'tx'].shift() ?? r;
        res.statusCode = r.status ?? 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id, ...(r.error ? { error: r.error } : { result: r.result }) }));
      });
    });
    node.listen(0);
    await new Promise((r) => node.once('listening', r));
    rpcUrl = `http://127.0.0.1:${(node.address() as AddressInfo).port}`;
  });
  afterAll(() => node.close());
  const run = (s: Partial<typeof script>, o?: Parameters<typeof signAndSend>[2], throwOnFailure?: boolean) => {
    script = { send_tx: [], tx: [], ...s };
    log = [];
    const account = new Account('b.near', new JsonRpcProvider({ url: rpcUrl }), KeyPairSigner.fromSecretKey(KeyPair.fromRandom('ed25519').toString()));
    return signAndSend(account, { receiverId: 'mg.near', actions: [], throwOnFailure }, o);
  };
  const calls = (m: string) => log.filter((x) => x.method === m);
  const signings = () => calls('block').length;

  it('after a send_tx timeout looks the transaction up by hash and does not send it again', async () => {
    expect(await run({ send_tx: [TIMEOUT], tx: [{ result: OUTCOME }] })).toEqual(OUTCOME);
    expect([calls('send_tx').length, calls('tx').length, signings()]).toEqual([1, 1, 1]);
    expect(calls('block')[0]!.params).toMatchObject({ finality: 'final' }); // never the optimistic head
  });

  it('resends the same signed bytes when the node does not know the transaction, never re-signs', async () => {
    expect(await run({ send_tx: [TIMEOUT, { result: OUTCOME }], tx: [UNKNOWN] })).toEqual(OUTCOME);
    const sent = calls('send_tx').map((x) => x.params.signed_tx_base64);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(signings()).toBe(1);
  });

  it('gives up with TxTimeoutError (and the hash) after timeoutMs', async () => {
    const t0 = Date.now();
    const err = await run({ send_tx: Array(50).fill(TIMEOUT), tx: Array(50).fill(TIMEOUT) }, { timeoutMs: 1_500 }).catch((e) => e);
    expect(err).toBeInstanceOf(TxTimeoutError);
    expect(err.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(signings()).toBe(1);
  });

  it('signs again after InvalidChain, up to `tries`; other rejections are not resent', async () => {
    expect(await run({ send_tx: [invalid('InvalidChain'), invalid('InvalidChain')] })).toEqual(OUTCOME);
    expect([calls('send_tx').length, signings()]).toEqual([3, 3]);
    await expect(run({ send_tx: [invalid('InvalidNonce')] })).rejects.toMatchObject({ type: 'InvalidNonce' });
    expect(calls('send_tx').length).toBe(1);
    await expect(run({ send_tx: [invalid('InvalidChain'), invalid('InvalidChain')] }, { tries: 2 })).rejects.toMatchObject({ type: 'InvalidChain' });
    expect(calls('send_tx').length).toBe(2);
  });

  it('throws on a failed execution unless throwOnFailure is false', async () => {
    const failed = { ...OUTCOME, status: { Failure: { ActionError: { kind: 'x' } } } };
    await expect(run({ send_tx: [{ result: failed }] })).rejects.toMatchObject({ type: 'TxFailure' });
    expect(await run({ send_tx: [{ result: failed }] }, undefined, false)).toEqual(failed);
  });
});
