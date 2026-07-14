#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseToolArgs } from '../core/tools/args.js';
import { parseComments, persistComments } from '../core/tools/code_comment.js';
import { Orchestrator } from '../core/orchestrator/orchestrator.js';
import type { AttemptCredentials } from '../core/orchestrator/types.js';
import { resolveExistingRunDir } from '../core/runs/store.js';

async function main(): Promise<void> {
  const { runId, args } = parseToolArgs(process.argv.slice(2));
  const { records, error } = parseComments(args);
  if (error) {
    process.stdout.write(error + '\n');
    return;
  }

  // Check for structured credential fields
  const hasTaskId = typeof args['taskId'] === 'string' && (args['taskId'] as string) !== '';
  const hasAttemptId = typeof args['attemptId'] === 'string' && (args['attemptId'] as string) !== '';
  const hasLeaseToken = typeof args['leaseToken'] === 'string' && (args['leaseToken'] as string) !== '';
  const hasFilePath = typeof args['filePath'] === 'string' && (args['filePath'] as string) !== '';
  const hasDiffFingerprint = typeof args['diffFingerprint'] === 'string' && (args['diffFingerprint'] as string) !== '';

  const anyCredential = hasTaskId || hasAttemptId || hasLeaseToken || hasFilePath || hasDiffFingerprint;
  const allCredentials = hasTaskId && hasAttemptId && hasLeaseToken && hasFilePath && hasDiffFingerprint;

  if (anyCredential && !allCredentials) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'Partial structured credentials: all fields taskId, attemptId, leaseToken, filePath, diffFingerprint are required',
    }) + '\n');
    return;
  }

  if (allCredentials) {
    // Structured mode: use orchestrator
    const filePath = args['filePath'] as string;
    const path = typeof args['path'] === 'string' ? (args['path'] as string) : '';

    // path and filePath must agree
    if (path && path !== filePath) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `path (${path}) and filePath (${filePath}) must match`,
      }) + '\n');
      return;
    }

    const credentials: AttemptCredentials = {
      taskId: args['taskId'] as string,
      attemptId: args['attemptId'] as string,
      leaseToken: args['leaseToken'] as string,
      filePath,
      diffFingerprint: args['diffFingerprint'] as string,
    };

    // Resolve orchestrator run directory
    const runDir = await resolveExistingRunDir(runId);
    if (!runDir) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: `Run directory not found for ${runId}`,
      }) + '\n');
      return;
    }

    const orchestrator = new Orchestrator(runDir);
    try {
      const commentIds = await orchestrator.stageComments(credentials, records);
      process.stdout.write(JSON.stringify({
        ok: true,
        count: commentIds.length,
        comment_ids: commentIds,
      }) + '\n');
    } catch (err) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: (err as Error).message,
      }) + '\n');
    }
    return;
  }

  // Legacy mode: no credential fields
  // Check if run.json exists with schemaVersion === 1
  const runDir = await resolveExistingRunDir(runId);
  if (runDir) {
    try {
      const runJsonPath = join(runDir, 'run.json');
      const runData = JSON.parse(await readFile(runJsonPath, 'utf-8'));
      if (runData.schemaVersion === 1) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: 'Schema-1 run requires structured credentials (taskId, attemptId, leaseToken, filePath, diffFingerprint)',
        }) + '\n');
        return;
      }
    } catch {
      // run.json doesn't exist or unparseable — legacy mode allowed
    }
  }

  // Legacy: use existing persistComments
  const ids = await persistComments(runId, records);
  process.stdout.write(JSON.stringify({ ok: true, count: ids.length, comment_ids: ids }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[code_comment] ${err?.message ?? err}\n`);
  process.exit(2);
});
