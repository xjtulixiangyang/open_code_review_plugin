# Task 3 Report: Align range diff and stable prepare errors

## Files Changed
- `src/core/diff/git.ts` — Added `--find-renames` to workspace/staged/commit/range args; implemented merge-base range diff (`from..to` splits, resolves merge-base, diffs merge-base..to)
- `src/core/context/review_context.ts` — Wrapped `gitRevParseToplevel` in try/catch to throw `OCRP-RUN-010: Not a git repository at <path>: <msg>`
- `src/core/context/__tests__/review_context.test.ts` — Appended `buildReviewContext reports OCRP-RUN-010 outside a git repository` test
- `src/core/diff/__tests__/git.test.ts` — New file with `range diff uses merge-base semantics for diverged branches` test

## Tests Run
- `npm test -- src/core/context/__tests__/review_context.test.ts src/core/diff/__tests__/git.test.ts` — All 6 tests pass (4 existing + 2 new)
- `npm run typecheck` — Passes with no errors

## Commit Hash
`f689104` (Task 2) → `328ec93` (Task 3)

## Self-Review
- TDD followed: tests written first (red), then implementation (green)
- Non-git repo test confirms `OCRP-RUN-010` error code surfaces instead of raw git error
- Range merge-base test confirms `main..feature` only includes `feature.ts`, not `main.ts` (diverged branches)
- `--find-renames` added to all git diff commands for rename detection
- `gitRevParseToplevel` error wrapping uses `err instanceof Error` pattern per plan
- No runtime dependencies or LLM SDK imports
- No `.claude/settings.local.json`, `.claude/worktrees`, or plan file committed

## Concerns
- The merge-base approach (`git merge-base from to` then `git diff mergeBase to`) is correct for `from..to` semantics, but `from...to` (three-dot) is not handled — the plan specifies two-dot range only, so this is correct for P0
- No additional tests for staged/commit/workspace `--find-renames` behavior — existing tests cover these paths indirectly through the integration tests

## Fix Attempt 4: Indentation Fix for try/catch in review_context.ts

**File:** `src/core/context/review_context.ts`

**Finding:** The `try/catch` block around `gitRevParseToplevel` was indented at column 0 instead of being indented by 2 spaces to match the function scope.

**Fix:** Added 2 spaces of indentation to the `try`, `catch`, and their block bodies.

**Verification:**
- `npm test -- src/core/context/__tests__/review_context.test.ts src/core/diff/__tests__/git.test.ts` — PASSED (all 6 tests passing)
- `npm run typecheck` — PASSED (no type errors)

**Status:** Fixed and committed.
