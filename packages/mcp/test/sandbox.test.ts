/**
 * End to end on a local NEAR sandbox, through the real `certo-mcp --playground`
 * binary over stdio: quote → call (a wrong answer) → server restart → dispute,
 * which waits for the seller bot and the panel (replay of fixtures/panel/) and
 * returns the refund. Also `certo seller init` against the same contract.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromHex, NearCertoChain } from '@certo/core';
import { CertoClient, runCli } from '@certo/buyer';
import { PanelService, ReplayJurors, createPanelApp } from '@certo/panel';
import { nearBotKeyAdder, protect } from '@certo/seller';
import express from 'express';
import { choosePanel, loadDemo } from '../../../apps/demo/src/fixtures.js';
import { LocalChain, repoFile } from '../../../apps/demo/src/sandbox.js';
import { startDemoSeller, type DemoSeller } from '../../../apps/demo/src/seller.js';
import { addSeller, deployMarket, type Market } from '../../../apps/demo/src/world.js';

const BIN = fileURLToPath(new URL('../bin/certo-mcp.js', import.meta.url));
const fx = loadDemo();
const plan = choosePanel({});
const home = mkdtempSync(join(tmpdir(), 'certo-e2e-'));
let chain: LocalChain;
let m: Market;
let seller: DemoSeller;
let panelServer: Server;
let url = '';

beforeAll(async () => {
  chain = await LocalChain.start(['mg', 'usdc', 'owner', 'resolver', 'shady-api', 'agent', 'newseller']);
  m = await deployMarket({
    chain, contract: 'mg', token: 'usdc', owner: 'owner', resolver: 'resolver', wasm: 'res/certo.wasm', deployToken: true,
    jurors: plan.jurors, gatewayKey: plan.gatewayKey, acceptGateway: plan.acceptGateway,
  });
  const [reg] = await Promise.all([
    addSeller(m, { id: 'shady-api', bond: '50000000', terms: [{ terms_id: fx.terms.terms_id, text: fx.terms.text, panel: true }] }),
    m.mint('agent', '10000000'),
    m.mint('newseller', '60000000'),
  ]);
  seller = await startDemoSeller({
    id: 'shady-api', chain: reg.chain, receiptKey: reg.receiptKey, termsId: fx.terms.terms_id, price: fx.price,
    responses: { [fx.request]: fx.responses['shady-api'] },
  });
  const app = createPanelApp(new PanelService({ chain: m.client('resolver'), jurors: new ReplayJurors(repoFile('fixtures/panel')) }));
  panelServer = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  url = `${seller.url}${fx.request}`;
  const agent = chain.key('agent');
  writeFileSync(join(home, 'playground.env'), [
    'NEAR_NETWORK=sandbox', `NEAR_RPC_URL=${chain.rpcUrl}`, 'CERTO_CONTRACT=mg', 'CERTO_TOKEN=usdc',
    `BUYER_ACCOUNT=${agent.accountId}`, `BUYER_PRIVATE_KEY=${agent.privateKey}`,
    `PANEL_URL=http://127.0.0.1:${(panelServer.address() as AddressInfo).port}`, `CERTO_EXAMPLE_URLS=shady-api=${url}`,
  ].join('\n'));
}, 300_000);

afterAll(async () => {
  await seller?.kill();
  panelServer?.closeAllConnections();
  panelServer?.close();
  await chain?.stop();
});

async function mcp(): Promise<Client> {
  const t = new StdioClientTransport({ command: process.execPath, args: [BIN, '--playground'], env: { PATH: process.env.PATH!, CERTO_HOME: home }, stderr: 'pipe' });
  const c = new Client({ name: 'e2e', version: '0' });
  await c.connect(t);
  return c;
}
const parse = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0]!.text);

describe('sandbox e2e through certo-mcp --playground', () => {
  it('quote → call → restart → dispute returns the refund in one call', async () => {
    let c = await mcp();
    expect(c.getInstructions()).toContain(`shady-api = ${url}`);
    const q = parse(await c.callTool({ name: 'certo_quote', arguments: { url } }));
    expect(q).toMatchObject({ seller: 'shady-api', price_usdc: '0.400000', payable: true, dispute_stake_usdc: '0.020000',
      seller_record: { bond_usdc: '50.000000', free_capacity_usdc: '50.000000', fee_pct: 1, lost_disputes: 0, split_disputes: 0 }, terms: { text: fx.terms.text } });
    const call = parse(await c.callTool({ name: 'certo_call', arguments: { url } }));
    expect(call).toMatchObject({ http_status: 200, price_usdc: '0.400000', receipt_verified: true, suggested: { action: 'dispute' } });
    expect(call.body).toBe(fx.responses['shady-api']);
    await c.close(); // the MCP server restarts inside the refund window
    c = await mcp();
    const b0 = await m.balance('agent');
    const t0 = Date.now();
    const d = parse(await c.callTool({ name: 'certo_dispute', arguments: { call_id: call.call_id } }, undefined, { timeout: 120_000 }));
    expect(d).toMatchObject({
      opened: { kind: 'content', stake_usdc: '0.020000', sealed_offer_pct: 100 },
      state: 'final',
      outcome: { result: 'refunded', refund_usdc: '0.400000', stake_back_usdc: '0.020000', stake_lost_usdc: '0.000000', tier: 'panel', winner: 'buyer' },
    });
    expect(Date.now() - t0).toBeLessThan(90_000);
    expect(await m.balance('agent') - b0).toBe(400_000n); // price back; the stake went out and came back
    const s = parse(await c.callTool({ name: 'certo_status', arguments: { call_id: call.call_id, seller: 'shady-api' } }));
    expect(s).toMatchObject({ state: 'refunded', seller: { lost_disputes: 1, fee_pct: 1.5 } });
    await c.close();
  }, 180_000);

  it('certo seller init registers, publishes terms, bonds, and prints a snippet that serves 402s', async () => {
    const terms = join(home, 'terms.txt');
    writeFileSync(terms, 'Returns {"answer": 42} as JSON.');
    const lines: string[] = [];
    const botKeyAdder = (contractId: string) => nearBotKeyAdder({ rpcUrl: chain.rpcUrl, ...chain.key('newseller'), contractId });
    const code = await runCli(['seller', 'init', '--bond', '50', '--terms', terms, '--price', '0.25'], {
      chain: undefined as never, stateDir: join(home, 'calls'), home, sellerChain: () => m.client('newseller'), botKeyAdder, out: (l) => lines.push(l),
    });
    expect(code, lines.join('\n')).toBe(0);
    const out = lines.join('\n');
    expect(out).toMatch(/register: newseller registered, 1 NEAR deposit attached/);
    expect(out).toMatch(/terms: v1 published, AI panel off: refunds by rule only/);
    expect(out).toMatch(/bond: deposited 50.000000 USDC/);
    expect(out).toMatch(/protect\(\{ contract: chain, seller: 'newseller', termsId: 'v1', price: '250000'/);
    expect(await m.client().getSeller('newseller')).toMatchObject({ bond: '50000000', fee_bps: 100 });
    expect(out).toMatch(/bot key: ed25519:\S+ in .*seller-newseller\.bot-key: function call only, receiver mg, methods answer, cure, gas allowance 0\.25 NEAR, no deposits \(tx /);
    expect(out).toMatch(/createAnswerBot\(\{ chain: bot,/);
    // the bot key reaches the contract for `answer` (contract-level panic: no such call) but not for anything else
    const botKey = readFileSync(join(home, 'seller-newseller.bot-key'), 'utf8').trim();
    const bot = new NearCertoChain({ rpcUrl: chain.rpcUrl, contractId: 'mg', tokenId: 'usdc', accountId: 'newseller', privateKey: botKey });
    await expect(bot.answer('newseller/00000000000000000000000000000000', 0)).rejects.toThrow(/E_/);
    const denied = await bot.withdrawBond('1').then(() => 'allowed', (e: Error) => e.message);
    expect(denied).not.toBe('allowed');
    expect(denied).not.toMatch(/Smart contract panicked/);
    expect(denied).toMatch(/MethodNameMismatch|method/i);
    // re-running is a no-op that reuses the key
    lines.length = 0;
    expect(await runCli(['seller', 'init', '--bond', '0', '--terms', terms], {
      chain: undefined as never, stateDir: join(home, 'calls'), home, sellerChain: () => m.client('newseller'), botKeyAdder, out: (l) => lines.push(l),
    })).toBe(1); // a 0 bond is below the contract minimum
    expect(lines.at(-1)).toMatch(/below the contract minimum/);
    // the snippet's protect() with the generated key: a buyer can quote it
    const app = express();
    const keyHex = readFileSync(join(home, 'seller-newseller.receipt-key'), 'utf8').trim();
    app.get('/v1/answer', protect({ contract: m.client('newseller'), seller: 'newseller', termsId: 'v1', price: '250000', receiptKey: fromHex(keyHex) }), (_q, r) => void r.json({ answer: 42 }));
    const srv: Server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    try {
      const q = await new CertoClient({ chain: m.client('agent') }).quote(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/answer`);
      expect(q).toMatchObject({ seller: 'newseller', price: '250000', problems: [], terms: { text: 'Returns {"answer": 42} as JSON.', panel: false } });
    } finally {
      srv.close();
    }
  }, 120_000);
});
