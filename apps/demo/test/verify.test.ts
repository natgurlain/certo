import { readFileSync } from 'node:fs';
import { buildPanelRequestFor, parseVote as coreParseVote, SYSTEM_PROMPT as CORE_PROMPT } from '@certo/core';
import { describe, expect, it } from 'vitest';
import {
  SYSTEM_PROMPT, base58, fromHex, makeRpc, panelRequestBody, parseVote, verifyOnChain,
  // @ts-expect-error plain ES module of the page, no type declarations
} from '../web/verify.js';

type Rec = { method: string; params: Record<string, unknown>; response: any };
const here = (p: string) => new URL(p, import.meta.url);
const FEED = JSON.parse(readFileSync(here('../../../fixtures/demo/feed-testnet.json'), 'utf8'));
// Real testnet RPC answers for the scene 2 dispute, recorded once (see `source` in the file).
const RECORDED: Rec[] = JSON.parse(readFileSync(here('./fixtures/rpc-scene2-testnet.json'), 'utf8')).responses;
const RESOLVE_TX = 'GvLdsJhSThMtC8M86ZkQ4wNxGsFaNV9Ny3234MsuLzBn';

/** A fetch that answers JSON-RPC from the recording; `tweak` may rewrite a response or reply with an HTTP status. */
function replayFetch(recs: Rec[], tweak: (url: string, method: string, params: any, n: number) => number | undefined = () => undefined) {
  const calls: Array<{ url: string; method: string; params: any }> = [];
  const f = async (url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body);
    calls.push({ url, method, params });
    const status = tweak(url, method, params, calls.length);
    if (status) return new Response(status === 200 ? JSON.stringify({ jsonrpc: '2.0', id: 'certo', error: { cause: { name: 'UNKNOWN_TRANSACTION' } } }) : 'slow down', { status: status === 200 ? 200 : status });
    const r = recs.find((x) => x.method === method && JSON.stringify(x.params) === JSON.stringify(params));
    if (!r) return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'certo', error: { message: 'not recorded' } }), { status: 200 });
    return new Response(JSON.stringify(r.response), { status: 200 });
  };
  return { f, calls };
}
const rpcWith = (f: unknown) => makeRpc({ fetch: f, sleep: async () => {} });
const oks = (out: any) => Object.fromEntries(out.checks.map((c: any) => [c.id, c.ok]));

describe('verify on NEAR testnet (apps/demo/web/verify.js)', () => {
  it('re-verifies the recorded scene 2 resolve: code hash, keys, events, rebuilt prompts, three signatures', async () => {
    const { f } = replayFetch(RECORDED);
    const out = await verifyOnChain(FEED, { rpc: rpcWith(f) });
    expect(out.contract).toBe('v1.certo.testnet');
    expect(out.case.resolveTx).toBe(RESOLVE_TX);
    expect(oks(out)).toEqual({ pay: true, code: true, keys: true, tx: true, epoch: true, evidence: true });
    expect(out.events.map((e: any) => e.event)).toEqual(['ballots_verified', 'dispute_resolved']);
    expect(out.jurors.map((j: any) => [j.prompt, j.answer, j.sig, j.vote, j.loggedVote, j.error])).toEqual(
      [0, 1, 2].map(() => [true, true, true, 'buyer', 'buyer', null]));
  });

  it('marks a ballot whose answer was edited after signing ✕ and leaves the other two ✓', async () => {
    const recs: Rec[] = structuredClone(RECORDED);
    const tx = recs.find((r) => r.method === 'tx' && r.params.tx_hash === RESOLVE_TX)!.response.result.transaction;
    const fc = tx.actions[0].FunctionCall;
    const args = JSON.parse(Buffer.from(fc.args, 'base64').toString('utf8'));
    args.ballots[1].response_body = args.ballots[1].response_body.replace('"content":"Y"', '"content":"X"');
    fc.args = Buffer.from(JSON.stringify(args)).toString('base64');
    const out = await verifyOnChain(FEED, { rpc: rpcWith(replayFetch(recs).f) });
    expect(out.jurors.map((j: any) => j.sig)).toEqual([true, false, true]);
    expect(out.jurors[1].answer).toBe(false);
    expect(out.jurors[1].vote).toBe('seller');
  });

  it('reports a code hash that is not the published wasm as ✕', async () => {
    const out = await verifyOnChain(FEED, { rpc: rpcWith(replayFetch(RECORDED).f), published: '00'.repeat(32) });
    expect(oks(out).code).toBe(false);
    expect(out.jurors.map((j: any) => j.sig)).toEqual([true, true, true]);
  });

  it('retries a 429 and falls back to an archival node when a transaction is gone from the regular ones', async () => {
    let n429 = 0;
    const { f, calls } = replayFetch(RECORDED, (url, method, params) => {
      if (method === 'query' && params.method_name === 'get_jurors' && n429 < 2) { n429++; return 429; }
      if (method === 'tx' && params.tx_hash === RESOLVE_TX && !url.includes('archival')) return 200; // UNKNOWN_TRANSACTION
      return undefined;
    });
    const out = await verifyOnChain(FEED, { rpc: rpcWith(f) });
    expect(n429).toBe(2);
    expect(oks(out).tx).toBe(true);
    expect(calls.some((c) => c.method === 'tx' && c.params.tx_hash === RESOLVE_TX && c.url.startsWith('https://archival-rpc.testnet.fastnear.com'))).toBe(true);
    expect(out.jurors.map((j: any) => j.sig)).toEqual([true, true, true]);
  });

  it('fails honestly when the RPC is unreachable: the failed step and its reason, no ✓', async () => {
    const out = await verifyOnChain(FEED, { rpc: rpcWith(async () => { throw new Error('offline'); }) });
    expect(out.checks).toHaveLength(1);
    expect(out.checks[0]).toMatchObject({ id: 'pay', ok: false });
    expect(out.checks[0].detail).toContain('offline');
    expect(out.jurors).toEqual([]);
  });

  it('needs a panel ruling with its transactions in the feed', async () => {
    const out = await verifyOnChain(FEED.filter((m: any) => m.kind !== 'resolved'), { rpc: rpcWith(async () => { throw new Error('no call expected'); }) });
    expect(out.checks).toEqual([expect.objectContaining({ id: 'feed', ok: false })]);
  });

  it('builds the juror prompt byte for byte like @certo/core and parses votes the same way', () => {
    expect(SYSTEM_PROMPT).toBe(CORE_PROMPT);
    const ev = { termsText: 'Top holders "fresh"\n\\ é 😀  ', requestCanon: 'GET\n/v1/holders?token=NEAR&top=5\n', responseBody: '{"token":"NEO","x":"\u0001\t"}', buyerOfferBps: 10000, sellerOfferBps: 2550 };
    for (const i of [0, 1, 2]) {
      const model = ['Qwen/Qwen3.8-27B', 'z-ai/glm-5.3-flash', 'deepseek-ai/DeepSeek-V4.1-Flash-1017'][i];
      expect(panelRequestBody(i, model, ev.termsText, ev.requestCanon, ev.responseBody, ev.buyerOfferBps, ev.sellerOfferBps))
        .toBe(buildPanelRequestFor({ jurorIndex: i, ...ev }));
    }
    const w = (c: unknown) => JSON.stringify({ choices: [{ message: { content: c } }] });
    for (const body of [w('X'), w(' Y\n'), w('<think>X</think>\nY'), w('<think>X'), w('x'), w(7), 'nope']) {
      const core = coreParseVote(body);
      expect(parseVote(body)).toBe(core === 'abstain' ? null : core);
    }
    expect(base58(fromHex('aca96429481139397fe5e265659a9fe9a85093dddf827766d58c189ec7299b71'))).toBe('CczwCf4emCBQuZ5TiEV8UjHAZPEyni3PUZDiV7rsjTTN');
  });
});
