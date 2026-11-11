// `make demo`: the four scenes of DESIGN 5.5 on a local NEAR sandbox.
// `make testnet-demo` (NEAR_NETWORK=testnet): the same scenes on NEAR testnet (docs/TESTNET.md).
//
//   npx tsx apps/demo/run.ts [--keep-open]
//   NEAR_NETWORK=testnet npx tsx apps/demo/run.ts [--dry-run] [--keep-open]
//
// Serves the page and the event feed (apps/demo/EVENTS.md) at http://localhost:4020
// (DEMO_PORT to change). Panel mode: live with PANEL_MODE=live and NEARAI_API_KEY;
// otherwise replay of fixtures/panel/ (real recordings) or replay-synthetic (TEST keys).
// --keep-open keeps the page and feed up after the run (Ctrl-C to stop).
// On testnet, accounts and keys come from .env; the market is deployed or topped up
// first (idempotent, as scripts/deploy-testnet.ts); --dry-run only checks the
// configuration with read-only view_account queries and sends nothing.
import { runDemo } from './src/demo.js';
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
const keepOpen = process.argv.includes('--keep-open');
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(130)); // 'exit' handlers stop the sandbox
const r = await runDemo({ port: Number(process.env.DEMO_PORT ?? 4020), network, testnet }).catch((e: Error) => {
  console.error(`DEMO FAILED: ${e.message}`);
  process.exit(1);
});
console.log(`(${(r.elapsedMs / 1000).toFixed(1)} s)`);
await r.shutdown({ keepFeed: keepOpen && r.port !== null });
if (keepOpen && r.port !== null) {
  console.log(`--keep-open: page and feed stay up at http://localhost:${r.port} (Ctrl-C to stop)`);
} else {
  process.exit(r.ok ? 0 : 1);
}
