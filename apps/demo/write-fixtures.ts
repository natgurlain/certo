// Writes the derived demo fixtures from fixtures/demo/demo.json:
//   fixtures/demo/cases.jsonl        the two panel cases of scenes 2 and 3 (read by `make record`)
//   fixtures/jurors.synthetic.json   the deterministic TEST juror keys of replay-synthetic mode
// With --synthetic it also writes synthetic ballots for those cases into fixtures/panel/
// (scripts/record.ts --synthetic; a real recording is never replaced).
//
//   npx tsx apps/demo/write-fixtures.ts [--synthetic]
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { demoCases, syntheticJurorsFile } from './src/fixtures.js';
import { REPO_ROOT, repoFile } from './src/sandbox.js';

writeFileSync(repoFile('fixtures/demo/cases.jsonl'), demoCases().map((c) => JSON.stringify(c)).join('\n') + '\n');
writeFileSync(repoFile('fixtures/jurors.synthetic.json'), JSON.stringify(syntheticJurorsFile(), null, 2) + '\n');
console.log('wrote fixtures/demo/cases.jsonl and fixtures/jurors.synthetic.json');

if (process.argv.includes('--synthetic')) {
  const r = spawnSync('npx', ['tsx', 'scripts/record.ts', '--synthetic', '--cases', 'fixtures/demo/cases.jsonl'], { cwd: REPO_ROOT, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
