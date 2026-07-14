#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readContext,
  readComments,
  readFilterResults,
  readRelocationResults,
  readEvents,
  listDone,
  writeReport,
  resolveExistingRunDir,
} from '../core/runs/store.js';
import { renderMarkdownReport } from '../core/report/markdown.js';
import { renderJsonReport } from '../core/report/json.js';
import { Orchestrator } from '../core/orchestrator/orchestrator.js';
import { manifestDigest } from '../core/orchestrator/fingerprint.js';
import { isTaskFilename, ORCHESTRATOR_SCHEMA_VERSION } from '../core/orchestrator/types.js';
import type { ReviewManifest, RunRecord, TaskRecord } from '../core/orchestrator/types.js';
import type { ReviewContext } from '../core/model/request.js';
import type { CommentRecord } from '../core/model/comment.js';
import type { RelocationWarning } from '../core/model/relocation.js';
import type { ReportWarning } from '../core/report/json.js';

interface ToolCallEvent {
  type?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

function eventWarnings(events: ToolCallEvent[]): ReportWarning[] {
  const warnings: ReportWarning[] = [];
  for (const event of events) {
    if (event.type !== 'tool_call' || event.tool !== 'code_comment') continue;
    const args = event.args ?? {};
    if (typeof args.path !== 'string' || typeof args.subagent !== 'string') {
      warnings.push({
        path: typeof args.path === 'string' ? args.path : '<unknown>',
        reason: 'malformed code_comment tool call: missing parsed path/subagent; comment may have been dropped',
      });
    }
  }
  return warnings;
}

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] ?? '';
      out[k] = v;
      i++;
    }
  }
  return out;
}

class StrictAggregateError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(`OCRP-AGG-STRICT: ${message}`);
  }
}

function strictFail(message: string): never {
  throw new StrictAggregateError(message);
}

async function readRunRecordForAggregate(runDir: string): Promise<{ kind: 'legacy' } | { kind: 'schema1'; run: RunRecord }> {
  let raw: string;
  try {
    raw = await readFile(join(runDir, 'run.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'legacy' };
    strictFail(`cannot read run.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: Partial<RunRecord>;
  try {
    parsed = JSON.parse(raw) as Partial<RunRecord>;
  } catch (err) {
    strictFail(`malformed run.json: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.schemaVersion !== ORCHESTRATOR_SCHEMA_VERSION) {
    strictFail(`unsupported or missing run.json schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (parsed.state !== 'active' && parsed.state !== 'superseded' && parsed.state !== 'failed' && parsed.state !== 'completed') {
    strictFail(`unknown run state: ${String(parsed.state)}`);
  }
  return { kind: 'schema1', run: parsed as RunRecord };
}

async function readManifestStrict(runDir: string): Promise<ReviewManifest> {
  try {
    const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as ReviewManifest;
    if (manifest.schemaVersion !== ORCHESTRATOR_SCHEMA_VERSION) strictFail('manifest is not schema-1');
    return manifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') strictFail('schema-1 run is missing manifest.json');
    throw err;
  }
}

async function readTasksStrictForAggregate(runDir: string): Promise<TaskRecord[]> {
  const tasksDir = join(runDir, 'tasks');
  let names: string[];
  try {
    names = await readdir(tasksDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const tasks: TaskRecord[] = [];
  for (const name of names) {
    if (!isTaskFilename(name)) continue;
    tasks.push(JSON.parse(await readFile(join(tasksDir, name), 'utf8')) as TaskRecord);
  }
  return tasks;
}

function validateStrictSnapshot(run: RunRecord, manifest: ReviewManifest, tasks: TaskRecord[]): void {
  if (run.runId !== manifest.runId) strictFail(`runId mismatch between run.json and manifest.json`);
  if (run.manifestDigest !== manifestDigest(manifest)) strictFail('run manifestDigest does not match manifest.json');
  if (run.repoIdentity !== manifest.repoIdentity) strictFail('run repoIdentity does not match manifest.json');
  if (run.argsFingerprint !== manifest.argsFingerprint) strictFail('run argsFingerprint does not match manifest.json');
  if (run.diffFingerprint !== manifest.diffFingerprint) strictFail('run diffFingerprint does not match manifest.json');
  if (tasks.length !== manifest.files.length) strictFail(`task count ${tasks.length} does not match manifest file count ${manifest.files.length}`);

  const byIndex = new Map<number, TaskRecord>();
  const byTaskId = new Set<string>();
  for (const task of tasks) {
    if (task.runId !== run.runId) strictFail(`task ${task.taskId} runId mismatch`);
    if (byTaskId.has(task.taskId)) strictFail(`duplicate taskId ${task.taskId}`);
    byTaskId.add(task.taskId);
    if (byIndex.has(task.manifestIndex)) strictFail(`duplicate task manifestIndex ${task.manifestIndex}`);
    byIndex.set(task.manifestIndex, task);
  }

  for (const file of manifest.files) {
    const task = byIndex.get(file.manifestIndex);
    if (!task) strictFail(`missing task for manifestIndex ${file.manifestIndex}`);
    if (task.filePath !== file.path) strictFail(`task path mismatch for manifestIndex ${file.manifestIndex}`);
    if (task.diffFingerprint !== file.diffFingerprint) strictFail(`task diffFingerprint mismatch for ${file.path}`);
  }

  const counts = countTasks(tasks);
  if (run.state === 'completed' && (counts.failed > 0 || counts.queued > 0 || counts.leased > 0 || counts.running > 0)) {
    strictFail('run.json claims completed but not all tasks succeeded');
  }
  if (run.state === 'failed' && (counts.queued > 0 || counts.leased > 0 || counts.running > 0 || counts.failed === 0)) {
    strictFail('run.json claims failed but tasks are not in failed terminal state');
  }
}

function countTasks(tasks: TaskRecord[]): { queued: number; leased: number; running: number; succeeded: number; failed: number } {
  const counts = { queued: 0, leased: 0, running: 0, succeeded: 0, failed: 0 };
  for (const task of tasks) {
    if (task.state !== 'queued' && task.state !== 'leased' && task.state !== 'running' && task.state !== 'succeeded' && task.state !== 'failed') {
      strictFail(`unknown task state for ${task.taskId}: ${String(task.state)}`);
    }
    counts[task.state]++;
  }
  return counts;
}

function failedTaskDetails(tasks: TaskRecord[]): Array<{ path: string; attemptsUsed: number; maxAttempts: number; reason: string }> {
  return tasks
    .filter((task) => task.state === 'failed')
    .sort((a, b) => a.manifestIndex - b.manifestIndex)
    .map((task) => ({
      path: task.filePath,
      attemptsUsed: task.attemptsUsed,
      maxAttempts: task.maxAttempts,
      reason: task.failureReason ?? 'unknown',
    }));
}

async function main(): Promise<void> {
  const start = Date.now();
  const f = parseFlags(process.argv.slice(2));
  if (!f.runId) {
    process.stderr.write('[ocr-aggregate] missing --runId\n');
    process.exit(2);
  }
  const format = f.format ?? 'both';

  const ctx = await readContext<ReviewContext>(f.runId);
  const events = await readEvents<ToolCallEvent>(f.runId);
  const warnings = eventWarnings(events);

  // -----------------------------------------------------------------------
  // Schema-1 detection — read run.json directly for authoritative state
  // -----------------------------------------------------------------------
  const runDir = await resolveExistingRunDir(f.runId);
  if (!runDir) strictFail(`run directory not found: ${f.runId}`);
  const runSource = await readRunRecordForAggregate(runDir);
  let schema1State: RunRecord['state'] | null = null;
  let orchestrator: Orchestrator | null = null;
  let schema1Tasks: TaskRecord[] = [];
  let schema1Manifest: ReviewManifest | null = null;
  if (runSource.kind === 'schema1') {
    schema1State = runSource.run.state;
    schema1Manifest = await readManifestStrict(runDir);
    schema1Tasks = await readTasksStrictForAggregate(runDir);
    validateStrictSnapshot(runSource.run, schema1Manifest, schema1Tasks);
    orchestrator = new Orchestrator(runDir);
  }

  // -----------------------------------------------------------------------
  // Read comments and determine partial files
  // -----------------------------------------------------------------------
  let rawComments: CommentRecord[];
  let partialFiles: string[];
  let failedDiagnostic: {
    expected: number;
    succeeded: number;
    failed: number;
    taskCounts: ReturnType<typeof countTasks>;
    failedFiles: ReturnType<typeof failedTaskDetails>;
  } | null = null;

  if (schema1State !== null && orchestrator) {
    // Schema-1 strict aggregation
    if (schema1State === 'active' || schema1State === 'superseded') {
      process.stderr.write(
        `[ocr-aggregate] Run ${f.runId} is ${schema1State}; aggregation requires completed or failed state\n`,
      );
      process.exit(2);
    }

    const accepted = await orchestrator.readAcceptedComments();
    rawComments = accepted.comments;
    partialFiles = accepted.partialFiles;
    if (schema1State === 'failed') {
      const taskCounts = countTasks(schema1Tasks);
      failedDiagnostic = {
        expected: schema1Manifest!.files.length,
        succeeded: taskCounts.succeeded,
        failed: taskCounts.failed,
        taskCounts,
        failedFiles: failedTaskDetails(schema1Tasks),
      };
    }
  } else {
    // Old-schema legacy path
    rawComments = await readComments<CommentRecord>(f.runId);
    const dones = await listDone(f.runId);
    const doneFiles = new Set(dones.map((d) => d.file));
    const expected = new Set(ctx.files.map((x) => x.path));
    partialFiles = [];
    for (const p of expected) if (!doneFiles.has(p)) partialFiles.push(p);
  }

  // -----------------------------------------------------------------------
  // Shared filter pipeline
  // -----------------------------------------------------------------------
  const filters = await readFilterResults(f.runId);
  const contextPaths = new Set(ctx.files.map((file) => file.path));
  const commentById = new Map(rawComments.map((comment) => [comment.comment_id, comment]));
  const hiddenIds = new Set<string>();
  const filterWarnings = [...filters.warnings];
  for (const result of filters.results) {
    if (!contextPaths.has(result.path)) {
      filterWarnings.push({ kind: 'filter_path_out_of_scope', path: result.path, detail: 'filter result path is not in review context' });
      continue;
    }
    for (const decision of result.decisions) {
      const comment = commentById.get(decision.comment_id);
      if (!comment) {
        filterWarnings.push({ kind: 'filter_comment_missing', path: result.path, detail: `comment_id not found: ${decision.comment_id}` });
        continue;
      }
      if (comment.path !== result.path) {
        filterWarnings.push({ kind: 'filter_comment_path_mismatch', path: result.path, detail: `comment_id belongs to ${comment.path}: ${decision.comment_id}` });
        continue;
      }
      hiddenIds.add(decision.comment_id);
    }
  }
  const comments = rawComments.filter((comment) => !hiddenIds.has(comment.comment_id));
  const filteredCommentCount = rawComments.length - comments.length;

  // -----------------------------------------------------------------------
  // Shared relocation pipeline
  // -----------------------------------------------------------------------
  const relocationData = await readRelocationResults(f.runId);
  const relocationWarnings: RelocationWarning[] = [...relocationData.warnings];
  let relocatedCount = 0;
  let relocationFallbackCount = 0;

  // Build a map: path -> Map<comment_id, RelocationDecision>
  const relocByPath = new Map<string, Map<string, { resolved_start_line: number; resolved_end_line: number; source: string }>>();
  for (const result of relocationData.results) {
    const pathMap = new Map<string, { resolved_start_line: number; resolved_end_line: number; source: string }>();
    for (const decision of result.decisions) {
      pathMap.set(decision.comment_id, {
        resolved_start_line: decision.resolved_start_line,
        resolved_end_line: decision.resolved_end_line,
        source: decision.source,
      });
    }
    relocByPath.set(result.path, pathMap);
  }

  // Apply relocations to visible comments
  for (const comment of comments) {
    const pathMap = relocByPath.get(comment.path);
    if (!pathMap) continue;
    const decision = pathMap.get(comment.comment_id);
    if (!decision) continue;
    comment.start_line = decision.resolved_start_line;
    comment.end_line = decision.resolved_end_line;
    if (decision.source === 'fallback_original') {
      relocationFallbackCount++;
    } else if (decision.source !== 'unchanged') {
      relocatedCount++;
    }
  }

  // Check for unknown/mismatched decisions
  for (const result of relocationData.results) {
    const pathComments = comments.filter((c) => c.path === result.path);
    const pathCommentIds = new Set(pathComments.map((c) => c.comment_id));
    for (const decision of result.decisions) {
      if (!pathCommentIds.has(decision.comment_id)) {
        relocationWarnings.push({
          kind: 'relocation_comment_missing',
          path: result.path,
          comment_id: decision.comment_id,
          detail: `relocation decision references unknown or hidden comment_id: ${decision.comment_id}`,
        });
      }
    }
  }

  const dur = Date.now() - start;

  if (format === 'markdown' || format === 'both') {
    let md = renderMarkdownReport(ctx, comments, {
      partialFiles,
      rawCommentCount: rawComments.length,
      filteredCommentCount,
      relocatedCount,
      relocationFallbackCount,
      warnings,
    });
    if (failedDiagnostic) {
      md += [
        '',
        '## Failed files',
        '',
        `Expected tasks: ${failedDiagnostic.expected}`,
        `Succeeded tasks: ${failedDiagnostic.succeeded}`,
        `Failed tasks: ${failedDiagnostic.failed}`,
        '',
        ...failedDiagnostic.failedFiles.map((file) => `- \`${file.path}\` — ${file.reason} (attempts ${file.attemptsUsed}/${file.maxAttempts})`),
        '',
      ].join('\n');
    }
    await writeReport(f.runId, 'report.md', md);
  }
  if (format === 'json' || format === 'both') {
    const parsed = JSON.parse(renderJsonReport(ctx, comments, {
      partialFiles,
      durationMs: dur,
      rawCommentCount: rawComments.length,
      filteredCommentCount,
      filterWarnings,
      relocatedCount,
      relocationFallbackCount,
      relocationWarnings,
      warnings,
    }));
    const j = failedDiagnostic
      ? JSON.stringify({
        ...parsed,
        status: 'completed_with_errors',
        state: 'failed',
        partial: true,
        expected: failedDiagnostic.expected,
        succeeded: failedDiagnostic.succeeded,
        failed: failedDiagnostic.failed,
        taskCounts: failedDiagnostic.taskCounts,
        failedFiles: failedDiagnostic.failedFiles,
        message: 'Review run failed; some tasks did not complete successfully',
      }, null, 2)
      : JSON.stringify(parsed, null, 2);
    await writeReport(f.runId, 'report.json', j);
  }
  const summary = {
    runId: f.runId,
    reportMd: `.ocr-runs/${f.runId}/report.md`,
    reportJson: `.ocr-runs/${f.runId}/report.json`,
    partial: partialFiles.length > 0,
    filesReviewed: ctx.files.length,
    rawCommentCount: rawComments.length,
    commentCount: comments.length,
    filteredCommentCount,
    filterWarnings,
    relocationWarnings,
    eventWarnings: warnings,
    partialFiles,
    ...(failedDiagnostic ? {
      expected: failedDiagnostic.expected,
      succeeded: failedDiagnostic.succeeded,
      failed: failedDiagnostic.failed,
      failedFiles: failedDiagnostic.failedFiles,
    } : {}),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  if (failedDiagnostic) process.exitCode = 1;
}

main().catch((err) => {
  process.stderr.write(`[ocr-aggregate] ${err?.message ?? err}\n`);
  process.exit(err instanceof StrictAggregateError ? err.exitCode : 1);
});
