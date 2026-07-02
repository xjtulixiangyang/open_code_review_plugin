import type { ReviewContext } from '../model/request.js';

/**
 * Mirrors open-code-review FileReadDiffProvider.Execute.
 * Returns formatted diffs for each requested path found in context, or an
 * upstream-style error string when nothing is requested/found.
 */
export function readFileDiff(args: Record<string, unknown>, ctx: ReviewContext): string {
  const raw = args['path_array'];
  const paths: unknown[] = Array.isArray(raw) ? raw : [];
  if (paths.length === 0) return 'Error: no files found';

  let out = '';
  for (const item of paths) {
    if (typeof item !== 'string') continue;
    const file = ctx.files.find((f) => f.path === item);
    if (!file) continue;
    out += `==== FILE: ${item} ====\n`;
    out += file.diff;
    out += file.truncated ? '\n... (truncated)\n' : '\n';
  }
  if (out === '') return 'Error: diff not found for the requested paths';
  return out;
}
