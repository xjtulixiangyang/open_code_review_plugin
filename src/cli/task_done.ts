#!/usr/bin/env node
import { parseToolArgs } from '../core/tools/args.js';
import { parseTaskDone, parseStructuredCompletion } from '../core/tools/task_done.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { markDone, resolveExistingRunDir } from '../core/runs/store.js';
import { Orchestrator } from '../core/orchestrator/orchestrator.js';

async function main(): Promise<void> {
  const { runId, args } = parseToolArgs(process.argv.slice(2));

  // Structured completion mode: when taskId is present, use the orchestrator
  const resolvedRunDir = await resolveExistingRunDir(runId);
  if (typeof args['taskId'] === 'string' && args['taskId'].trim().length > 0) {
    if (!resolvedRunDir) throw new Error(`Run directory not found for ${runId}`);
    const parsed = parseStructuredCompletion(args, runId);
    const orchestrator = new Orchestrator(resolvedRunDir);
    const result = await orchestrator.acceptCompletion(parsed);
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  if (resolvedRunDir) {
    try {
      const run = JSON.parse(await readFile(join(resolvedRunDir, 'run.json'), 'utf8')) as { schemaVersion?: unknown };
      if (run.schemaVersion === 1) {
        throw new Error('Schema-1 run requires structured task_done credentials and outcome');
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  // Legacy mode: no taskId and no schema-1 run record
  const { subagent, file } = parseTaskDone(args);
  await markDone(runId, subagent, file);
  process.stdout.write(JSON.stringify({ ok: true, subagent, file }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[task_done] ${err?.message ?? err}\n`);
  process.exit(2);
});
