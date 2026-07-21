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
import { writeContext, writeLaunchConfig, resolveExistingRunDir, readContext, readLaunchConfig } from '../core/runs/store.js';
import { startCandidate } from '../core/orchestrator/manifest.js';
import { Orchestrator } from '../core/orchestrator/orchestrator.js';
import { DEFAULT_LEASE_DURATION_MS, DEFAULT_MAX_ATTEMPTS } from '../core/orchestrator/types.js';
import type { LaunchConfig, ClaimResult, TaskCounts, ReconcileResult } from '../core/orchestrator/types.js';
import type { ReviewRequest, ReviewContext } from '../core/model/request.js';
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

interface DonePhase {
  phase: 'done';
  runId: string;
  effectiveRunId: string;
  success: boolean;
  /** true when every task succeeded; false means partial/partialFiles exist. */
  partial: boolean;
  fileCount: number;
  taskCounts: TaskCounts;
  reportMdPath?: string;
  reportJsonPath?: string;
  summary: string;
  /** Non-null when the run failed — lists files that did not complete. */
  failedFiles?: Array<{ path: string; attemptsUsed: number; maxAttempts: number; reason: string }>;
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

/**
 * Derive the effective run ID from argv.
 * Returns undefined when this is a fresh invocation (no --runId flag).
 */
function extractExplicitRunId(argv: string[]): string | undefined {
  const idx = argv.indexOf('--runId');
  return idx >= 0 ? argv[idx + 1] : undefined;
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

  // Start the candidate (handles resume vs new)
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
    return await aggregatePhase(effectiveRunId, runDir, orch, status);
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
    return await aggregatePhase(effectiveRunId, runDir, orch, status2);
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
// Phase: Aggregate
// ---------------------------------------------------------------------------

async function aggregatePhase(
  runId: string,
  runDir: string,
  orch: Orchestrator,
  status: ReconcileResult,
): Promise<DonePhase> {
  const ctx = await readContext<ReviewContext>(runId);

  // Read accepted comments from the orchestrator
  const { comments, partialFiles } = await orch.readAcceptedComments();

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

  // Render reports using the core renderers directly.
  // We import and call programmatically instead of shelling out.
  const { renderMarkdownReport } = await import('../core/report/markdown.js');
  const { renderJsonReport } = await import('../core/report/json.js');
  const { writeReport } = await import('../core/runs/store.js');

  // Read filter & relocation results for the report pipeline
  const { readFilterResults, readRelocationResults, readEvents } =
    await import('../core/runs/store.js');
  const filters = await readFilterResults(runId);
  const relocationData = await readRelocationResults(runId);
  const events = await readEvents<ToolCallEvent>(runId);

  // ---- Event warnings ----------------------------------------------------
  const warnings: Array<{ path: string; reason: string }> = [];
  for (const event of events) {
    if (event.type !== 'tool_call' || event.tool !== 'code_comment') continue;
    const args = event.args ?? {};
    if (typeof args.path !== 'string' || typeof args.subagent !== 'string') {
      warnings.push({
        path: typeof args.path === 'string' ? args.path : '<unknown>',
        reason: 'malformed code_comment tool call: missing parsed path/subagent',
      });
    }
  }

  // ---- Filter pipeline ---------------------------------------------------
  const contextPaths = new Set(ctx.files.map((f) => f.path));
  const commentById = new Map(comments.map((c) => [c.comment_id, c]));
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

  const visibleComments = comments.filter((c) => !hiddenIds.has(c.comment_id));
  const filteredCommentCount = comments.length - visibleComments.length;

  // ---- Relocation pipeline -----------------------------------------------
  const relocationWarnings = [...relocationData.warnings];
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

  // ---- Render reports ----------------------------------------------------
  // Read format from stored launch config; fall back to 'both'
  let effectiveFormat: string = 'both';
  try {
    const launch = await readLaunchConfig(runId);
    effectiveFormat = launch?.format ?? 'both';
  } catch { /* use default */ }

  if (effectiveFormat === 'markdown' || effectiveFormat === 'both') {
    let md = renderMarkdownReport(ctx, visibleComments, {
      partialFiles,
      rawCommentCount: comments.length,
      filteredCommentCount,
      relocatedCount,
      relocationFallbackCount,
      warnings,
    });
    if (!success) {
      const failedTaskDetails = partialFiles.map((path) => ({
        path,
        attemptsUsed: 0,
        maxAttempts: 0,
        reason: 'task failed or incomplete',
      }));
      md += [
        '',
        '## ⚠️ Failed Files (Partial Review)',
        '',
        `Expected tasks: ${total}`,
        `Succeeded tasks: ${succeeded}`,
        `Failed tasks: ${failed}`,
        '',
        ...failedTaskDetails.map((f) => `- \`${f.path}\` — ${f.reason}`),
        '',
      ].join('\n');
    }
    await writeReport(runId, 'report.md', md);
  }

  if (effectiveFormat === 'json' || effectiveFormat === 'both') {
    const parsed = JSON.parse(renderJsonReport(ctx, visibleComments, {
      partialFiles,
      durationMs: 0,
      rawCommentCount: comments.length,
      filteredCommentCount,
      filterWarnings,
      relocatedCount,
      relocationFallbackCount,
      relocationWarnings,
      warnings,
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

  // Build failed files detail for the DonePhase output
  const failedFiles = success ? undefined : partialFiles.map((path) => ({
    path,
    attemptsUsed: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    reason: 'task failed or incomplete',
  }));

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
// Types for aggregate pipeline
// ---------------------------------------------------------------------------

interface ToolCallEvent {
  type?: string;
  tool?: string;
  args?: Record<string, unknown>;
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
      // ---- Subsequent call: continue existing run ------------------------
      effectiveRunId = explicitRunId;

      // Read context for file count (used in output)
      try {
        const ctx = await readContext<ReviewContext>(effectiveRunId);
        fileCount = ctx.files.length;
      } catch {
        // Context may not be readable; carry on with the run directory
        fileCount = 0;
      }
    } else {
      // ---- First call: prepare + start ---------------------------------
      const result = await prepareAndStart(argv);
      effectiveRunId = result.effectiveRunId;
      fileCount = result.fileCount;

      // Handle preview / dry-run
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

      // Handle 0 files
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

      // File count warning
      if (fileCount > MAX_FILES_PER_RUN) {
        process.stderr.write(
          `[review] Warning: ${fileCount} files exceeds MAX_FILES_PER_RUN (${MAX_FILES_PER_RUN}). ` +
          `Review may be truncated.\n`,
        );
      }
    }

    // ---- Read concurrency from launch config ----------------------------
    let concurrency = 2; // default
    try {
      const launch = await readLaunchConfig(effectiveRunId);
      concurrency = launch?.concurrency ?? 2;
    } catch {
      // Use default
    }

    // ---- Run main loop -------------------------------------------------
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
