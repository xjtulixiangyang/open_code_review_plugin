# REVIEW_FILTER_TASK Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement P1-A1 `REVIEW_FILTER_TASK`: hide low-quality review comments through a per-file filter stage while preserving raw comments and audit records.

**Architecture:** Keep raw `comments.jsonl` append-only. Add stable `comment_id` to runtime `CommentRecord`, add per-file filter audit files under `.ocr-runs/<runId>/filters/`, and make aggregate render only visible comments while exposing raw/filtered counts. Host LLM decides filter output via a new skill; deterministic CLI validates and writes audit records.

**Tech Stack:** TypeScript 5.5 strict mode · Node >=18 ESM · Node built-in `node:test` via `tsx` · zero runtime npm dependencies · git CLI · Claude Code plugin files.

## Global Constraints

- Base spec: `docs/superpowers/specs/2026-06-30-review-filter-design.md`.
- Preserve OCR-compatible `LlmComment` fields; add plugin fields only to `CommentRecord` / report layer.
- Do not introduce an LLM SDK, HTTP client, API key setting, or runtime npm dependency.
- Use TDD: every production behavior change starts with a failing test.
- Filter failures are soft unless `ocr-filter-apply` receives invalid direct input; aggregate must still produce reports.
- Keep P1-A2/P1-A3/P1-B1/P1-D1 out of scope.
- Each task ends with verification and a commit.

---

## File Structure

### Files created

- `src/core/model/filter.ts` — `FilterDecision`, `FilterFileResult`, `ReadFilterResultsOutput`, `FilterWarning` types.
- `src/cli/filter_apply.ts` — deterministic `ocr-filter-apply` CLI.
- `src/cli/__tests__/code_comment_id.test.ts` — verifies generated `comment_id` behavior.
- `src/core/runs/__tests__/store_filter.test.ts` — verifies filter audit storage helpers.
- `src/cli/__tests__/filter_apply.test.ts` — verifies CLI validation and writing.
- `src/cli/__tests__/aggregate_filter.test.ts` — verifies aggregate hides filtered comments.
- `skills/ocr-review-filter/SKILL.md` — host LLM per-file filter task.

### Files modified

- `src/core/model/comment.ts` — add `comment_id` to `CommentRecord`.
- `src/cli/code_comment.ts` — generate `comment_id` with `randomUUID()` and include it in stdout.
- `src/core/runs/store.ts` — add filter helpers and safe path key.
- `src/core/report/markdown.ts` — render filtered summary when hidden comments exist.
- `src/core/report/json.ts` — add raw/filtered comment counts and filter warnings.
- `src/cli/aggregate.ts` — read filters, hide comments, output filter summary.
- `src/cli/__tests__/roundtrip.test.ts` — cover comment/filter/aggregate roundtrip.
- `scripts/shebang.mjs` — map `filter_apply` to `ocr-filter-apply`.
- `scripts/smoke.sh` — smoke filter hide path.
- `commands/review.md` — add Step 3.5 filter orchestration and error codes.
- `README.md` — document filter stage and errors.

---

### Task 1: Add stable comment_id to comments

**Files:**
- Modify: `src/core/model/comment.ts`
- Modify: `src/cli/code_comment.ts`
- Test: `src/cli/__tests__/code_comment_id.test.ts`

**Interfaces:**
- Consumes: `appendComment(runId: string, c: unknown): Promise<void>`.
- Produces: `CommentRecord.comment_id: string`; `code_comment` stdout includes `comment_id`.

- [ ] **Step 1: Write failing tests**

Create `src/cli/__tests__/code_comment_id.test.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX_LOADER = join(ROOT, 'node_modules/tsx/dist/loader.mjs');

async function runCodeComment(cwd: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX_LOADER, join(ROOT, 'src/cli/code_comment.ts'), ...args], { cwd });
}

test('code_comment generates stable comment_id in stdout and jsonl', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-comment-id-'));
  try {
    const first = await runCodeComment(dir, ['--runId', 'run1', '--path', 'src/a.ts', '--start', '1', '--end', '1', '--content', 'first', '--subagent', 'reviewer-a']);
    const second = await runCodeComment(dir, ['--runId', 'run1', '--path', 'src/a.ts', '--start', '2', '--end', '2', '--content', 'second', '--subagent', 'reviewer-a']);

    const firstOut = JSON.parse(first.stdout) as { comment_id: string };
    const secondOut = JSON.parse(second.stdout) as { comment_id: string };

    assert.match(firstOut.comment_id, /^c-[0-9a-f-]{36}$/);
    assert.match(secondOut.comment_id, /^c-[0-9a-f-]{36}$/);
    assert.notEqual(firstOut.comment_id, secondOut.comment_id);

    const body = await readFile(join(dir, '.ocr-runs/run1/comments.jsonl'), 'utf8');
    const lines = body.trim().split('\n').map((line) => JSON.parse(line) as { comment_id: string; content: string });
    assert.equal(lines.length, 2);
    assert.equal(lines[0].comment_id, firstOut.comment_id);
    assert.equal(lines[1].comment_id, secondOut.comment_id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/cli/__tests__/code_comment_id.test.ts
```

Expected: FAIL because stdout lacks `comment_id` and JSONL has no `comment_id`.

- [ ] **Step 3: Implement minimal code**

In `src/core/model/comment.ts`, add:

```ts
export interface CommentRecord extends LlmComment {
  comment_id: string;
  _meta?: {
    subagent?: string;
    ts?: string;
  };
}
```

In `src/cli/code_comment.ts`, import `randomUUID`:

```ts
import { randomUUID } from 'node:crypto';
```

Set `comment_id` on the record:

```ts
const rec: CommentRecord = {
  comment_id: `c-${randomUUID()}`,
  path: f.path,
  start_line: parseInt(f.start, 10),
  end_line: parseInt(f.end, 10),
  content: f.content,
};
```

Include it in stdout:

```ts
JSON.stringify({ ok: true, path: rec.path, start: rec.start_line, end: rec.end_line, comment_id: rec.comment_id }) + '\n'
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- src/cli/__tests__/code_comment_id.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/model/comment.ts src/cli/code_comment.ts src/cli/__tests__/code_comment_id.test.ts
git commit -m "feat: 为 review comment 生成稳定 id

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Add filter model and store helpers

**Files:**
- Create: `src/core/model/filter.ts`
- Modify: `src/core/runs/store.ts`
- Test: `src/core/runs/__tests__/store_filter.test.ts`

**Interfaces:**
- Produces: `safePathKey(path: string): string`, `writeFilterResult(runId, result)`, `readFilterResults(runId)`.

- [ ] **Step 1: Write failing tests**

Create `src/core/runs/__tests__/store_filter.test.ts`:

```ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFilterResults, safePathKey, writeFilterResult } from '../store.js';

test('safePathKey encodes slashes without creating directories', () => {
  assert.equal(safePathKey('src/a.ts'), 'src%2Fa.ts');
});

test('filter store roundtrips results and returns empty output when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-filter-store-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    assert.deepEqual(await readFilterResults('run1'), { results: [], warnings: [] });

    await writeFilterResult('run1', {
      path: 'src/a.ts',
      decisions: [{ comment_id: 'c-1', action: 'hide', reason: 'duplicate' }],
      _meta: { source: 'review_filter_task', subagent: 'filter-a', ts: 'now' },
    });

    const out = await readFilterResults('run1');
    assert.equal(out.warnings.length, 0);
    assert.deepEqual(out.results, [{
      path: 'src/a.ts',
      decisions: [{ comment_id: 'c-1', action: 'hide', reason: 'duplicate' }],
      _meta: { source: 'review_filter_task', subagent: 'filter-a', ts: 'now' },
    }]);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('readFilterResults skips malformed filter files with warnings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-filter-store-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await mkdir(join(dir, '.ocr-runs/run1/filters'), { recursive: true });
    await writeFile(join(dir, '.ocr-runs/run1/filters/bad.json'), '{not json', 'utf8');

    const out = await readFilterResults('run1');
    assert.deepEqual(out.results, []);
    assert.equal(out.warnings.length, 1);
    assert.equal(out.warnings[0].kind, 'filter_parse_error');
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/core/runs/__tests__/store_filter.test.ts
```

Expected: FAIL because exports do not exist.

- [ ] **Step 3: Implement minimal code**

Create `src/core/model/filter.ts`:

```ts
export interface FilterDecision {
  comment_id: string;
  action: 'hide';
  reason: string;
}

export interface FilterFileResult {
  path: string;
  decisions: FilterDecision[];
  _meta?: {
    source: 'review_filter_task';
    subagent?: string;
    ts?: string;
  };
}

export interface FilterWarning {
  kind: string;
  path?: string;
  detail: string;
}

export interface ReadFilterResultsOutput {
  results: FilterFileResult[];
  warnings: FilterWarning[];
}
```

In `src/core/runs/store.ts`, import `FilterFileResult` / `ReadFilterResultsOutput`, add `safePathKey`, `writeFilterResult`, `readFilterResults` using `mkdir`, `writeFile`, `readFile`, `readdir`, `join`.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- src/core/runs/__tests__/store_filter.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/model/filter.ts src/core/runs/store.ts src/core/runs/__tests__/store_filter.test.ts
git commit -m "feat: 增加 filter 审计存储模型

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Add ocr-filter-apply CLI

**Files:**
- Create: `src/cli/filter_apply.ts`
- Modify: `scripts/shebang.mjs`
- Test: `src/cli/__tests__/filter_apply.test.ts`

**Interfaces:**
- Consumes: `readContext`, `readComments`, `writeFilterResult`.
- Produces: `ocr-filter-apply --runId <id> --path <file> --input <json>`.

- [ ] **Step 1: Write failing tests**

Create `src/cli/__tests__/filter_apply.test.ts` with tests for valid apply, invalid path, missing reason, and unknown comment id.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/cli/__tests__/filter_apply.test.ts
```

Expected: FAIL because CLI does not exist.

- [ ] **Step 3: Implement CLI**

Implement `src/cli/filter_apply.ts` to parse flags, validate `FilterFileResult`, verify context file path, verify comment ids by path, write only valid decisions, output `{ runId, path, hiddenCount, filterPath }`, and use error codes `OCRP-FILTER-071/072`.

Update `scripts/shebang.mjs` map:

```js
filter_apply: 'ocr-filter-apply',
```

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- src/cli/__tests__/filter_apply.test.ts && npm run build
```

Expected: PASS and build emits `ocr-filter-apply`.

- [ ] **Step 5: Commit**

```bash
git add src/cli/filter_apply.ts src/cli/__tests__/filter_apply.test.ts scripts/shebang.mjs
git commit -m "feat: 增加 filter apply CLI

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Make aggregate apply filter results

**Files:**
- Modify: `src/cli/aggregate.ts`
- Modify: `src/core/report/json.ts`
- Modify: `src/core/report/markdown.ts`
- Test: `src/cli/__tests__/aggregate_filter.test.ts`
- Test: `src/cli/__tests__/roundtrip.test.ts`

**Interfaces:**
- Consumes: `readFilterResults(runId)`.
- Produces: aggregate stdout `rawCommentCount`, `commentCount`, `filteredCommentCount`, `filterWarnings`.

- [ ] **Step 1: Write failing aggregate test**

Create `src/cli/__tests__/aggregate_filter.test.ts` to write a context, two comments, one filter result, run aggregate, and assert only one comment is visible.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- src/cli/__tests__/aggregate_filter.test.ts
```

Expected: FAIL because aggregate ignores filters.

- [ ] **Step 3: Implement filtering in aggregate/report renderers**

Update report opts to include `rawCommentCount`, `filteredCommentCount`, `filterWarnings`, and render filtered summaries.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- src/cli/__tests__/aggregate_filter.test.ts src/cli/__tests__/roundtrip.test.ts src/core/report/__tests__/json.test.ts && npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/aggregate.ts src/core/report/json.ts src/core/report/markdown.ts src/cli/__tests__/aggregate_filter.test.ts src/cli/__tests__/roundtrip.test.ts src/core/report/__tests__/json.test.ts
git commit -m "feat: aggregate 使用 filter 结果生成报告

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Add filter skill and docs orchestration

**Files:**
- Create: `skills/ocr-review-filter/SKILL.md`
- Modify: `commands/review.md`
- Modify: `README.md`
- Modify: `scripts/smoke.sh`

**Interfaces:**
- Produces: documented Step 3.5, `OCRP-FILTER-*` errors, smoke proof.

- [ ] **Step 1: Write/update tests first**

Extend smoke or add a CLI smoke path that fails until `ocr-filter-apply` exists in bin.

- [ ] **Step 2: Verify RED if applicable**

Run:

```bash
npm run build && npm run smoke
```

Expected before wiring: smoke fails if it calls missing `ocr-filter-apply`.

- [ ] **Step 3: Add skill and docs**

Create `skills/ocr-review-filter/SKILL.md` with strict JSON output schema and hide-only rules. Update command Step 3.5 and README.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm run build && npm run smoke && npm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/ocr-review-filter/SKILL.md commands/review.md README.md scripts/smoke.sh
git commit -m "docs: 接入 REVIEW_FILTER_TASK 编排

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

- [ ] **Step 2: Inspect working tree**

```bash
git status --short
```

Expected: clean or only ignored local files.

- [ ] **Step 3: Commit any verification fixes**

If fixes were needed:

```bash
git add README.md commands/review.md scripts src
 git commit -m "chore: 完成 REVIEW_FILTER_TASK 验证

Co-Authored-By: Claude <noreply@anthropic.com>"
```

- [ ] **Step 4: Final evidence**

Final response must include:

```text
npm test: passed
npm run typecheck: passed
npm run build: passed
npm run smoke: passed
```
