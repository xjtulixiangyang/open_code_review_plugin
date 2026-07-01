#!/usr/bin/env node
import { parseToolArgs } from '../core/tools/args.js';
import { parseTaskDone } from '../core/tools/task_done.js';
import { markDone } from '../core/runs/store.js';

async function main(): Promise<void> {
  const { runId, args } = parseToolArgs(process.argv.slice(2));
  const { subagent, file } = parseTaskDone(args);
  await markDone(runId, subagent, file);
  process.stdout.write(JSON.stringify({ ok: true, subagent, file }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[task_done] ${err?.message ?? err}\n`);
  process.exit(2);
});
