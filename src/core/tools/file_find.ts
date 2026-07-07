import { resolveContextRef } from './context_ref.js';
import { runGitSplit } from './git_exec.js';
import type { ReviewContext } from '../model/request.js';

const FILE_FIND_MAX_COUNT = 100;
const FILE_FIND_TIMEOUT_MS = 10_000;

function shouldSkipFile(path: string): boolean {
  const base = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  const hasExt = base.includes('.');
  if (!hasExt) {
    return !['Makefile', 'Dockerfile', 'LICENSE', 'Vagrantfile', 'Containerfile'].includes(base);
  }
  return false;
}

async function listFiles(ctx: ReviewContext): Promise<string[]> {
  const ref = resolveContextRef(ctx);
  const args = ref
    ? ['ls-tree', '-r', '--name-only', '--end-of-options', ref]
    : ['ls-files', '--cached', '--others', '--exclude-standard'];
  const result = await runGitSplit(args, { cwd: ctx.repoRoot, timeoutMs: FILE_FIND_TIMEOUT_MS });
  return result.stdout
    .trimEnd()
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((path) => !shouldSkipFile(path));
}

export async function findFiles(args: Record<string, unknown>, ctx: ReviewContext): Promise<string> {
  const queryName = typeof args['query_name'] === 'string' ? args['query_name'] : '';
  if (queryName.trim() === '') return '// The file was not found';

  const caseSensitive = args['case_sensitive'] === true;
  const needle = caseSensitive ? queryName : queryName.toLowerCase();
  const files = await listFiles(ctx);
  const matched: string[] = [];

  for (const file of files) {
    const base = file.includes('/') ? file.slice(file.lastIndexOf('/') + 1) : file;
    const haystack = caseSensitive ? base : base.toLowerCase();
    if (haystack.includes(needle)) matched.push(file);
    if (matched.length >= FILE_FIND_MAX_COUNT) break;
  }

  return matched.length === 0 ? '// The file was not found' : matched.join('\n');
}
