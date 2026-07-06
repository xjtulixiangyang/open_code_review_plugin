#!/usr/bin/env node
import { buildReviewContext } from '../core/context/review_context.js';
import { writeContext } from '../core/runs/store.js';
import type { ReviewRequest } from '../core/model/request.js';
import type { ReviewMode } from '../core/types.js';

export const DEFAULT_REVIEW_CONCURRENCY = 2;
export const MAX_REVIEW_CONCURRENCY = 8;

export interface ParsedArgs {
  mode: ReviewMode;
  commit?: string;
  from?: string;
  to?: string;
  paths?: string[];
  background?: string;
  rulesPath?: string;
  format?: 'markdown' | 'json' | 'both';
  concurrency?: number;
  unsupported: string[];
  preview?: boolean;
  dryRun?: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  // 形式参考 OCR ocr review：
  //   --staged | --commit <sha> | --from <a> --to <b> | (default: workspace)
  //   --paths <glob1,glob2> | --background "..." | --rules <path>
  //   --format text|json|both | --concurrency <n> | --dry-run | --preview
  // 位置参数：第一个非 flag 视为 "staged" / "HEAD~3" 等便捷形式
  const out: ParsedArgs = { mode: 'workspace', unsupported: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--staged') out.mode = 'staged';
    else if (a === '--commit' || a === '-c') {
      out.mode = 'commit';
      out.commit = next();
    } else if (a === '--from') {
      out.mode = 'range';
      out.from = next();
    } else if (a === '--to') {
      out.mode = 'range';
      out.to = next();
    } else if (a === '--paths') out.paths = next().split(',');
    else if (a === '--background' || a === '-b') out.background = next();
    else if (a === '--rules' || a === '--rule') {
      out.rulesPath = next();
    } else if (a === '--format' || a === '-f') out.format = next() as ParsedArgs['format'];
    else if (a === '--concurrency') out.concurrency = parseInt(next(), 10);
    else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--preview' || a === '-p') {
      out.preview = true;
    } else if (!a.startsWith('-')) {
      // 位置参数便捷形式
      if (a === 'staged') out.mode = 'staged';
      else if (a === 'workspace') out.mode = 'workspace';
      else if (a.includes('..')) {
        out.mode = 'range';
        const [from, to] = a.split('..');
        out.from = from;
        out.to = to;
      } else {
        // 视为 commit sha 或 ref
        out.mode = 'commit';
        out.commit = a;
      }
    }
    i++;
  }
  return out;
}

export function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REVIEW_CONCURRENCY;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`OCRP-RUN-011: --concurrency must be a positive integer`);
  }
  if (value > MAX_REVIEW_CONCURRENCY) return MAX_REVIEW_CONCURRENCY;
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.unsupported.length > 0) {
    throw new Error(`OCRP-RUN-011: unsupported P0 flag: ${args.unsupported.join('; ')}`);
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
    format: args.format,
    concurrency,
    preview: args.preview,
    dryRun: args.dryRun,
  };
  const ctx = await buildReviewContext(req);
  await writeContext(ctx.runId, ctx);
  const summary = {
    runId: ctx.runId,
    fileCount: ctx.files.length,
    hunkCount: ctx.files.reduce((s, f) => s + f.hunks.length, 0),
    changedLines: ctx.files.reduce(
      (s, f) => s + f.hunks.reduce((ss, h) => ss + h.lines.filter((l) => l.kind !== ' ').length, 0),
      0,
    ),
    concurrency,
    contextPath: `.ocr-runs/${ctx.runId}/context.json`,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch((err) => {
  const code = (err && err.message && /OCRP-/.test(err.message)) ? 2 : 1;
  process.stderr.write(`[ocr-prepare] ${err?.message ?? err}\n`);
  process.exit(code);
});
