#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildReviewContext } from '../core/context/review_context.js';
import { writeContext, runDir } from '../core/runs/store.js';
import type { ReviewRequest } from '../core/model/request.js';
import type { ReviewMode } from '../core/types.js';

interface ParsedArgs {
  mode: ReviewMode;
  commit?: string;
  from?: string;
  to?: string;
  paths?: string[];
  background?: string;
  format?: 'markdown' | 'json' | 'both';
  concurrency?: number;
  rulesPath?: string;
  preview?: boolean;
  dryRun?: boolean;
  unsupported: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { mode: 'workspace', unsupported: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('-')) {
        throw new Error(`OCRP-RUN-011: ${a} requires a value`);
      }
      return v;
    };
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
    else if (a === '--rules' || a === '--rule') out.rulesPath = next();
    else if (a === '--format' || a === '-f') out.format = next() as ParsedArgs['format'];
    else if (a === '--concurrency') out.concurrency = parseInt(next(), 10);
    else if (a === '--preview' || a === '-p') out.preview = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (!a.startsWith('-')) {
      if (a === 'staged') out.mode = 'staged';
      else if (a === 'workspace') out.mode = 'workspace';
      else if (a.includes('..')) {
        out.mode = 'range';
        const [from, to] = a.split('..');
        out.from = from;
        out.to = to;
      } else {
        out.mode = 'commit';
        out.commit = a;
      }
    }
    i++;
  }
  return out;
}

function fileSummary(ctx: Awaited<ReturnType<typeof buildReviewContext>>) {
  return ctx.files.map((f) => ({
    path: f.path,
    status: f.status,
    hunkCount: f.hunks.length,
    changedLines: f.hunks.reduce((s, h) => s + h.lines.filter((l) => l.kind !== ' ').length, 0),
    ruleId: f.rulesHit[0]?.ruleId ?? '',
    ruleSource: f.rulesHit[0]?.docPath === undefined && (f.rulesHit[0]?.message ?? '') !== '' ? 'custom' : 'system',
  }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.unsupported.length > 0) {
    throw new Error(`OCRP-RUN-011: unsupported flag: ${args.unsupported.join('; ')}`);
  }
  if (args.preview && args.dryRun) {
    throw new Error('OCRP-RUN-011: --preview and --dry-run are mutually exclusive');
  }

  const req: ReviewRequest = {
    repoRoot: process.cwd(),
    mode: args.mode,
    commit: args.commit,
    from: args.from,
    to: args.to,
    paths: args.paths,
    background: args.background,
    rulesPath: args.rulesPath,
    preview: args.preview,
    dryRun: args.dryRun,
    format: args.format,
    concurrency: args.concurrency,
  };
  const ctx = await buildReviewContext(req);

  const hunkCount = ctx.files.reduce((s, f) => s + f.hunks.length, 0);
  const changedLines = ctx.files.reduce(
    (s, f) => s + f.hunks.reduce((ss, h) => ss + h.lines.filter((l) => l.kind !== ' ').length, 0),
    0,
  );
  const excludedFiles = ctx.excludedFiles ?? [];

  // preview: 不写 context.json，只输出 summary
  if (args.preview) {
    const summary = {
      runId: ctx.runId,
      preview: true,
      fileCount: ctx.files.length,
      excludedCount: excludedFiles.length,
      hunkCount,
      changedLines,
      contextPath: null,
      rulesSource: ctx.rulesSource,
      files: fileSummary(ctx),
      excludedFiles,
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }

  // 正常 review 或 dry-run 都写 context.json
  await writeContext(ctx.runId, ctx);

  let previewPath: string | undefined;
  if (args.dryRun) {
    previewPath = `.ocr-runs/${ctx.runId}/preview.json`;
    const previewAbsPath = join(runDir(ctx.runId), 'preview.json');
    const preview = {
      runId: ctx.runId,
      dryRun: true,
      range: ctx.range,
      rulesSource: ctx.rulesSource,
      fileCount: ctx.files.length,
      excludedCount: excludedFiles.length,
      hunkCount,
      changedLines,
      files: fileSummary(ctx),
      excludedFiles,
    };
    await writeFile(previewAbsPath, JSON.stringify(preview, null, 2), 'utf8');
  }

  const summary = {
    runId: ctx.runId,
    preview: false,
    dryRun: args.dryRun ?? false,
    fileCount: ctx.files.length,
    excludedCount: excludedFiles.length,
    hunkCount,
    changedLines,
    contextPath: `.ocr-runs/${ctx.runId}/context.json`,
    previewPath,
    rulesSource: ctx.rulesSource,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch((err) => {
  const code = (err && err.message && /OCRP-/.test(err.message)) ? 2 : 1;
  process.stderr.write(`[ocr-prepare] ${err?.message ?? err}\n`);
  process.exit(code);
});
