import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NearMakegoodChain, sha256Hex, signAndSend, toBase64, fromHex } from '../src/index.js';

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

describe('NearMakegoodChain views (mock RPC)', () => {
  it('calls the contract and token with 4.2 argument names and normalises the results', async () => {
    const c = new NearMakegoodChain({ rpcUrl: url, contractId: 'mg.near', tokenId: 'usdc.near' });
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
    const c = new NearMakegoodChain({ rpcUrl: url, contractId: 'mg.near', tokenId: 'usdc.near', network: 'near:testnet' });
    await expect(c.answer('s.near/aa', 0)).rejects.toThrow(/no signing account/);
  });
});

describe('signAndSend', () => {
  const fake = (errors: Array<{ type?: string }>) => {
    let calls = 0;
    const account = { signAndSendTransaction: async () => { calls++; const e = errors.shift(); if (e) throw Object.assign(new Error('rpc'), e); return 'outcome'; } };
    return { account: account as unknown as Parameters<typeof signAndSend>[0], calls: () => calls };
  };
  const params = { receiverId: 'mg.near', actions: [] };

  it('signs and sends again after InvalidChain', async () => {
    const f = fake([{ type: 'InvalidChain' }, { type: 'InvalidChain' }]);
    expect(await signAndSend(f.account, params)).toBe('outcome');
    expect(f.calls()).toBe(3);
  });

  it('does not resend after other errors, and gives up after `tries`', async () => {
    const other = fake([{ type: 'InvalidNonce' }]);
    await expect(signAndSend(other.account, params)).rejects.toMatchObject({ type: 'InvalidNonce' });
    expect(other.calls()).toBe(1);
    const stuck = fake([{ type: 'InvalidChain' }, { type: 'InvalidChain' }]);
    await expect(signAndSend(stuck.account, params, 2)).rejects.toMatchObject({ type: 'InvalidChain' });
    expect(stuck.calls()).toBe(2);
  });
});
