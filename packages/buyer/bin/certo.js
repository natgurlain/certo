#!/usr/bin/env node
// Runs the TypeScript CLI through tsx (the workspace ships sources, not build output).
import { register } from 'tsx/esm/api';
register();
const { main } = await import('../src/cli.ts');
process.exitCode = await main();
