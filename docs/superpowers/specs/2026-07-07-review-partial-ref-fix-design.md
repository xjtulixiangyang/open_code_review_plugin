# Review Partial Reporting and Ref Parsing Fix Design

Date: 2026-07-07

## Goal

Fix three issues discovered during OCR self-review without expanding the review orchestration surface:

1. Markdown reports must not say review is complete when `partial=true`.
2. `resolveContextRef()` must parse three-dot ranges such as `main...feature` correctly.
3. The `/review` command documentation must make the existing one-retry reviewer behavior and partial-report meaning explicit.

## Scope

This is a minimal follow-up. It does not add new report JSON fields, configurable retry counts, or persistent attempt logs. Existing `ocr-aggregate` JSON schema remains stable.

## Current Problems

### Misleading partial markdown

`src/core/report/markdown.ts` currently emits:

```text
Review complete — no issues found in N file(s).
```

whenever the visible comment list is empty. During self-review, reviewer subagents failed before calling `task_done`, so `partialFiles` was non-empty but the report still said review was complete. That is misleading.

### Three-dot range parsing

`src/core/tools/context_ref.ts` uses `indexOf('..')`. For `main...feature`, that returns `.feature` instead of `feature`.

### Retry/partial semantics are easy to miss

`commands/review.md` already says reviewer dispatch should retry once if the subagent errors, times out, or returns without a matching `task_done`. The wording should be made explicit enough that future command updates do not treat partial reports as successful no-issue reviews.

## Design

### 1. Markdown partial report wording

Update `renderMarkdownReport()` so the no-visible-comments branch distinguishes complete vs incomplete review:

- If `partialFiles.length === 0` and visible comments are empty:
  - keep: `Review complete — no issues found in N file(s).`
- If `partialFiles.length > 0` and visible comments are empty:
  - emit: `Review incomplete — no issues were reported by completed reviewers.`
  - emit: `Files incomplete: <partialFiles.length>`

The existing Warnings section remains at the top and lists each incomplete file.

If visible comments exist and `partialFiles.length > 0`, the report continues to render the comments normally. The Warnings section is sufficient to show the review was partial.

### 2. JSON report remains unchanged

Keep `renderJsonReport()` behavior:

- `status: "completed_with_warnings"` when `partialFiles.length > 0`
- `warnings[]` contains `subagent did not call task_done`
- no new fields

This avoids breaking downstream consumers.

### 3. Ref parser supports three-dot ranges

Update `resolveContextRef(ctx)` precedence:

1. `workspace` / `staged` → `undefined`
2. `commit:<ref>` → `<ref>` trimmed
3. range containing `...` → substring after the last `...`, trimmed
4. range containing `..` → substring after the last `..`, trimmed
5. otherwise trimmed `ctx.range`

Using `lastIndexOf` avoids incorrectly slicing from the first two dots in a three-dot range.

### 4. Command documentation clarifies retry and partial meaning

Update `commands/review.md` near reviewer dispatch and final reporting:

- Reviewer failures must be retried once with `reviewer-<index>-attempt-2`.
- Retry is triggered by subagent error, timeout, or missing matching `task_done` marker.
- If retry also fails, continue and let aggregate mark the file partial.
- Final response must not describe `partial=true` as a clean no-issues review; it should say some files did not complete review.

No runtime code changes are needed for retry in this follow-up because `/review` command instructions already define the control flow.

## Tests

Add or update tests:

1. `src/core/report/__tests__/markdown.test.ts`
   - partial + zero comments renders `Review incomplete` and does not render `Review complete`.
   - complete + zero comments still renders `Review complete`.

2. `src/core/tools/__tests__/context_file_reader.test.ts`
   - `resolveContextRef(ctx('/repo', 'main...feature')) === 'feature'`.
   - existing two-dot test still passes.

3. Existing command/prompt consistency tests if suitable
   - assert `commands/review.md` contains retry-on-missing-`task_done` semantics and partial final-report wording.
   - If no existing test is suitable, this can be covered by direct review plus existing docs tests; do not introduce brittle over-testing.

## Verification

Run at minimum:

```bash
npm test -- src/core/report/__tests__/markdown.test.ts src/core/tools/__tests__/context_file_reader.test.ts
npm run typecheck
npm run build
npm run smoke
```

If package test glob runs more tests than named files, all invoked tests must pass.

## Non-goals

- Do not add retry attempt counters to `report.json`.
- Do not add configurable retry count.
- Do not change `ocr-aggregate` summary JSON shape.
- Do not refactor reviewer dispatch beyond command documentation in this change.

## Self-review

- No placeholders remain.
- JSON schema stability is explicit.
- Partial markdown behavior is unambiguous.
- Range parsing precedence covers `commit:`, `...`, `..`, and simple refs.
- Scope is small enough for one implementation plan.
