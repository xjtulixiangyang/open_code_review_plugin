/**
 * open-code-review-plugin — Claude Code plugin entry.
 *
 * Design invariant (must be preserved across the whole project):
 *
 *   This module and every module reachable from it MUST NOT perform any
 *   HTTP call to an LLM provider. All language-model decisions are
 *   delegated to the host Claude Code session via:
 *     - `commands/review.md`  (the `/review` slash command),
 *     - `skills/code-review/SKILL.md` (the review skill).
 *
 *   The TypeScript code here only provides deterministic helpers
 *   (git diff parsing, rule matching, Markdown report rendering) that
 *   the host session can drive through the host-provided Bash / Read /
 *   Grep tools. The detailed module surface — what gets exported and
 *   how — is locked down in `codespec/changes/refactor-as-plugin/spec.md`
 *   and `design.md`.
 *
 * Build pipeline:
 *   src/**\/*.ts  --tsc-->  dist/**\/*.js  --build-mjs.mjs-->  dist/**\/*.mjs
 *
 * Runtime entry:
 *   dist/index.mjs (referenced by package.json `main` and `exports['.']`)
 */

export const PLUGIN_NAME = 'open-code-review-plugin' as const;
export const VERSION = '0.1.0' as const;

// ---------------------------------------------------------------------------
// Public type surface (placeholder — finalized in spec.md / design.md)
// ---------------------------------------------------------------------------

/** A single file entry parsed out of a git diff. */
export interface DiffEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /** Unified diff text for this file. */
  diff: string;
  /** Current file content (omitted for `deleted`). */
  newContent?: string;
  insertions: number;
  deletions: number;
}

/** A single line-level review comment, aligned with the original
 *  `open-code-review` schema so that the report rendering layer stays
 *  swap-compatible with the upstream JSON shape.
 */
export interface ReviewComment {
  path: string;
  startLine: number;
  endLine: number;
  severity: 'high' | 'medium' | 'low';
  summary: string;
  detail: string;
  suggestion?: string;
  existingCode?: string;
}

/** The aggregated review result. The `rawMarkdown` field is what gets
 *  surfaced back to the host Claude Code session.
 */
export interface ReviewReport {
  summary: {
    filesReviewed: number;
    issuesFound: number;
    highPriority: number;
    mediumPriority: number;
    lowPriority: number;
  };
  comments: ReviewComment[];
  rawMarkdown: string;
}

/** Input to the (future) `review` entry point. */
export interface ReviewRequest {
  /** Absolute path to the git repository root. */
  repoDir: string;
  /** Optional business / requirement context to fold into the report. */
  background?: string;
  /** Review mode (default: workspace). */
  mode?: 'workspace' | 'commit' | 'range';
  /** When mode = commit, the commit SHA to compare against its parent. */
  commit?: string;
  /** When mode = range, the "from" ref. */
  from?: string;
  /** When mode = range, the "to" ref. */
  to?: string;
}

// ---------------------------------------------------------------------------
// Entry point (placeholder — implementation lives in subsequent SDD stages)
// ---------------------------------------------------------------------------

/**
 * Top-level review entry. In the SDD init phase this is a deliberate
 * placeholder — the real implementation will be assembled by the tasks
 * laid out in `task.md` and will compose:
 *
 *   1. `diff/`   — read & parse the git diff for the requested mode
 *   2. `rules/`  — match per-path rules and filter ignored files
 *   3. (host)    — the Claude Code session reasons over each hunk
 *   4. `report/` — render the resulting `ReviewComment[]` to Markdown
 */
export async function review(_request: ReviewRequest): Promise<{
  status: 'not-implemented';
  message: string;
}> {
  return {
    status: 'not-implemented',
    message:
      `${PLUGIN_NAME} ${VERSION} is in SDD init phase. ` +
      'See codespec/changes/refactor-as-plugin/init.md for scope.',
  };
}
