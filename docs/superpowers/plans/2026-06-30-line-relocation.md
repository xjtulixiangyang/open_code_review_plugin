# Line Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement P1-A2 line resolver / `RE_LOCATION_TASK` so visible review comments are normalized to current new-file line ranges before report rendering.

**Architecture:** Add deterministic relocation models and resolver, store per-file relocation audit records under `.ocr-runs/<runId>/relocations/`, add `ocr-relocate-apply`, and make aggregate apply relocation decisions after filters. Keep raw `comments.jsonl` unchanged; relocation failures are soft and reports still render.

**Tech Stack:** TypeScript 5.5 strict mode · Node >=18 ESM · Node built-in `node:test` via `tsx` · zero runtime npm dependencies · git CLI · Claude Code plugin files.

## Global Constraints

- Base spec: `docs/superpowers/specs/2026-06-30-line-relocation-design.md`.
- Preserve OCR-compatible `LlmComment` fields; relocation changes final report layer only.
- Do not introduce an LLM SDK, HTTP client, API key setting, or runtime npm dependency.
- Use TDD: every production behavior change starts with a failing test.
- Relocation failures are soft; aggregate must still produce reports.
- Keep severity, GitHub/GitLab posting, retry/resume, and custom rules out of scope.
- Each task ends with verification and a commit.

---

## File Structure

### Files created

- `src/core/model/relocation.ts` — relocation decision/result/warning types.
- `src/core/relocation/resolve.ts` — deterministic location resolver.
- `src/core/relocation/__tests__/resolve.test.ts` — resolver behavior tests.
- `src/core/runs/__tests__/store_relocation.test.ts` — relocation audit store tests.
- `src/cli/relocate_apply.ts` — deterministic relocation CLI.
- `src/cli/__tests__/relocate_apply.test.ts` — CLI tests.
- `src/cli/__tests__/aggregate_relocation.test.ts` — aggregate relocation tests.
- `skills/ocr-relocate/SKILL.md` — LLM fallback skill contract.

### Files modified

- `src/core/runs/store.ts` — add relocation storage helpers.
- `src/cli/aggregate.ts` — apply relocation decisions after filter decisions.
- `src/core/report/json.ts` — add relocated/fallback counts and relocation warnings.
- `src/core/report/markdown.ts` — add relocation summary line.
- `scripts/shebang.mjs` — map `relocate_apply` to `ocr-relocate-apply`.
- `scripts/smoke.sh` — cover relocation path.
- `commands/review.md` — add Step 3.6 relocation orchestration.
- `README.md` — document relocation capability and errors.

---

### Task 1: Deterministic resolver

**Files:**
- Create: `src/core/model/relocation.ts`
- Create: `src/core/relocation/resolve.ts`
- Test: `src/core/relocation/__tests__/resolve.test.ts`

**Interfaces:**
- Consumes: `FileChange`, `Hunk`, `DiffLine`, `CommentRecord`.
- Produces: `resolveCommentLocation(file: FileChange, comment: CommentRecord, newFileText?: string): RelocationDecision`.

- [ ] **Step 1: Write failing tests**

Create resolver tests covering unchanged added line, `existing_code` in diff, `existing_code` in file text, clamped line, fallback original.

- [ ] **Step 2: Run RED**

```bash
npm test -- src/core/relocation/__tests__/resolve.test.ts
```

Expected: FAIL because resolver files do not exist.

- [ ] **Step 3: Implement resolver**

Create model types and resolver. Resolver should compute new-side valid lines from hunks, match `existing_code` exact/trimmed against diff new-side lines, then optional file text, then clamp, then fallback.

- [ ] **Step 4: Run GREEN**

```bash
npm test -- src/core/relocation/__tests__/resolve.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/model/relocation.ts src/core/relocation/resolve.ts src/core/relocation/__tests__/resolve.test.ts
git commit -m "feat: 增加确定性评论行号解析器

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Relocation store helpers

**Files:**
- Modify: `src/core/runs/store.ts`
- Test: `src/core/runs/__tests__/store_relocation.test.ts`

**Interfaces:**
- Produces: `writeRelocationResult(runId, result)`, `readRelocationResults(runId)`.

- [ ] **Step 1: Write failing store tests**

Test missing dir returns `{ results: [], warnings: [] }`, roundtrip works, malformed JSON yields `relocation_parse_error` warning.

- [ ] **Step 2: Run RED**

```bash
npm test -- src/core/runs/__tests__/store_relocation.test.ts
```

Expected: FAIL because helpers do not exist.

- [ ] **Step 3: Implement store helpers**

Mirror filter helpers, using `.ocr-runs/<runId>/relocations/<safePathKey>.json`.

- [ ] **Step 4: Run GREEN**

```bash
npm test -- src/core/runs/__tests__/store_relocation.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/runs/store.ts src/core/runs/__tests__/store_relocation.test.ts
git commit -m "feat: 增加 relocation 审计存储

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: ocr-relocate-apply CLI

**Files:**
- Create: `src/cli/relocate_apply.ts`
- Modify: `scripts/shebang.mjs`
- Test: `src/cli/__tests__/relocate_apply.test.ts`

**Interfaces:**
- Consumes: `resolveCommentLocation`, context, comments, filters.
- Produces: `ocr-relocate-apply --runId <id> --path <file>`.

- [ ] **Step 1: Write failing CLI tests**

Test CLI writes relocation file, skips filtered comments, rejects path outside context with `OCRP-RELOCATE-081`.

- [ ] **Step 2: Run RED**

```bash
npm test -- src/cli/__tests__/relocate_apply.test.ts
```

Expected: FAIL because CLI does not exist.

- [ ] **Step 3: Implement CLI and bin mapping**

Read context/comments/filters, optional repo file text, resolve visible comments, write relocation result, output counts.

- [ ] **Step 4: Run GREEN**

```bash
npm test -- src/cli/__tests__/relocate_apply.test.ts && npm run build
```

Expected: PASS and `ocr-relocate-apply` bin emitted.

- [ ] **Step 5: Commit**

```bash
git add src/cli/relocate_apply.ts src/cli/__tests__/relocate_apply.test.ts scripts/shebang.mjs
git commit -m "feat: 增加 relocate apply CLI

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Aggregate applies relocations

**Files:**
- Modify: `src/cli/aggregate.ts`
- Modify: `src/core/report/json.ts`
- Modify: `src/core/report/markdown.ts`
- Test: `src/cli/__tests__/aggregate_relocation.test.ts`

**Interfaces:**
- Consumes: `readRelocationResults(runId)`.
- Produces: normalized report comments and relocation summary counts.

- [ ] **Step 1: Write failing aggregate test**

Write context/comment/relocation result, run aggregate, assert report line changed and JSON summary includes relocation counts.

- [ ] **Step 2: Run RED**

```bash
npm test -- src/cli/__tests__/aggregate_relocation.test.ts
```

Expected: FAIL because aggregate ignores relocations.

- [ ] **Step 3: Implement aggregate relocation pass**

Apply decisions to visible comments by `comment_id`; record warnings for unknown/mismatched decisions; render summaries.

- [ ] **Step 4: Run GREEN**

```bash
npm test -- src/cli/__tests__/aggregate_relocation.test.ts src/cli/__tests__/aggregate_filter.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/aggregate.ts src/core/report/json.ts src/core/report/markdown.ts src/cli/__tests__/aggregate_relocation.test.ts
git commit -m "feat: aggregate 应用 relocation 结果

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Skill/docs/smoke wiring

**Files:**
- Create: `skills/ocr-relocate/SKILL.md`
- Modify: `commands/review.md`
- Modify: `README.md`
- Modify: `scripts/smoke.sh`

**Interfaces:**
- Produces: documented Step 3.6 and smoke proof.

- [ ] **Step 1: Update smoke first**

Extend smoke to create a wrong-line comment with `existing_code`, run `ocr-relocate-apply`, then aggregate and assert report uses resolved line.

- [ ] **Step 2: Run smoke/build**

```bash
npm run build && npm run smoke
```

Expected: PASS after Task 3/4.

- [ ] **Step 3: Add skill and docs**

Add `skills/ocr-relocate/SKILL.md`, command Step 3.6, README rows/error codes.

- [ ] **Step 4: Verify**

```bash
npm run build && npm run smoke && npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/ocr-relocate/SKILL.md commands/review.md README.md scripts/smoke.sh
git commit -m "docs: 接入 RE_LOCATION_TASK 编排

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Final verification

**Files:**
- No source changes expected unless verification exposes defects.

- [ ] **Step 1: Run full suite**

```bash
npm test
npm run typecheck
npm run build
npm run smoke
```

Expected: all pass.

- [ ] **Step 2: Inspect status**

```bash
git status --short
```

Expected: clean.

- [ ] **Step 3: Commit any verification fixes**

Only if needed.

- [ ] **Step 4: Final evidence**

Report exact pass/fail status for all commands.
