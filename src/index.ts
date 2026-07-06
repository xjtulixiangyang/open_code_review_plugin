/**
 * open-code-review-plugin - Claude Code plugin entry.
 *
 * Design invariant: this module and every module reachable from it MUST NOT
 * perform any HTTP call to an LLM provider. All language-model decisions are
 * delegated to the host Claude Code session via:
 *   - commands/review.md  (the /review slash command)
 *   - agents/ocr-reviewer.md  (reviewer subagent)
 *   - skills/ocr-plan/SKILL.md, skills/ocr-review-file/SKILL.md  (prompts)
 *
 * Public surface: type re-exports for downstream tooling / tests.
 */

export const PLUGIN_NAME = 'open-code-review' as const;
export const VERSION = '0.1.0' as const;

export type { LlmComment, CommentRecord } from './core/model/comment.js';
export type { PlanOutput, PlanIssue } from './core/model/plan.js';
export type {
  ReviewRequest,
  ReviewContext,
  FileChange,
  Hunk,
  DiffLine,
  RuleHit,
} from './core/model/request.js';
export type { Severity, FileStatus, ReviewMode } from './core/types.js';
