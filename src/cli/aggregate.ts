#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
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
  let schema1State: string | null = null;
  let orchestrator: Orchestrator | null = null;
  if (runDir) {
    try {
      const runRecordRaw = await readFile(join(runDir, 'run.json'), 'utf8');
      const runRecord = JSON.parse(runRecordRaw);
      if (runRecord && runRecord.schemaVersion === 1) {
        schema1State = runRecord.state;
        orchestrator = new Orchestrator(runDir);
      }
    } catch {
      // No run.json or malformed -> old-schema (fail closed on malformed)
    }
  }

  // -----------------------------------------------------------------------
  // Read comments and determine partial files
  // -----------------------------------------------------------------------
  let rawComments: CommentRecord[];
  let partialFiles: string[];

  if (schema1State !== null && orchestrator) {
    // Schema-1 strict aggregation
    if (schema1State === 'active' || schema1State === 'superseded') {
      process.stderr.write(
        `[ocr-aggregate] Run ${f.runId} is ${schema1State}; aggregation requires completed or failed state\n`,
      );
      process.exit(2);
    }

    if (schema1State === 'failed') {
      // Read task counts from orchestrator for diagnostic report
      const status = await orchestrator.status();
      // Write diagnostic report and exit 1
      const diagnosticJson = JSON.stringify({
        status: 'completed_with_errors',
        runId: f.runId,
        state: 'failed',
        taskCounts: status.taskCounts,
        message: 'Review run failed; some tasks did not complete successfully',
      }, null, 2);
      await writeReport(f.runId, 'report.json', diagnosticJson);
      const diagnosticMd = [
        '# Review Run Failed',
        '',
        `Run \`${f.runId}\` ended in **failed** state.`,
        '',
        `- Succeeded tasks: ${status.taskCounts.succeeded}`,
        `- Failed tasks: ${status.taskCounts.failed}`,
        `- Queued tasks: ${status.taskCounts.queued}`,
        `- Leased tasks: ${status.taskCounts.leased}`,
        `- Running tasks: ${status.taskCounts.running}`,
        '',
      ].join('\n');
      await writeReport(f.runId, 'report.md', diagnosticMd);
      process.stderr.write(diagnosticJson + '\n');
      process.exit(1);
    }

    // state === 'completed'
    const accepted = await orchestrator.readAcceptedComments();
    rawComments = accepted.comments;
    partialFiles = accepted.partialFiles;
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
    const md = renderMarkdownReport(ctx, comments, {
      partialFiles,
      rawCommentCount: rawComments.length,
      filteredCommentCount,
      relocatedCount,
      relocationFallbackCount,
      warnings,
    });
    await writeReport(f.runId, 'report.md', md);
  }
  if (format === 'json' || format === 'both') {
    const j = renderJsonReport(ctx, comments, {
      partialFiles,
      durationMs: dur,
      rawCommentCount: rawComments.length,
      filteredCommentCount,
      filterWarnings,
      relocatedCount,
      relocationFallbackCount,
      relocationWarnings,
      warnings,
    });
    await writeReport(f.runId, 'report.json', j);
  }
  process.stdout.write(
    JSON.stringify({
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
    }, null, 2) + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(`[ocr-aggregate] ${err?.message ?? err}\n`);
  process.exit(1);
});
