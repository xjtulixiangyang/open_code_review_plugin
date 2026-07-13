#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  readContext,
  readFilterResults,
  safePathKey,
  writeRelocationResult,
} from '../core/runs/store.js';
import { resolveCommentLocation } from '../core/relocation/resolve.js';
import { readReviewComments } from '../core/orchestrator/comments.js';
import type { ReviewContext } from '../core/model/request.js';
import type { RelocationFileResult } from '../core/model/relocation.js';

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
  process.stderr.write(`[ocr-relocate-apply] ${message}\n`);
  process.exit(code);
}

async function readOptionalFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  for (const r of ['runId', 'path']) {
    if (!f[r]) fail(2, `missing --${r}`);
  }
  if (!f.path || f.path.includes('..')) fail(2, 'OCRP-RELOCATE-081: invalid --path');

  const ctx = await readContext<ReviewContext>(f.runId);
  const file = ctx.files.find((candidate) => candidate.path === f.path);
  if (!file) fail(2, `OCRP-RELOCATE-081: path is not in review context: ${f.path}`);

  const comments = await readReviewComments(f.runId);
  const filters = await readFilterResults(f.runId);
  const hiddenIds = new Set<string>();
  for (const result of filters.results) {
    if (result.path !== f.path) continue;
    for (const decision of result.decisions) hiddenIds.add(decision.comment_id);
  }

  const visibleComments = comments.filter((comment) => comment.path === f.path && !hiddenIds.has(comment.comment_id));
  const repoRoot = ctx.repoRoot || process.cwd();
  const newFileText = await readOptionalFile(join(repoRoot, f.path));
  const decisions = visibleComments.map((comment) => resolveCommentLocation(file, comment, newFileText));
  const unchangedCount = decisions.filter((decision) => decision.source === 'unchanged').length;
  const fallbackCount = decisions.filter((decision) => decision.source === 'fallback_original').length;
  const relocatedCount = decisions.length - unchangedCount - fallbackCount;

  const result: RelocationFileResult = {
    path: f.path,
    decisions,
    _meta: {
      source: 'line_resolver',
      subagent: f.subagent ?? 'unknown',
      ts: new Date().toISOString(),
    },
  };
  await writeRelocationResult(f.runId, result);

  process.stdout.write(
    JSON.stringify({
      runId: f.runId,
      path: f.path,
      relocatedCount,
      unchangedCount,
      fallbackCount,
      relocationPath: `.ocr-runs/${f.runId}/relocations/${safePathKey(f.path)}.json`,
    }, null, 2) + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(`[ocr-relocate-apply] ${err?.message ?? err}\n`);
  process.exit(1);
});
