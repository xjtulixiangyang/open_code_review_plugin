#!/usr/bin/env node
import { parseToolArgs } from '../core/tools/args.js';
import { parseTaskDone, parseStructuredCompletion } from '../core/tools/task_done.js';
import { markDone } from '../core/runs/store.js';
import { Orchestrator } from '../core/orchestrator/orchestrator.js';

async function main(): Promise<void> {
  const { runId, args } = parseToolArgs(process.argv.slice(2));

  // Structured completion mode: when taskId is present, use the orchestrator
  if (typeof args['taskId'] === 'string' && args['taskId'].trim().length > 0) {
    const parsed = parseStructuredCompletion(args, runId);
    const orchestrator = new Orchestrator(process.cwd());
    const result = await orchestrator.acceptCompletion(parsed);
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  // Legacy mode: no taskId — use markDone
  const { subagent, file } = parseTaskDone(args);
  await markDone(runId, subagent, file);
  process.stdout.write(JSON.stringify({ ok: true, subagent, file }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[task_done] ${err?.message ?? err}\n`);
  process.exit(2);
});
