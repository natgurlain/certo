// Deploy and set up the market on NEAR testnet (docs/TESTNET.md). Idempotent:
// a step that is already done is skipped, so it is safe to run again.
//
//   npx tsx scripts/deploy-testnet.ts --dry-run                 check .env, names, keys, RPC; sends nothing
//   npx tsx scripts/deploy-testnet.ts                           deploy with the NEAR AI juror keys of fixtures/jurors.json
//   npx tsx scripts/deploy-testnet.ts --jurors synthetic        deploy with the published TEST keys (loud warning)
//   npx tsx scripts/deploy-testnet.ts --accept-gateway          first deployment only: accept gateway-signed ballots (L3-gateway)
//
// Steps: deploy res/mock_usdc.wasm and res/makegood.wasm to MAKEGOOD_TOKEN and
// MAKEGOOD_CONTRACT and call `new` (only if the account holds no code); check the
// juror keys (set_jurors with MAKEGOOD_OWNER_PRIVATE_KEY if they differ); register
// both sellers with the demo terms; top their bonds up to 50.00 and the buyers'
// balances up to 10.00. `make testnet-demo` runs the same steps before the scenes.
// Exit codes: 0 done / dry run ready, 2 configuration incomplete, 1 failure.
import { dryRun, ensureDeployed, jurorSet, loadDotEnv, readTestnetConfig } from '../apps/demo/src/testnet.ts';
import { parseArgs } from './lib/util.ts';

const args = parseArgs();
const envFile = loadDotEnv();
console.log(envFile ? `settings from ${envFile} and the environment` : 'no .env file at the repository root; settings from the environment only (cp .env.example .env)');
const cfg = readTestnetConfig();
if (args['dry-run']) process.exit(await dryRun(cfg));
if (cfg.problems.length) {
  for (const p of cfg.problems) console.error(`CONFIG: ${p}`);
  console.error('configuration incomplete; run `npx tsx scripts/deploy-testnet.ts --dry-run` and see docs/TESTNET.md');
  process.exit(2);
}
const kind = String(args.jurors ?? process.env.TESTNET_JURORS ?? 'real');
if (kind !== 'real' && kind !== 'synthetic') {
  console.error(`--jurors must be real or synthetic, got ${kind}`);
  process.exit(2);
}
try {
  const d = await ensureDeployed(cfg, jurorSet(kind, args['accept-gateway'] === true));
  console.log(`DEPLOY OK: contract ${cfg.accounts.contract.accountId}, token ${cfg.accounts.token.accountId}, ${kind} juror keys; ${d.txs.length} transaction(s) sent this run`);
} catch (e) {
  console.error(`DEPLOY FAILED: ${(e as Error).message}`);
  process.exit(1);
}
