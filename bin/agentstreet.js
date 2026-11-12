#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cli = new URL('../dist/cli.js', import.meta.url);
if (!existsSync(fileURLToPath(cli))) {
  console.error('agentstreet: dist/ is missing. Run "npm run build" first.');
  process.exit(1);
}
const { main } = await import(cli.href);
main().catch((e) => {
  console.error(`agentstreet: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
