// One-off: re-records the testnet RPC answers verify.js needs for fixtures/demo/feed-testnet.json.
//   npx tsx apps/demo/test/record-verify-rpc.ts
import { readFileSync, writeFileSync } from 'node:fs';
// @ts-expect-error plain ES module of the page
import { makeRpc, verifyOnChain } from '../web/verify.js';
const here = (p: string) => new URL(p, import.meta.url);
const feed = JSON.parse(readFileSync(here('../../../fixtures/demo/feed-testnet.json'), 'utf8'));
const responses: Array<{ method: string; params: unknown; response: unknown }> = [];
const rec = async (url: string, init: { body: string }) => {
  const r = await fetch(url, init as RequestInit);
  const text = await r.text();
  if (r.status === 200) { const { method, params } = JSON.parse(init.body); const response = JSON.parse(text); if (!response.error) responses.push({ method, params, response }); }
  return new Response(text, { status: r.status });
};
const out = await verifyOnChain(feed, { rpc: makeRpc({ fetch: rec }) });
const bad = out.checks.filter((c: { ok: boolean }) => !c.ok);
console.log(`checks ${out.checks.length}, failed ${bad.length}; jurors valid ${out.jurors.filter((j: { sigOk: boolean }) => j.sigOk).length}`);
if (bad.length) { console.log(bad); process.exit(1); }
writeFileSync(here('./fixtures/rpc-scene2-testnet.json'), JSON.stringify({ source: `NEAR testnet JSON-RPC responses for the scene 2 dispute of fixtures/demo/feed-testnet.json, recorded ${new Date().toISOString().slice(0, 10)} by apps/demo/test/record-verify-rpc.ts through apps/demo/web/verify.js`, responses }, null, 1) + '\n');
console.log(`recorded ${responses.length} responses`);
