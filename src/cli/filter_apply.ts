#!/usr/bin/env node
import { readContext, readComments, safePathKey, writeFilterResult } from '../core/runs/store.js';
import type { ReviewContext } from '../core/model/request.js';
import type { CommentRecord } from '../core/model/comment.js';
import type { FilterDecision, FilterFileResult } from '../core/model/filter.js';

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

function fail(code: number, message: string): never {
  process.stderr.write(`[ocr-filter-apply] ${message}\n`);
  process.exit(code);
}

function parseInput(input: string, expectedPath: string): FilterFileResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    fail(2, `OCRP-FILTER-072: invalid JSON input: ${err instanceof Error ? err.message : String(err)}`);
  }

  const result = parsed as Partial<FilterFileResult>;
  if (!result || typeof result !== 'object') fail(2, 'OCRP-FILTER-072: input must be an object');
  if (result.path !== expectedPath) fail(2, `OCRP-FILTER-072: input path must equal --path (${expectedPath})`);
  if (!Array.isArray(result.decisions)) fail(2, 'OCRP-FILTER-072: decisions must be an array');

  for (const d of result.decisions as Array<Partial<FilterDecision>>) {
    if (!d.comment_id || typeof d.comment_id !== 'string') fail(2, 'OCRP-FILTER-072: decision comment_id is required');
    if (d.action !== 'hide') fail(2, 'OCRP-FILTER-072: decision action must be hide');
    if (!d.reason || typeof d.reason !== 'string' || d.reason.trim().length === 0) {
      fail(2, 'OCRP-FILTER-072: decision reason is required');
    }
  }

  return { path: result.path, decisions: result.decisions as FilterDecision[] };
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  for (const r of ['runId', 'path', 'input']) {
    if (!f[r]) fail(2, `missing --${r}`);
  }
  if (!f.path || f.path.includes('..')) fail(2, 'OCRP-FILTER-071: invalid --path');

  const parsed = parseInput(f.input, f.path);
  const ctx = await readContext<ReviewContext>(f.runId);
  const allowedPaths = new Set(ctx.files.map((file) => file.path));
  if (!allowedPaths.has(f.path)) fail(2, `OCRP-FILTER-071: path is not in review context: ${f.path}`);

  const comments = await readComments<CommentRecord>(f.runId);
  const validIds = new Set(comments.filter((c) => c.path === f.path).map((c) => c.comment_id));
  const decisions = parsed.decisions.filter((d) => validIds.has(d.comment_id));

  const result: FilterFileResult = {
    path: f.path,
    decisions,
    _meta: {
      source: 'review_filter_task',
      subagent: f.subagent ?? 'unknown',
      ts: new Date().toISOString(),
    },
  };
  await writeFilterResult(f.runId, result);

  process.stdout.write(
    JSON.stringify({
      runId: f.runId,
      path: f.path,
      hiddenCount: decisions.length,
      filterPath: `.ocr-runs/${f.runId}/filters/${safePathKey(f.path)}.json`,
    }, null, 2) + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(`[ocr-filter-apply] ${err?.message ?? err}\n`);
  process.exit(1);
});
