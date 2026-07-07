import { readFile } from 'node:fs/promises';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { resolveContextRef } from './context_ref.js';
import { runGitSplit } from './git_exec.js';
import type { ReviewContext } from '../model/request.js';

function assertInsideRepo(repoRoot: string, path: string): string {
  const root = resolve(repoRoot);
  const candidate = isAbsolute(path) ? resolve(root, `.${path}`) : resolve(join(root, path));
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
    throw new Error(`file path ${JSON.stringify(path)} is outside repository`);
  }
  return candidate;
}

export async function readContextFile(ctx: ReviewContext, filePath: string): Promise<string> {
  const ref = resolveContextRef(ctx);
  if (!ref) {
    const fullPath = assertInsideRepo(ctx.repoRoot, filePath);
    return readFile(fullPath, 'utf8');
  }

  const result = await runGitSplit(
    ['-c', 'core.quotepath=false', 'show', '--end-of-options', `${ref}:${filePath}`],
    { cwd: ctx.repoRoot, timeoutMs: 30_000 },
  );
  return result.stdout;
}

export async function readContextFileLines(
  ctx: ReviewContext,
  filePath: string,
  startLine: number,
  maxLines: number,
): Promise<{ lines: string[]; totalLines: number }> {
  const content = await readContextFile(ctx, filePath);
  const allLines = content.length === 0 ? [] : content.split('\n');
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.max(startIndex, startIndex + maxLines);
  return {
    lines: allLines.slice(startIndex, endIndex),
    totalLines: allLines.length,
  };
}
