#!/usr/bin/env node
import {
  readContext,
  readComments,
  readFilterResults,
  listDone,
  writeReport,
} from '../core/runs/store.js';
import { renderMarkdownReport } from '../core/report/markdown.js';
import { renderJsonReport } from '../core/report/json.js';
import type { ReviewContext } from '../core/model/request.js';
import type { CommentRecord } from '../core/model/comment.js';

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
  const rawComments = await readComments<CommentRecord>(f.runId);
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
  const dones = await listDone(f.runId);
  const doneFiles = new Set(dones.map((d) => d.file));
  const expected = new Set(ctx.files.map((x) => x.path));
  const partialFiles: string[] = [];
  for (const p of expected) if (!doneFiles.has(p)) partialFiles.push(p);

  const dur = Date.now() - start;

  if (format === 'markdown' || format === 'both') {
    const md = renderMarkdownReport(ctx, comments, { partialFiles, rawCommentCount: rawComments.length, filteredCommentCount });
    await writeReport(f.runId, 'report.md', md);
  }
  if (format === 'json' || format === 'both') {
    const j = renderJsonReport(ctx, comments, { partialFiles, durationMs: dur, rawCommentCount: rawComments.length, filteredCommentCount, filterWarnings });
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
      partialFiles,
    }, null, 2) + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(`[ocr-aggregate] ${err?.message ?? err}\n`);
  process.exit(1);
});
