// `make demo`: the scenes of DESIGN 5.5 on a local NEAR sandbox.
// `make playground` (= --keep-open): the same, then everything stays up for an agent to try.
// `make testnet-demo` (NEAR_NETWORK=testnet): the same scenes on NEAR testnet (docs/TESTNET.md).
//
//   npx tsx apps/demo/run.ts [--keep-open] [--feed-out <path>]
//   NEAR_NETWORK=testnet npx tsx apps/demo/run.ts [--dry-run] [--keep-open] [--feed-out <path>]
//
// Serves the page and the event feed (apps/demo/EVENTS.md) at http://localhost:4020
// (DEMO_PORT to change). Panel mode: live with PANEL_MODE=live and NEARAI_API_KEY (the playground:
// NEARAI_API_KEY alone);
// otherwise replay of fixtures/panel/ (real recordings) or replay-synthetic (TEST keys).
// The feed is saved as feed.json ($CERTO_HOME/demo/feed.json, default ~/.certo; --feed-out
// to choose), which the page plays when served as static files (apps/demo/web/ + feed.json).
// --keep-open (alias --playground) keeps the page, the feed, the sellers, the panel and, on the
// sandbox, the chain up after the run with a funded buyer `agent`, and writes
// $CERTO_HOME/playground.env for `certo-mcp --playground` (deleted on exit). Ctrl-C stops it.
// On testnet, accounts and keys come from .env; the market is deployed or topped up
// first (idempotent, as scripts/deploy-testnet.ts); --dry-run only checks the
// configuration with read-only view_account queries and sends nothing.
import { join } from 'node:path';
import { ACCOUNTS, runDemo } from './src/demo.js';
import { certoHome, playgroundBanner, writePlaygroundEnv } from './src/playground.js';
import { dryRun, loadDotEnv, readTestnetConfig, type TestnetConfig } from './src/testnet.js';

const network = process.env.NEAR_NETWORK || 'sandbox';
if (network !== 'sandbox' && network !== 'testnet') {
  console.error(`NEAR_NETWORK=${network}: this runner supports sandbox and testnet only`);
  process.exit(2);
}
let testnet: TestnetConfig | undefined;
if (network === 'testnet') {
  const envFile = loadDotEnv();
  console.log(envFile ? `testnet settings from ${envFile} and the environment` : 'no .env file at the repository root; testnet settings from the environment only (cp .env.example .env)');
  testnet = readTestnetConfig();
  if (process.argv.includes('--dry-run')) process.exit(await dryRun(testnet));
  if (testnet.problems.length) {
    for (const p of testnet.problems) console.error(`CONFIG: ${p}`);
    console.error('testnet configuration incomplete: fill .env (docs/TESTNET.md) and check it with `NEAR_NETWORK=testnet npx tsx apps/demo/run.ts --dry-run`');
    process.exit(2);
  }
} else if (process.argv.includes('--dry-run')) {
  console.error('--dry-run applies to the testnet path only (NEAR_NETWORK=testnet)');
  process.exit(2);
}
const keepOpen = process.argv.includes('--keep-open') || process.argv.includes('--playground');
const feedOutAt = process.argv.indexOf('--feed-out');
const feedOut = feedOutAt > 0 ? process.argv[feedOutAt + 1] : join(certoHome(), 'demo', 'feed.json');
if (!feedOut || feedOut.startsWith('--')) {
  console.error('--feed-out needs a path');
  process.exit(2);
}
// in the playground, NEARAI_API_KEY makes the panel ask NEAR AI live (choosePanel reads PANEL_MODE); `make demo` stays on replay
const env = { ...process.env, ...(keepOpen && process.env.NEARAI_API_KEY && !process.env.PANEL_MODE ? { PANEL_MODE: 'live' } : {}) };
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(130)); // 'exit' handlers stop the sandbox, delete playground.env
const demoPort = Number(process.env.DEMO_PORT ?? 4020);
const r = await runDemo({
  port: demoPort, network, testnet, env,
  // fixed seller ports in the playground, so the example prompts stay the same between runs
  ...(keepOpen ? { sellerPorts: { chainfacts: demoPort + 10, cheapfacts: demoPort + 11 } } : {}),
}).catch((e: Error) => {
  console.error(`DEMO FAILED: ${e.message}`);
  process.exit(1);
});
console.log(`(${(r.elapsedMs / 1000).toFixed(1)} s)`);
r.feed.save(feedOut);
console.log(`feed saved: ${feedOut} (the page plays it from static files: copy apps/demo/web/ and put it next to index.html as feed.json)`);
if (!keepOpen) {
  await r.shutdown();
  process.exit(r.ok ? 0 : 1);
}
await r.reviveSellers();
r.watchAgent();
const pageUrl = r.port !== null ? `http://localhost:${r.port}` : null;
if (r.world.local) {
  const chain = r.world.local.chain;
  const envPath = writePlaygroundEnv({
    rpcUrl: chain.rpcUrl, contract: r.world.contract, token: r.world.token,
    buyer: ACCOUNTS.agent, buyerPrivateKey: chain.key(ACCOUNTS.agent).privateKey, panelUrl: r.panelUrl, exampleUrls: r.exampleUrls,
  });
  for (const l of playgroundBanner({ pageUrl, envPath, exampleUrls: r.exampleUrls })) console.log(l);
} else {
  console.log(`--keep-open: page, feed, sellers and panel stay up${pageUrl ? ` at ${pageUrl}` : ''} (Ctrl-C to stop); no playground.env on ${network}`);
}
