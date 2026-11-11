#!/usr/bin/env node
// stdio MCP server; runs the TypeScript sources through tsx.
import { register } from 'tsx/esm/api';
register();
const { main } = await import('../src/main.ts');
await main();
