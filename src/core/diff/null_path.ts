/**
 * Cross-platform null path for git diff --no-index.
 * POSIX: /dev/null, Windows: NUL.
 */
export const NULL_PATH: string =
  process.platform === 'win32' ? 'NUL' : '/dev/null';

/** All accepted null path spellings (for diff header parsing). */
export const NULL_PATH_ALTS: readonly string[] = ['/dev/null', 'NUL'];

/** Normalize Windows backslash paths to forward slash. Idempotent. */
const SLASH_RE = /\\/g;
export function normalizePath(p: string): string {
  return p.replace(SLASH_RE, '/');
}
