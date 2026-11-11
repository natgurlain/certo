import express from 'express';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ed25519FromLabel, toHex } from '@certo/core';
import { FakeChain } from '@certo/core/testing';
import { protect } from '@certo/seller';
import { CertoClient } from '@certo/buyer';
import { createMcpServer, TOOL_CALL, TOOL_DISPUTE, TOOL_STATUS } from '../src/index.js';

const SELLER = 'cheapfacts.test.near';
const key = ed25519FromLabel('mcp-seller');
const chain = new FakeChain();
chain.addSeller(SELLER, toHex(key.publicKey));
chain.addTermsFor(SELLER, 'holders-v1', 'terms');
const app = express();
app.get('/v1/holders', protect({ contract: chain, seller: SELLER, termsId: 'holders-v1', price: '400000', receiptKey: key }), (_q, r) => void r.json({ token: 'NEO' }));
let base = '';
let server: ReturnType<typeof app.listen>;
let client: Client;

beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const mcp = createMcpServer({ client: new CertoClient({ chain: chain.as('scout.test.near') }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '0' });
  await Promise.all([mcp.connect(a), client.connect(b)]);
});
afterAll(async () => { await client.close(); server.close(); });

const parse = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

describe('MCP server', () => {
  it('lists the three tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([TOOL_CALL, TOOL_DISPUTE, TOOL_STATUS].sort());
  });

  it('call → suggested dispute → dispute → status', async () => {
    const r = parse(await client.callTool({ name: TOOL_CALL, arguments: { url: `${base}/v1/holders?token=NEAR&top=5` } }));
    expect(r).toMatchObject({ status: 200, price: '0.400000', receipt_verified: true, suggested: { action: 'dispute', offerBps: 10000 } });
    const d = parse(await client.callTool({ name: TOOL_DISPUTE, arguments: { call_id: r.call_id, offer_pct: 100 } }));
    expect(d).toMatchObject({ kind: 'content', stake: '0.020000', sealed_offer_pct: 100 });
    const s = parse(await client.callTool({ name: TOOL_STATUS, arguments: { call_id: r.call_id, seller: SELLER } }));
    expect(s.call.status).toBe('Disputed');
    expect(s.seller.fee_bps).toBe(100);
  });

  it('reports refusals as tool errors', async () => {
    const r = await client.callTool({ name: TOOL_CALL, arguments: { url: `${base}/v1/holders?token=NEAR`, max_price: '1' } });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toBe('PRICE_TOO_HIGH');
    const d = await client.callTool({ name: TOOL_DISPUTE, arguments: { call_id: 'nope/1' } });
    expect(d.isError).toBe(true);
    expect(parse(d).error).toBe('NO_STATE');
  });
});
