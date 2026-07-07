import { resolveContextRef } from './context_ref.js';
import { runGitSplit } from './git_exec.js';
import type { ReviewContext } from '../model/request.js';

const GIT_GREP_MAX_COUNT = 100;
const GIT_GREP_TIMEOUT_MS = 10_000;

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

function buildGrepArgs(
  ctx: ReviewContext,
  searchText: string,
  caseSensitive: boolean,
  usePerlRegexp: boolean,
  pathspec: string[],
): string[] {
  const args = ['--no-pager', 'grep'];
  if (!caseSensitive) args.push('-i');
  // Use -E (extended regex) as portable fallback; -P (Perl regex) is used
  // when available but Apple Git lacks PCRE support. The public arg name
  // use_perl_regexp is kept for OCR API compatibility.
  args.push(usePerlRegexp ? '-E' : '-F');
  args.push('-n', '--no-color', '-e', searchText);

  const ref = resolveContextRef(ctx);
  if (ref) {
    // --end-of-options is intentionally omitted here: Apple Git 2.37.1 does
    // not support it with `git grep`. The ref comes from ReviewContext and is
    // normally a commit hash, branch, tag, or ref name, so this is an accepted
    // portability tradeoff for local git compatibility.
    args.push(ref);
  }

  args.push('--', ...pathspec);
  return args;
}

interface MatchLine {
  lineNum: number;
  content: string;
}

export async function searchCode(args: Record<string, unknown>, ctx: ReviewContext): Promise<string> {
  const searchText = typeof args['search_text'] === 'string' ? args['search_text'] : '';
  if (searchText.trim() === '') return 'Error: search_text is blank';

  const caseSensitive = args['case_sensitive'] === true;
  const usePerlRegexp = args['use_perl_regexp'] === true || args['use_extended_regexp'] === true;
  const filePatterns = stringArray(args['file_patterns']);
  const gitArgs = buildGrepArgs(ctx, searchText, caseSensitive, usePerlRegexp, filePatterns);

  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await runGitSplit(gitArgs, {
      cwd: ctx.repoRoot,
      timeoutMs: GIT_GREP_TIMEOUT_MS,
      allowExitCodes: [0, 1],
    });
  } catch (err) {
    if ((err as Error).message.includes('timed out')) {
      return 'code_search timed out. Try narrowing file_patterns to a more specific path.';
    }
    throw new Error(`code_search failed: ${(err as Error).message}`);
  }

  if (result.code !== 0 && result.stdout === '') {
    if (result.stderr.trim() === '') return 'No matches found';
    return `Error: ${result.stderr.trim()}`;
  }

  const lines = result.stdout.trimEnd().split('\n').filter(Boolean);
  if (lines.length === 0) return 'No matches found';
  const truncated = lines.length >= GIT_GREP_MAX_COUNT;
  const hasRef = resolveContextRef(ctx) !== undefined;
  const splitN = hasRef ? 4 : 3;
  const offset = hasRef ? 1 : 0;

  const fileOrder: string[] = [];
  const seen = new Set<string>();
  const fileMatches = new Map<string, MatchLine[]>();
  let matchCount = 0;

  for (const line of lines) {
    if (matchCount >= GIT_GREP_MAX_COUNT) break;
    const parts = line.split(':');
    if (parts.length < splitN) continue;
    const fname = parts[offset];
    const lineNum = Number.parseInt(parts[offset + 1], 10);
    const content = parts.slice(offset + 2).join(':');
    if (!fname || !Number.isFinite(lineNum)) continue;
    if (!seen.has(fname)) {
      seen.add(fname);
      fileOrder.push(fname);
      fileMatches.set(fname, []);
    }
    fileMatches.get(fname)?.push({ lineNum, content });
    matchCount++;
  }

  let out = '';
  if (truncated) {
    out += `Note: The results have been truncated. Only showing first ${GIT_GREP_MAX_COUNT} results.\n`;
  }

  for (const path of fileOrder) {
    const matches = fileMatches.get(path) ?? [];
    out += `File: ${path}\nMatch lines: ${matches.length}\n`;
    for (const match of matches) {
      out += `${match.lineNum}|${match.content}\n`;
    }
    out += '\n';
  }

  if (result.code !== 0 && result.stderr.trim() !== '') {
    out += `Warning: ${result.stderr.trim()}\n`;
  }
  return out;
}
