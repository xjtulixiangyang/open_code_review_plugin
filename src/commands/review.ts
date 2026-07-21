#!/usr/bin/env node
/**
 * review.ts — Deterministic review orchestration engine.
 *
 * Invoked from the commands/review.md thin shell as:
 *   node ${CLAUDE_PLUGIN_ROOT}/dist/commands/review.mjs $ARGUMENTS
 *
 * All scheduling, retry, and completeness decisions are made here in TypeScript.
 * The host (LLM) is only responsible for mechanical execution of the returned
 * JSON protocol: spawning reviewers, acknowledging dispatch, and waiting.
 *
 * Protocol phases:
 *   "dispatch" — host spawns one ocr-reviewer agent per claim, acks each
 *   "wait"     — host waits until waitUntil, then re-runs with --runId
 *   "done"     — host presents the report and exits
 */

import { parseArgs, normalizeConcurrency } from '../cli/prepare.js';
import { buildReviewContext } from '../core/context/review_context.js';
import {
  writeContext, writeLaunchConfig, resolveExistingRunDir,
  readContext, readLaunchConfig, writeReport, appendComment,
  readFilterResults, readRelocationResults, readEvents,
} from '../core/runs/store.js';
import { startCandidate } from '../core/orchestrator/manifest.js';
import { Orchestrator } from '../core/orchestrator/orchestrator.js';
import { DEFAULT_LEASE_DURATION_MS, DEFAULT_MAX_ATTEMPTS } from '../core/orchestrator/types.js';
import type { TaskRecord } from '../core/orchestrator/types.js';
import type { LaunchConfig, ClaimResult, TaskCounts, ReconcileResult } from '../core/orchestrator/types.js';
import type { ReviewRequest, ReviewContext } from '../core/model/request.js';
import { renderMarkdownReport } from '../core/report/markdown.js';
import { renderJsonReport } from '../core/report/json.js';
import { MAX_FILES_PER_RUN } from '../core/prompts/constants.js';

// ---------------------------------------------------------------------------
// Output protocol types (JSON to stdout, consumed by commands/review.md)
// ---------------------------------------------------------------------------

interface DispatchPhase {
  phase: 'dispatch';
  runId: string;
  effectiveRunId: string;
  state: string;
  fileCount: number;
  taskCounts: TaskCounts;
  claims: ClaimResult[];
  /** Arguments to pass on the next invocation so review.ts can resume. */
  reRunArgs: string;
}

interface WaitPhase {
  phase: 'wait';
  runId: string;
  effectiveRunId: string;
  state: string;
  taskCounts: TaskCounts;
  /** ISO-8601 timestamp — the host should sleep until this moment. */
  waitUntil: string;
  /** Human-readable reason for the wait. */
  reason: string;
  reRunArgs: string;
}

interface FailedFileDetail {
  path: string;
  attemptsUsed: number;
  maxAttempts: number;
  reason: string;
}

interface DonePhase {
  phase: 'done';
  runId: string;
  effectiveRunId: string;
  success: boolean;
  partial: boolean;
  fileCount: number;
  taskCounts: TaskCounts;
  reportMdPath?: string;
  reportJsonPath?: string;
  summary: string;
  failedFiles?: FailedFileDetail[];
}

type ReviewOutput = DispatchPhase | WaitPhase | DonePhase;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function output(data: ReviewOutput): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function error(message: string, runId?: string): void {
  const err: Record<string, unknown> = { phase: 'error', message };
  if (runId) err.runId = runId;
  process.stderr.write(JSON.stringify(err) + '\n');
}

function extractExplicitRunId(argv: string[]): string | undefined {
  const idx = argv.indexOf('--runId');
  return idx >= 0 ? argv[idx + 1] : undefined;
}

/**
 * Derive failed file details from authoritative task records.
 */
function buildFailedFileDetails(tasks: TaskRecord[]): FailedFileDetail[] {
  return tasks
    .filter((t) => t.state === 'failed')
    .sort((a, b) => a.manifestIndex - b.manifestIndex)
    .map((t) => ({
      path: t.filePath,
      attemptsUsed: t.attemptsUsed,
      maxAttempts: t.maxAttempts,
      reason: t.failureReason ?? 'unknown',
    }));
}

// ---------------------------------------------------------------------------
// Phase: Prepare + Start
// ---------------------------------------------------------------------------

interface PrepareStartResult {
  effectiveRunId: string;
  fileCount: number;
  preview: boolean;
  dryRun: boolean;
  contextPath: string;
}

async function prepareAndStart(argv: string[]): Promise<PrepareStartResult> {
  const args = parseArgs(argv);

  if (args.unsupported.length > 0) {
    throw new Error(`OCRP-RUN-011: unsupported flag: ${args.unsupported.join('; ')}`);
  }

  const concurrency = normalizeConcurrency(args.concurrency);

  const req: ReviewRequest = {
    repoRoot: process.cwd(),
    mode: args.mode,
    commit: args.commit,
    from: args.from,
    to: args.to,
    paths: args.paths,
    background: args.background,
    rulesPath: args.rulesPath,
    plansPath: args.plansPath,
    format: args.format,
    concurrency,
    preview: args.preview,
    dryRun: args.dryRun,
    resumeRunId: args.resumeRunId,
  };

  const ctx = await buildReviewContext(req);
  await writeContext(ctx.runId, ctx);

  const launchConfig: LaunchConfig = {
    schemaVersion: 1,
    mode: args.mode,
    commit: args.commit,
    from: args.from,
    to: args.to,
    paths: args.paths,
    background: args.background,
    rulesPath: args.rulesPath,
    plansPath: args.plansPath,
    format: args.format,
    concurrency,
    leaseDurationMs: DEFAULT_LEASE_DURATION_MS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
  };
  await writeLaunchConfig(ctx.runId, launchConfig);

  const startResult = await startCandidate(ctx.runId);

  return {
    effectiveRunId: startResult.effectiveRunId,
    fileCount: ctx.files.length,
    preview: ctx.preview === true,
    dryRun: ctx.dryRun === true,
    contextPath: `.ocr-runs/${ctx.runId}/context.json`,
  };
}

// ---------------------------------------------------------------------------
// Phase: Main loop (reconcile + claim)
// ---------------------------------------------------------------------------

async function mainLoop(
  effectiveRunId: string,
  concurrency: number,
): Promise<DispatchPhase | WaitPhase | DonePhase> {
  const runDir = await resolveExistingRunDir(effectiveRunId);
  if (!runDir) {
    throw new Error(`Run directory not found: ${effectiveRunId}`);
  }

  const orch = new Orchestrator(runDir);

  // ---- Reconcile (expire leases, recompute state) ------------------------
  const status = await orch.reconcile();

  // ---- Terminal check ----------------------------------------------------
  if (status.state === 'completed' || status.state === 'failed') {
    return await aggregatePhase(effectiveRunId, orch, status);
  }

  // ---- Read context for file count ---------------------------------------
  const ctx = await readContext<ReviewContext>(effectiveRunId);

  // ---- Claim -------------------------------------------------------------
  const claims = await orch.claim(concurrency);

  if (claims.length > 0) {
    return {
      phase: 'dispatch',
      runId: effectiveRunId,
      effectiveRunId,
      state: status.state,
      fileCount: ctx.files.length,
      taskCounts: status.taskCounts,
      claims,
      reRunArgs: `--runId ${effectiveRunId}`,
    };
  }

  // ---- No claims available -----------------------------------------------
  if (status.nextLeaseDeadline) {
    return {
      phase: 'wait',
      runId: effectiveRunId,
      effectiveRunId,
      state: status.state,
      taskCounts: status.taskCounts,
      waitUntil: status.nextLeaseDeadline,
      reason: `No queued tasks available; live leases exist. Next lease deadline: ${status.nextLeaseDeadline}`,
      reRunArgs: `--runId ${effectiveRunId}`,
    };
  }

  // Edge case: no claims, no live leases, but state is still active.
  // Reconcile once more to ensure we didn't miss a terminal transition.
  const status2 = await orch.reconcile();
  if (status2.state === 'completed' || status2.state === 'failed') {
    return await aggregatePhase(effectiveRunId, orch, status2);
  }

  // Should not happen, but guard with a short wait instead of busy-polling.
  return {
    phase: 'wait',
    runId: effectiveRunId,
    effectiveRunId,
    state: status2.state,
    taskCounts: status2.taskCounts,
    waitUntil: new Date(Date.now() + 10_000).toISOString(),
    reason: 'No queued tasks and no live leases, but run is still active. Brief backoff.',
    reRunArgs: `--runId ${effectiveRunId}`,
  };
}

// ---------------------------------------------------------------------------
// Shared filter + relocation pipeline
// Extracted so review.ts and aggregate.ts can share the same logic.
// ---------------------------------------------------------------------------

interface ToolCallEvent {
  type?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

interface FilterRelocationResult {
  visibleComments: CommentRecord[];
  hiddenCount: number;
  relocatedCount: number;
  relocationFallbackCount: number;
  filterWarnings: FilterWarning[];
  relocationWarnings: RelocationWarning[];
  eventWarnings: Array<{ path: string; reason: string }>;
}

/**
 * Apply the filter + relocation pipeline to a set of accepted comments.
 *
 * This is the shared canonical pipeline used by both the review.ts engine
 * and the standalone aggregate.ts CLI. Changes to filter/relocation logic
 * should be made here.
 */
async function applyFilterRelocationPipeline(
  runId: string,
  ctx: ReviewContext,
  comments: CommentRecord[],
): Promise<FilterRelocationResult> {
  const filters = await readFilterResults(runId);
  const relocationData = await readRelocationResults(runId);
  const events = await readEvents<ToolCallEvent>(runId);

  // ---- Event warnings ----------------------------------------------------
  const eventWarnings: Array<{ path: string; reason: string }> = [];
  for (const event of events) {
    if (event.type !== 'tool_call' || event.tool !== 'code_comment') continue;
    const args = event.args ?? {};
    if (typeof args.path !== 'string' || typeof args.subagent !== 'string') {
      eventWarnings.push({
        path: typeof args.path === 'string' ? args.path : '<unknown>',
        reason: 'malformed code_comment tool call: missing parsed path/subagent',
      });
    }
  }

  // ---- Filter pipeline ---------------------------------------------------
  const contextPaths = new Set(ctx.files.map((f) => f.path));
  const commentById = new Map(comments.map((c) => [c.comment_id, c]));
  const hiddenIds = new Set<string>();
  const filterWarnings: FilterWarning[] = [...filters.warnings];
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

  const visibleComments = comments.filter((c) => !hiddenIds.has(c.comment_id));
  const hiddenCount = comments.length - visibleComments.length;

  // ---- Relocation pipeline -----------------------------------------------
  const relocationWarnings: RelocationWarning[] = [...relocationData.warnings];
  let relocatedCount = 0;
  let relocationFallbackCount = 0;

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

  for (const comment of visibleComments) {
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

  // Check for unknown relocation decisions
  for (const result of relocationData.results) {
    const pathComments = visibleComments.filter((c) => c.path === result.path);
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

  return {
    visibleComments,
    hiddenCount,
    relocatedCount,
    relocationFallbackCount,
    filterWarnings,
    relocationWarnings,
    eventWarnings,
  };
}

// ---------------------------------------------------------------------------
// Phase: Aggregate
// ---------------------------------------------------------------------------

import type { CommentRecord } from '../core/model/comment.js';
import type { FilterWarning } from '../core/model/filter.js';
import type { RelocationWarning } from '../core/model/relocation.js';

async function aggregatePhase(
  runId: string,
  orch: Orchestrator,
  status: ReconcileResult,
): Promise<DonePhase> {
  const ctx = await readContext<ReviewContext>(runId);

  // Read accepted comments from the orchestrator
  const { comments, partialFiles } = await orch.readAcceptedComments();

  // Get authoritative task records for real failed-file details
  const tasks = await orch.listTasks();

  // Build summary
  const total = ctx.files.length;
  const succeeded = status.taskCounts.succeeded;
  const failed = status.taskCounts.failed;
  const success = status.state === 'completed';
  const commentCount = comments.length;

  let summary: string;
  if (success) {
    summary = commentCount > 0
      ? `${succeeded}/${total} files reviewed — ${commentCount} finding(s)`
      : `${succeeded}/${total} files reviewed — no findings`;
  } else {
    summary = `${succeeded}/${total} files succeeded, ${failed}/${total} failed — ${commentCount} finding(s) across succeeded files (PARTIAL)`;
  }

  // ---- Shared filter + relocation pipeline -------------------------------
  const pipeline = await applyFilterRelocationPipeline(runId, ctx, comments);

  // ---- Render reports ----------------------------------------------------
  const launch = await readLaunchConfig(runId).catch(() => null);
  const effectiveFormat = launch?.format ?? 'both';

  if (effectiveFormat === 'markdown' || effectiveFormat === 'both') {
    let md = renderMarkdownReport(ctx, pipeline.visibleComments, {
      partialFiles,
      rawCommentCount: comments.length,
      filteredCommentCount: pipeline.hiddenCount,
      relocatedCount: pipeline.relocatedCount,
      relocationFallbackCount: pipeline.relocationFallbackCount,
      warnings: pipeline.eventWarnings,
    });
    if (!success) {
      const failedTaskDetails = buildFailedFileDetails(tasks);
      md += [
        '',
        '## ⚠️ Failed Files (Partial Review)',
        '',
        `Expected tasks: ${total}`,
        `Succeeded tasks: ${succeeded}`,
        `Failed tasks: ${failed}`,
        '',
        ...failedTaskDetails.map(
          (f) => `- \`${f.path}\` — ${f.reason} (attempts ${f.attemptsUsed}/${f.maxAttempts})`,
        ),
        '',
      ].join('\n');
    }
    await writeReport(runId, 'report.md', md);
  }

  if (effectiveFormat === 'json' || effectiveFormat === 'both') {
    const parsed = JSON.parse(renderJsonReport(ctx, pipeline.visibleComments, {
      partialFiles,
      durationMs: 0,
      rawCommentCount: comments.length,
      filteredCommentCount: pipeline.hiddenCount,
      filterWarnings: pipeline.filterWarnings,
      relocatedCount: pipeline.relocatedCount,
      relocationFallbackCount: pipeline.relocationFallbackCount,
      relocationWarnings: pipeline.relocationWarnings,
      warnings: pipeline.eventWarnings,
    }));
    const j = success
      ? JSON.stringify(parsed, null, 2)
      : JSON.stringify({
        ...parsed,
        status: 'completed_with_errors',
        state: 'failed',
        partial: true,
        expected: total,
        succeeded,
        failed,
        message: 'Review run failed; some tasks did not complete successfully',
      }, null, 2);
    await writeReport(runId, 'report.json', j);
  }

  // ---- Bridge to post_comments: write accepted comments to comments.jsonl
  //      so ocr-post-comments can read them for PR posting.
  for (const c of pipeline.visibleComments) {
    await appendComment(runId, c);
  }

  const failedFiles = success ? undefined : buildFailedFileDetails(tasks);

  return {
    phase: 'done',
    runId,
    effectiveRunId: runId,
    success,
    partial: !success,
    fileCount: total,
    taskCounts: status.taskCounts,
    reportMdPath: effectiveFormat !== 'json' ? `.ocr-runs/${runId}/report.md` : undefined,
    reportJsonPath: effectiveFormat !== 'markdown' ? `.ocr-runs/${runId}/report.json` : undefined,
    summary,
    failedFiles,
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  try {
    const explicitRunId = extractExplicitRunId(argv);

    let effectiveRunId: string;
    let fileCount: number;

    if (explicitRunId) {
      effectiveRunId = explicitRunId;

      try {
        const ctx = await readContext<ReviewContext>(effectiveRunId);
        fileCount = ctx.files.length;
      } catch {
        fileCount = 0;
      }
    } else {
      const result = await prepareAndStart(argv);
      effectiveRunId = result.effectiveRunId;
      fileCount = result.fileCount;

      if (result.preview || result.dryRun) {
        output({
          phase: 'done',
          runId: effectiveRunId,
          effectiveRunId,
          success: true,
          partial: false,
          fileCount: result.fileCount,
          taskCounts: { queued: 0, leased: 0, running: 0, succeeded: 0, failed: 0 },
          summary: result.preview
            ? `Preview mode — review context at ${result.contextPath}`
            : `Dry-run mode — ${result.fileCount} file(s) would be reviewed`,
        });
        return;
      }

      if (fileCount === 0) {
        output({
          phase: 'done',
          runId: effectiveRunId,
          effectiveRunId,
          success: true,
          partial: false,
          fileCount: 0,
          taskCounts: { queued: 0, leased: 0, running: 0, succeeded: 0, failed: 0 },
          summary: 'No changes to review.',
        });
        return;
      }

      if (fileCount > MAX_FILES_PER_RUN) {
        process.stderr.write(
          `[review] Warning: ${fileCount} files exceeds MAX_FILES_PER_RUN (${MAX_FILES_PER_RUN}). ` +
          `Review may be truncated.\n`,
        );
      }
    }

    let concurrency = 2;
    try {
      const launch = await readLaunchConfig(effectiveRunId);
      concurrency = launch?.concurrency ?? 2;
    } catch {
      // Use default
    }

    const result = await mainLoop(effectiveRunId, concurrency);
    output(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    error(message);
    process.exitCode = 2;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('review.mjs') ||
   process.argv[1].endsWith('review.js') ||
   process.argv[1].endsWith('review.ts'));

if (isMain) {
  main().catch((err) => {
    process.stderr.write(`[review] Unhandled error: ${err?.message ?? err}\n`);
    process.exit(2);
  });
}
