#!/usr/bin/env node
import { parseToolArgs } from '../core/tools/args.js';
import { findFiles } from '../core/tools/file_find.js';
import { readContext } from '../core/runs/store.js';
import type { ReviewContext } from '../core/model/request.js';

async function main(): Promise<void> {
  const { runId, args } = parseToolArgs(process.argv.slice(2));
  const ctx = await readContext<ReviewContext>(runId);
  const result = await findFiles(args, ctx);
  process.stdout.write(result + (result.endsWith('\n') ? '' : '\n'));
}

main().catch((err) => {
  process.stderr.write(`[file_find] ${err?.message ?? err}\n`);
  process.exit(2);
});
