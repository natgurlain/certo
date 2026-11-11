import express from 'express';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ed25519FromLabel, toHex } from '@certo/core';
import { FakeChain } from '@certo/core/testing';
import { protect } from '@certo/seller';
import { CertoClient, FileCallStore } from '@certo/buyer';
import { createMcpServer, TOOL_CALL, TOOL_DISPUTE, TOOL_QUOTE, TOOL_STATUS } from '../src/index.js';

const SELLER = 'cheapfacts.test.near';
const key = ed25519FromLabel('mcp-seller');
const chain = new FakeChain();
chain.addSeller(SELLER, toHex(key.publicKey));
chain.addTermsFor(SELLER, 'holders-v1', 'terms');
const app = express();
app.get('/v1/holders', protect({ contract: chain, seller: SELLER, termsId: 'holders-v1', price: '400000', receiptKey: key }), (_q, r) => void r.json({ token: 'NEO' }));
let base = '';
let server: ReturnType<typeof app.listen>;
const stateDir = mkdtempSync(join(tmpdir(), 'certo-mcp-'));
const BIN = fileURLToPath(new URL('../bin/certo-mcp.js', import.meta.url));

async function connect(): Promise<Client> {
  const mcp = createMcpServer({
    client: new CertoClient({ chain: chain.as('scout.test.near'), store: new FileCallStore(stateDir) }),
    examples: [{ name: 'cheapfacts', url: `${base}/v1/holders?token=NEAR` }],
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([mcp.connect(a), client.connect(b)]);
  return client;
}

let client: Client;
beforeAll(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = await connect();
});
afterAll(async () => { await client.close(); server.close(); });

const parse = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

describe('MCP server', () => {
  it('lists four tools whose descriptions state units, stake, loss and timing; instructions name the examples', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([TOOL_CALL, TOOL_DISPUTE, TOOL_QUOTE, TOOL_STATUS].sort());
    const d = tools.find((t) => t.name === TOOL_DISPUTE)!;
    expect(d.description).toMatch(/USDC decimal strings/);
    expect(d.description).toMatch(/stake is forfeited/);
    expect(d.description).toMatch(/next stake doubles/);
    expect(d.description).toMatch(/default 90/);
    expect(d.inputSchema.properties).toHaveProperty('kind.enum', ['content', 'error', 'rule', 'non_delivery']);
    expect(d.inputSchema.properties).toHaveProperty('submit_to_panel.default', false);
    expect(tools.find((t) => t.name === TOOL_CALL)!.description).toMatch(/PRICE_TOO_HIGH.*nothing paid|nothing paid.*PRICE_TOO_HIGH/);
    expect(client.getInstructions()).toMatch(new RegExp(`cheapfacts = ${base}/v1/holders\\?token=NEAR`));
  });

  it('quote → call → dispute → status, then a restarted server continues the dispute', async () => {
    const q = parse(await client.callTool({ name: TOOL_QUOTE, arguments: { url: `${base}/v1/holders?token=NEAR&top=5` } }));
    expect(q).toMatchObject({ seller: SELLER, price_usdc: '0.400000', payable: true, dispute_stake_usdc: '0.020000', terms_id: 'holders-v1',
      seller_record: { bond_usdc: '50.000000', fee_pct: 1, lost_disputes: 0 } });
    const r = parse(await client.callTool({ name: TOOL_CALL, arguments: { url: `${base}/v1/holders?token=NEAR&top=5` } }));
    expect(r).toMatchObject({ http_status: 200, price_usdc: '0.400000', receipt_verified: true, dispute_stake_usdc: '0.020000',
      suggested: { action: 'dispute', offerBps: 10000 } });
    expect(r.refund_window_until).toMatch(/^\d{4}-\d\d-\d\dT/);
    const d = parse(await client.callTool({ name: TOOL_DISPUTE, arguments: { call_id: r.call_id, offer_pct: 100, wait_s: 0 } }));
    expect(d).toMatchObject({ opened: { kind: 'content', stake_usdc: '0.020000', sealed_offer_pct: 100 } });
    const s = parse(await client.callTool({ name: TOOL_STATUS, arguments: { call_id: r.call_id, seller: SELLER } }));
    expect(s).toMatchObject({ state: 'in_dispute', call: { status: 'Disputed', price_usdc: '0.400000', dispute: { stake_usdc: '0.020000' } }, seller: { fee_pct: 1 } });
    // restart: a new server process state, same store on disk; seller answers; no panel → still waiting, nothing reopened
    await client.close();
    client = await connect();
    await chain.answer.call(chain.as(SELLER), r.call_id, 0);
    const again = parse(await client.callTool({ name: TOOL_DISPUTE, arguments: { call_id: r.call_id, wait_s: 0 } }));
    expect(again).toMatchObject({ state: 'waiting', chain_status: 'Answered' });
    expect(again.opened).toBeUndefined();
    expect(again.detail).toMatch(/seller offered 0%/);
  });

  it('reports refusals as tool errors with what to do', async () => {
    const r = await client.callTool({ name: TOOL_CALL, arguments: { url: `${base}/v1/holders?token=NEAR`, max_price: '0.39' } });
    expect(r.isError).toBe(true);
    expect(parse(r)).toMatchObject({ error: 'PRICE_TOO_HIGH', what_to_do: expect.stringMatching(/nothing was paid/) });
    const d = await client.callTool({ name: TOOL_DISPUTE, arguments: { call_id: 'nope/1' } });
    expect(parse(d)).toMatchObject({ error: 'NO_STATE' });
    const st = parse(await client.callTool({ name: TOOL_STATUS, arguments: { call_id: 'nope/1' } }));
    expect(st).toMatchObject({ state: 'unknown', detail: expect.stringMatching(/never paid/) });
  });
});

describe('certo-mcp entry point', () => {
  it('missing env: one line on stderr, exit 2, no stack trace', () => {
    const r = spawnSync(process.execPath, [BIN], { env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), 'h-')) }, encoding: 'utf8', input: '' });
    expect(r.status).toBe(2);
    expect(r.stderr.trim()).toBe('certo: set CERTO_CONTRACT, CERTO_TOKEN, BUYER_ACCOUNT, BUYER_PRIVATE_KEY (and NEAR_RPC_URL, NEAR_NETWORK), or add --playground to use a sandbox started with `make playground`');
    const p = spawnSync(process.execPath, [BIN, '--playground'], { env: { PATH: process.env.PATH, CERTO_HOME: mkdtempSync(join(tmpdir(), 'h-')) }, encoding: 'utf8', input: '' });
    expect([p.status, p.stderr.trim()]).toEqual([2, 'no playground running: start one with `make playground` in the certo repo']);
  }, 30_000);

  it('--playground: starts from the playground file and names the example URLs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'h-'));
    writeFileSync(join(home, 'playground.env'), [
      'NEAR_NETWORK=sandbox', 'NEAR_RPC_URL=http://127.0.0.1:9', 'CERTO_CONTRACT=certo.test.near', 'CERTO_TOKEN=usdc.test.near',
      'BUYER_ACCOUNT=scout.test.near', `BUYER_PRIVATE_KEY=ed25519:${'1'.repeat(64)}`, 'PANEL_URL=http://127.0.0.1:9',
      'CERTO_EXAMPLE_URLS=cheapfacts=http://127.0.0.1:9/v1/holders?token=NEAR',
    ].join('\n'));
    const t = new StdioClientTransport({ command: process.execPath, args: [BIN, '--playground'], env: { PATH: process.env.PATH!, CERTO_HOME: home }, stderr: 'pipe' });
    const c = new Client({ name: 'test', version: '0' });
    await c.connect(t);
    try {
      expect(c.getInstructions()).toMatch(/cheapfacts = http:\/\/127\.0\.0\.1:9\/v1\/holders\?token=NEAR/);
      const { tools } = await c.listTools();
      expect(tools.find((x) => x.name === TOOL_DISPUTE)!.inputSchema.properties).toHaveProperty('submit_to_panel.default', true);
    } finally {
      await c.close();
    }
  }, 30_000);
});
