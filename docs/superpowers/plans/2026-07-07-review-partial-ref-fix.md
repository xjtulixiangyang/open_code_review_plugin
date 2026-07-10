# Review Partial Reporting and Ref Parsing Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix misleading partial review reports, three-dot range parsing, and reviewer retry/partial documentation with minimal schema-safe changes.

**Architecture:** Keep runtime changes small and localized: markdown rendering decides complete vs incomplete no-comment reports, `resolveContextRef()` owns ref parsing precedence, and `/review` command docs clarify existing retry semantics. JSON report shape and aggregate summary remain unchanged.

**Tech Stack:** TypeScript ESM, Node.js built-in test runner, Markdown command/skill docs, existing `ocr-aggregate` report renderer.

## Global Constraints

- Do not add retry attempt counters to `report.json`.
- Do not add configurable retry count.
- Do not change `ocr-aggregate` summary JSON shape.
- Do not refactor reviewer dispatch beyond command documentation in this change.
- Keep `status: "completed_with_warnings"` when `partialFiles.length > 0` in JSON reports.
- Preserve existing complete no-comment markdown wording when `partialFiles.length === 0`.

---

## File Structure

- Modify `src/core/report/markdown.ts` — distinguish no-comment complete vs no-comment incomplete reports.
- Modify `src/core/report/__tests__/markdown.test.ts` — cover partial no-comment wording and preserve complete no-comment wording.
- Modify `src/core/tools/context_ref.ts` — parse `...` before `..` and use `lastIndexOf`.
- Modify `src/core/tools/__tests__/context_file_reader.test.ts` — add three-dot range parser coverage.
- Modify `commands/review.md` — clarify one retry and partial final-report semantics.

---

### Task 1: Fix partial no-comment Markdown wording

**Files:**
- Modify: `src/core/report/markdown.ts:64-67`
- Test: `src/core/report/__tests__/markdown.test.ts`

**Interfaces:**
- Consumes: `renderMarkdownReport(ctx: ReviewContext, comments: CommentRecord[], opts: RenderOpts): string`
- Produces: Same function signature; new no-comment partial wording.

- [ ] **Step 1: Write failing tests for complete and incomplete no-comment reports**

Edit `src/core/report/__tests__/markdown.test.ts`. Replace the existing test named `renderMarkdownReport 无评论时输出 No issues 信息` with these two tests:

```ts
test('renderMarkdownReport 无评论且完整完成时输出 Review complete', () => {
  const md = renderMarkdownReport(CTX, [], { partialFiles: [] });
  assert.match(md, /Review complete — no issues found in 2 file\(s\)\./);
  assert.doesNotMatch(md, /Review incomplete/);
});

test('renderMarkdownReport 无评论但 partial 时不声称 review complete', () => {
  const md = renderMarkdownReport(CTX, [], { partialFiles: ['src/c.ts'] });
  assert.match(md, /⚠️ Warnings/);
  assert.match(md, /src\/c\.ts/);
  assert.match(md, /Review incomplete — no issues were reported by completed reviewers\./);
  assert.match(md, /Files incomplete: 1/);
  assert.doesNotMatch(md, /Review complete — no issues found/);
});
```

- [ ] **Step 2: Run the markdown tests and verify failure**

Run:

```bash
npm test -- src/core/report/__tests__/markdown.test.ts
```

Expected: FAIL because the partial no-comment report still contains `Review complete — no issues found`.

- [ ] **Step 3: Implement minimal markdown renderer change**

In `src/core/report/markdown.ts`, replace:

```ts
  if (comments.length === 0) {
    lines.push(`Review complete — no issues found in ${ctx.files.length} file(s).`);
    return lines.join('\n');
  }
```

with:

```ts
  if (comments.length === 0) {
    if (opts.partialFiles.length > 0) {
      lines.push('Review incomplete — no issues were reported by completed reviewers.');
      lines.push(`Files incomplete: ${opts.partialFiles.length}`);
    } else {
      lines.push(`Review complete — no issues found in ${ctx.files.length} file(s).`);
    }
    return lines.join('\n');
  }
```

- [ ] **Step 4: Run targeted tests**

Run:

```bash
npm test -- src/core/report/__tests__/markdown.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/core/report/markdown.ts src/core/report/__tests__/markdown.test.ts
git commit -m "fix(report): clarify partial no-comment markdown

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Fix three-dot range parsing

**Files:**
- Modify: `src/core/tools/context_ref.ts`
- Test: `src/core/tools/__tests__/context_file_reader.test.ts`

**Interfaces:**
- Consumes: `ReviewContext.range: string`
- Produces: `resolveContextRef(ctx: ReviewContext): string | undefined`

- [ ] **Step 1: Add failing test for three-dot range**

In `src/core/tools/__tests__/context_file_reader.test.ts`, after the existing test `resolveContextRef returns right side for two-dot range`, add:

```ts
test('resolveContextRef returns right side for three-dot range', () => {
  assert.equal(resolveContextRef(ctx('/repo', 'main...feature')), 'feature');
});
```

- [ ] **Step 2: Run context reader tests and verify failure**

Run:

```bash
npm test -- src/core/tools/__tests__/context_file_reader.test.ts
```

Expected: FAIL because current implementation returns `.feature`.

- [ ] **Step 3: Implement parser precedence**

Replace the body of `resolveContextRef` in `src/core/tools/context_ref.ts` with:

```ts
export function resolveContextRef(ctx: ReviewContext): string | undefined {
  if (ctx.range === 'workspace' || ctx.range === 'staged') return undefined;
  if (ctx.range.startsWith('commit:')) {
    const ref = ctx.range.slice('commit:'.length).trim();
    return ref || undefined;
  }
  const threeDotIdx = ctx.range.lastIndexOf('...');
  if (threeDotIdx !== -1) {
    const to = ctx.range.slice(threeDotIdx + 3).trim();
    return to || undefined;
  }
  const twoDotIdx = ctx.range.lastIndexOf('..');
  if (twoDotIdx !== -1) {
    const to = ctx.range.slice(twoDotIdx + 2).trim();
    return to || undefined;
  }
  const trimmed = ctx.range.trim();
  return trimmed || undefined;
}
```

- [ ] **Step 4: Run targeted tests**

Run:

```bash
npm test -- src/core/tools/__tests__/context_file_reader.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/core/tools/context_ref.ts src/core/tools/__tests__/context_file_reader.test.ts
git commit -m "fix(tools): parse three-dot review ranges

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Clarify reviewer retry and partial final-report documentation

**Files:**
- Modify: `commands/review.md:79-112`
- Modify: `commands/review.md:165`

**Interfaces:**
- Consumes: Existing `/open-code-review:review` command workflow.
- Produces: Clear command behavior: one retry on reviewer failure/missing `task_done`, then partial; final output must not call partial review a clean no-issue result.

- [ ] **Step 1: Inspect current retry wording**

Run:

```bash
grep -n "retry\|partial\|task_done\|final" commands/review.md
```

Expected: shows current retry and partial instructions around reviewer batching and final response.

- [ ] **Step 2: Update reviewer retry wording**

In `commands/review.md`, replace the current reviewer retry bullets around Step 3 with this exact wording, preserving surrounding sections:

```md
4. Retry reviewer dispatch exactly once for the same file when any of these happens:
   - the subagent errors;
   - the subagent times out;
   - the subagent returns but no matching `.ocr-runs/<runId>/done/reviewer-*.json` entry exists for that file.
   Use `reviewer-<index>-attempt-2` for the retry subagent id. Do not retry a file after `task_done` is recorded.
5. If both attempts fail, continue to the next file and let `ocr-aggregate` report the file as partial (`OCRP-SUB-050/051`). A partial file means review did not complete for that file; it must not be described as a clean no-issue result.
```

- [ ] **Step 3: Update final response wording**

In `commands/review.md`, replace:

```md
If `partial == true`, prefix your message with: `⚠️ Some files did not complete review; see Warnings section.`
```

with:

```md
If `partial == true`, prefix your message with: `⚠️ Some files did not complete review; see Warnings section.` Do not summarize the run as "no issues found" without also saying the review was incomplete for `partialFiles[]`.
```

- [ ] **Step 4: Verify the doc contains required semantics**

Run:

```bash
grep -n "Retry reviewer dispatch exactly once\|must not be described as a clean no-issue result\|Do not summarize the run as" commands/review.md
```

Expected: all three phrases appear.

- [ ] **Step 5: Commit Task 3**

```bash
git add commands/review.md
git commit -m "docs(review): clarify reviewer retry partial semantics

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Final verification

**Files:**
- No code changes expected beyond Tasks 1-3.

**Interfaces:**
- Consumes: all changes from Tasks 1-3.
- Produces: verified branch ready for PR/update.

- [ ] **Step 1: Run full verification**

Run:

```bash
npm test -- src/core/report/__tests__/markdown.test.ts src/core/tools/__tests__/context_file_reader.test.ts
npm run typecheck
npm run build
npm run smoke
```

Expected: all PASS. Note that the project npm test glob may run more than the two named test files; all invoked tests must pass.

- [ ] **Step 2: Inspect final diff**

Run:

```bash
git diff --stat HEAD~3..HEAD
git log --oneline -5
```

Expected: only markdown report tests/renderer, context ref tests/parser, and commands/review.md changed after the design commit.

- [ ] **Step 3: Push branch**

```bash
git push
```

Expected: branch updates successfully.

---

## Self-Review

**Spec coverage:** Task 1 covers misleading partial markdown and preserves JSON schema. Task 2 covers three-dot range parsing. Task 3 covers reviewer retry and partial final-report documentation. Task 4 covers required verification.

**Placeholder scan:** No placeholders, TBDs, or vague implementation steps remain.

**Type consistency:** Function signatures remain unchanged: `renderMarkdownReport(...)` and `resolveContextRef(ctx)` keep existing public interfaces.
