# TS Tool Protocol Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `file_read_diff`, `code_comment`, and `task_done` from per-field CLI flags to a single `--runId <runId> --args '<json>'` JSON protocol that mirrors `open-code-review` Go tool semantics (`path_array`, `comments` array).

**Architecture:** A small TypeScript core provider layer (`src/core/tools/*`) owns validation and data shaping; the existing `src/cli/*` files become thin wrappers that parse `--runId`/`--args`, call the provider, print its return string, and convert thrown errors into tool-prefixed stderr. Old per-field flags are removed everywhere executable (CLI, agent prompt, skills, hook, smoke, tests).

**Tech Stack:** TypeScript (ES2022 / ESNext / `moduleResolution: bundler`), Node `--test`, `tsx` for running `.ts` directly, esbuild-free build via `tsc` + `scripts/build-mjs.mjs` + `scripts/shebang.mjs`.

## Global Constraints

- Node `>=18`; devDeps already present: `tsx@^4.16.0`, `typescript@^5.5.0`, `@types/node@^20.14.0`. Do NOT add new deps.
- `tsconfig.json`: `strict`, `noImplicitAny`, `isolatedModules`, `rootDir: src`, `outDir: dist`. Tests live under `src/**/__tests__/` and are excluded from compilation. No `Date.now()`/`Math.random()`/`argless new Date()` restrictions apply here (this is not a workflow script).
- Tests run via `node --import tsx --test src/**/__tests__/*.test.ts` (see `package.json` `"test"`). The tsx loader path used by existing CLI tests is `node_modules/tsx/dist/loader.mjs`.
- Storage layout is fixed and shared with `aggregate`/`filter_apply`/`relocate_apply`: `.ocr-runs/<runId>/{context.json,comments.jsonl,done/<subagent>.json}`. Do NOT change on-disk schemas.
- `CommentRecord` (snake_case) is the jsonl row schema and is OCR-compatible — keep `comment_id: c-<uuid>`, `_meta.subagent`, `_meta.ts`.
- Bin names are produced by `scripts/shebang.mjs`: `file_read_diff`, `code_comment`, `task_done` map 1:1 (no `ocr-` prefix). Do NOT rename bins.
- Error strings returned by providers are normal return values (mirroring Go `Execute` returning `(string, error)` with `nil` error). Only malformed CLI usage (missing `--runId`/`--args`, bad JSON) is a process exit code 2.
- Reviewer subagent tool list is locked: `Read, Glob, Grep, Bash`. The Bash tool is the only submission channel.
- Every task ends with `npm test`, `npm run typecheck`, or `npm run build` as specified, then a commit. Commit messages use Conventional Commits with a Chinese-style body where the existing repo does (follow `git log` tone).

---

## File Structure

```text
src/core/tools/
  args.ts            # NEW — shared parseToolArgs(argv): {runId, args} + JSON validation
  file_read_diff.ts # NEW — readFileDiff(args, ctx): string  (Go FileReadDiffProvider semantics)
  code_comment.ts   # NEW — parseComments(args): {records, error} + persistComments(runId, records): ids
  task_done.ts       # NEW — markTaskDone(args): {subagent, file}  (delegates to store.markDone)

src/cli/
  file_read_diff.ts  # REWRITE — thin wrapper over core/tools
  code_comment.ts    # REWRITE — thin wrapper over core/tools
  task_done.ts       # REWRITE — thin wrapper over core/tools

src/host/claude-code/
  hook_handler.ts    # MODIFY — parse --args JSON instead of per-field flags for progress/events

src/core/prompts/
  main_task.ts       # MODIFY — Tool Mapping lines switched to --args JSON syntax

agents/ocr-reviewer.md        # MODIFY — submission/completion examples to --args JSON
skills/ocr-review-file/SKILL.md # MODIFY — Tool Mapping to --args JSON
scripts/smoke.sh              # MODIFY — code_comment/task_done calls to --args JSON
README.md                     # MODIFY — keep mention of code_comment; update any per-field examples

src/core/tools/__tests__/args.test.ts            # NEW
src/core/tools/__tests__/file_read_diff.test.ts  # NEW
src/core/tools/__tests__/code_comment.test.ts    # NEW
src/core/tools/__tests__/task_done.test.ts       # NEW
src/cli/__tests__/roundtrip.test.ts              # MODIFY — invoke --args JSON
src/cli/__tests__/code_comment_id.test.ts        # MODIFY — invoke --args JSON
src/host/claude-code/__tests__/hook_handler.test.ts # MODIFY — --args JSON extraction
```

---

### Task 1: Shared `args.ts` core helper + tests

**Files:**
- Create: `src/core/tools/args.ts`
- Test: `src/core/tools/__tests__/args.test.ts`

**Interfaces:**
- Produces: `parseToolArgs(argv: string[]): { runId: string; args: Record<string, unknown> }` — throws `Error` with a clear message when `--runId` is missing, `--args` is missing, or `--args` is not a JSON object (arrays/primitives/scalars rejected). Consumed by Tasks 2–4.

- [ ] **Step 1: Write the failing test**

Create `src/core/tools/__tests__/args.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolArgs } from '../args.js';

test('parseToolArgs returns runId and parsed args object', () => {
  const out = parseToolArgs(['--runId', 'run1', '--args', '{"path":"src/a.ts"}']);
  assert.equal(out.runId, 'run1');
  assert.deepEqual(out.args, { path: 'src/a.ts' });
});

test('parseToolArgs throws when --runId missing', () => {
  assert.throws(() => parseToolArgs(['--args', '{}']), /missing --runId/);
});

test('parseToolArgs throws when --args missing', () => {
  assert.throws(() => parseToolArgs(['--runId', 'run1']), /missing --args/);
});

test('parseToolArgs rejects non-object JSON (array)', () => {
  assert.throws(
    () => parseToolArgs(['--runId', 'run1', '--args', '[1,2]']),
    /must be a JSON object/,
  );
});

test('parseToolArgs rejects malformed JSON', () => {
  assert.throws(
    () => parseToolArgs(['--runId', 'run1', '--args', '{not json}']),
    /SyntaxError|Unexpected|JSON/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/core/tools/__tests__/args.test.ts`
Expected: FAIL — `Cannot find module '../args.js'` / `parseToolArgs is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/tools/args.ts`:

```ts
/**
 * Shared CLI arg parsing for the three review tools.
 * All tools use: <tool> --runId <runId> --args '<json object>'.
 */

export interface ParsedToolArgs {
  runId: string;
  args: Record<string, unknown>;
}

function scanValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  return argv[i + 1];
}

export function parseToolArgs(argv: string[]): ParsedToolArgs {
  const runId = scanValue(argv, '--runId');
  if (!runId) throw new Error(`[tool] missing --runId`);
  const raw = scanValue(argv, '--args');
  if (raw === undefined) throw new Error(`[tool] missing --args`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[tool] --args is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[tool] --args must be a JSON object`);
  }
  return { runId, args: parsed as Record<string, unknown> };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/core/tools/__tests__/args.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/args.ts src/core/tools/__tests__/args.test.ts
git commit -m "feat(tools): add shared parseToolArgs for --runId/--args JSON wrapper"
```

---

### Task 2: `file_read_diff` core provider + CLI wrapper + tests

**Files:**
- Create: `src/core/tools/file_read_diff.ts`
- Modify: `src/cli/file_read_diff.ts`
- Test: `src/core/tools/__tests__/file_read_diff.test.ts`

**Interfaces:**
- Consumes: `parseToolArgs` from Task 1; `readContext` + `ReviewContext` from `src/core/runs/store.js` and `src/core/model/request.js`.
- Produces: `readFileDiff(args: Record<string, unknown>, ctx: ReviewContext): string` — returns formatted multi-file diff or an `Error: ...` string. The CLI wrapper `src/cli/file_read_diff.ts` calls `parseToolArgs`, loads context, calls `readFileDiff`, prints the string to stdout.

- [ ] **Step 1: Write the failing test**

Create `src/core/tools/__tests__/file_read_diff.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileDiff } from '../file_read_diff.js';
import type { ReviewContext } from '../../core/model/request.js';

function ctxWith(paths: Array<{ path: string; diff: string; truncated?: boolean }>): ReviewContext {
  return {
    runId: 'run1',
    repoRoot: '/repo',
    range: 'workspace',
    background: '',
    files: paths.map((p) => ({
      path: p.path,
      status: 'modified',
      diff: p.diff,
      truncated: p.truncated ?? false,
      hunks: [],
      rulesHit: [],
    })),
    changeFiles: paths.map((p) => p.path),
    meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
  };
}

test('readFileDiff formats multiple files with ==== FILE headers', () => {
  const ctx = ctxWith([
    { path: 'src/a.ts', diff: '@@ -1 +1 @@\n-a\n+a2' },
    { path: 'src/b.ts', diff: '@@ -2 +2 @@\n-b\n+b2' },
  ]);
  const out = readFileDiff({ path_array: ['src/a.ts', 'src/b.ts'] }, ctx);
  assert.match(out, /==== FILE: src\/a\.ts ====/);
  assert.match(out, /@@ -1 \+1 @@/);
  assert.match(out, /==== FILE: src\/b\.ts ====/);
});

test('readFileDiff ignores unknown paths but returns found ones', () => {
  const ctx = ctxWith([{ path: 'src/a.ts', diff: 'DIFF_A' }]);
  const out = readFileDiff({ path_array: ['src/a.ts', 'src/missing.ts'] }, ctx);
  assert.match(out, /DIFF_A/);
  assert.doesNotMatch(out, /missing\.ts/);
});

test('readFileDiff returns error when path_array empty', () => {
  const out = readFileDiff({ path_array: [] }, ctxWith([]));
  assert.equal(out, 'Error: no files found');
});

test('readFileDiff returns error when no path resolves', () => {
  const ctx = ctxWith([{ path: 'src/a.ts', diff: 'DIFF_A' }]);
  const out = readFileDiff({ path_array: ['src/missing.ts'] }, ctx);
  assert.equal(out, 'Error: diff not found for the requested paths');
});

test('readFileDiff appends truncation marker', () => {
  const ctx = ctxWith([{ path: 'src/a.ts', diff: 'PARTIAL', truncated: true }]);
  const out = readFileDiff({ path_array: ['src/a.ts'] }, ctx);
  assert.match(out, /\.\.\. \(truncated\)/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/core/tools/__tests__/file_read_diff.test.ts`
Expected: FAIL — `Cannot find module '../file_read_diff.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/tools/file_read_diff.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/core/tools/__tests__/file_read_diff.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Rewrite the CLI wrapper**

Replace the entire contents of `src/cli/file_read_diff.ts`:

```ts
#!/usr/bin/env node
import { parseToolArgs } from '../core/tools/args.js';
import { readFileDiff } from '../core/tools/file_read_diff.js';
import { readContext } from '../core/runs/store.js';
import type { ReviewContext } from '../core/model/request.js';

async function main(): Promise<void> {
  const { runId, args } = parseToolArgs(process.argv.slice(2));
  const ctx = await readContext<ReviewContext>(runId);
  const result = readFileDiff(args, ctx);
  process.stdout.write(result + (result.endsWith('\n') ? '' : '\n'));
}

main().catch((err) => {
  process.stderr.write(`[file_read_diff] ${err?.message ?? err}\n`);
  process.exit(2);
});
```

- [ ] **Step 6: Run typecheck + the new test**

Run: `npm run typecheck && npm test -- src/core/tools/__tests__/file_read_diff.test.ts`
Expected: typecheck clean; test PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/tools/file_read_diff.ts src/core/tools/__tests__/file_read_diff.test.ts src/cli/file_read_diff.ts
git commit -m "feat(tools): file_read_diff path_array JSON protocol (Go-aligned)"
```

---

### Task 3: `code_comment` core provider + CLI wrapper + tests

**Files:**
- Create: `src/core/tools/code_comment.ts`
- Modify: `src/cli/code_comment.ts`
- Test: `src/core/tools/__tests__/code_comment.test.ts`

**Interfaces:**
- Consumes: `parseToolArgs` (Task 1); `appendComment` from `src/core/runs/store.js`; `CommentRecord` from `src/core/model/comment.js`.
- Produces:
  - `parseComments(args: Record<string, unknown>): { records: CommentRecord[]; error?: string }` — mirrors Go `ParseComments`; top-level `path` applies to each; skips invalid items; returns `error` string when no `comments` array / no valid comments.
  - `persistComments(runId: string, records: CommentRecord[]): Promise<string[]>` — appends each record to `comments.jsonl`, returns the generated `comment_id` list.
  - The CLI wrapper returns `{"ok":true,"count":N,"comment_ids":[...]}` on success, or the provider error string on stdout exit 0 (mirroring Go returning an error message, not a crash).

- [ ] **Step 1: Write the failing test**

Create `src/core/tools/__tests__/code_comment.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseComments, persistComments } from '../code_comment.js';
import { writeContext } from '../../core/runs/store.js';
import type { ReviewContext } from '../../core/model/request.js';

const CTX: ReviewContext = {
  runId: 'run1', repoRoot: '/repo', range: 'workspace', background: '',
  files: [{ path: 'src/a.ts', status: 'modified', diff: '', truncated: false, hunks: [], rulesHit: [] }],
  changeFiles: ['src/a.ts'],
  meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
};

test('parseComments builds records with comment_id from top-level path', () => {
  const { records, error } = parseComments({
    path: 'src/a.ts',
    subagent: 'reviewer-a',
    comments: [
      { content: 'issue one', start_line: 10, end_line: 12 },
      { content: 'issue two', start_line: 20, end_line: 20, suggestion_code: 'fix()' },
    ],
  });
  assert.equal(error, undefined);
  assert.equal(records.length, 2);
  assert.equal(records[0].path, 'src/a.ts');
  assert.equal(records[0].start_line, 10);
  assert.match(records[0].comment_id, /^c-/);
  assert.equal(records[0]._meta?.subagent, 'reviewer-a');
  assert.equal(records[1].suggestion_code, 'fix()');
});

test('parseComments skips invalid items (missing content / lines)', () => {
  const { records } = parseComments({
    path: 'src/a.ts',
    comments: [
      { start_line: 1, end_line: 1 }, // no content
      { content: 'ok', start_line: 1, end_line: 1 },
    ],
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].content, 'ok');
});

test('parseComments error when comments missing', () => {
  const { error } = parseComments({ path: 'src/a.ts' });
  assert.match(error ?? '', /'comments' array is required/);
});

test('parseComments error when path missing', () => {
  const { error } = parseComments({ comments: [{ content: 'x', start_line: 1, end_line: 1 }] });
  assert.equal(error, "Error: 'path' is required");
});

test('parseComments error when no valid comments', () => {
  const { error } = parseComments({ path: 'src/a.ts', comments: [{ start_line: 1, end_line: 1 }] });
  assert.equal(error, 'Error: no valid comments found');
});

test('persistComments appends one jsonl row per record with id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-code-comment-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run1', CTX);
    const { records } = parseComments({
      path: 'src/a.ts', subagent: 'reviewer-a',
      comments: [{ content: 'first', start_line: 1, end_line: 1 }],
    });
    const ids = await persistComments('run1', records);
    assert.equal(ids.length, 1);
    assert.equal(ids[0], records[0].comment_id);

    const body = await readFile(join(dir, '.ocr-runs/run1/comments.jsonl'), 'utf8');
    const row = JSON.parse(body.trim());
    assert.equal(row.comment_id, ids[0]);
    assert.equal(row._meta.subagent, 'reviewer-a');
    assert.ok(row._meta.ts);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/core/tools/__tests__/code_comment.test.ts`
Expected: FAIL — `Cannot find module '../code_comment.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/tools/code_comment.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { appendComment } from '../runs/store.js';
import type { CommentRecord } from '../model/comment.js';

/**
 * Mirrors open-code-review ParseComments. Returns parsed CommentRecords (with
 * generated comment_id + _meta) and an upstream-style error string when input
 * is missing or yields no valid comments.
 */
export function parseComments(args: Record<string, unknown>): {
  records: CommentRecord[];
  error?: string;
} {
  const path = typeof args['path'] === 'string' ? (args['path'] as string) : '';
  if (!path) return { records: [], error: "Error: 'path' is required" };

  const subagent = typeof args['subagent'] === 'string' ? (args['subagent'] as string) : 'unknown';

  let rawComments: unknown;
  if (Array.isArray(args['comments'])) {
    rawComments = args['comments'];
  } else if (typeof args['comments'] === 'string' && (args['comments'] as string) !== '') {
    try {
      rawComments = JSON.parse(args['comments'] as string);
    } catch (err) {
      return { records: [], error: `Error: failed to parse 'comments' JSON string: ${(err as Error).message}` };
    }
  } else {
    const raw = JSON.stringify(args);
    return { records: [], error: `Error: 'comments' array is required. Got args: ${raw}` };
  }

  if (!Array.isArray(rawComments)) {
    const raw = JSON.stringify(args);
    return { records: [], error: `Error: 'comments' array is required. Got args: ${raw}` };
  }

  const records: CommentRecord[] = [];
  for (const item of rawComments) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const content = typeof obj['content'] === 'string' ? (obj['content'] as string) : '';
    const start = toLineNumber(obj['start_line']);
    const end = toLineNumber(obj['end_line']);
    if (!content || start === null || end === null) continue;
    const rec: CommentRecord = {
      comment_id: `c-${randomUUID()}`,
      path,
      start_line: start,
      end_line: end,
      content,
    };
    if (typeof obj['suggestion_code'] === 'string') rec.suggestion_code = obj['suggestion_code'] as string;
    if (typeof obj['existing_code'] === 'string') rec.existing_code = obj['existing_code'] as string;
    if (typeof obj['thinking'] === 'string') rec.thinking = obj['thinking'] as string;
    rec._meta = { subagent, ts: new Date().toISOString() };
    records.push(rec);
  }
  if (records.length === 0) return { records: [], error: 'Error: no valid comments found' };
  return { records };
}

function toLineNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Appends each record to comments.jsonl, returning the generated comment_ids. */
export async function persistComments(runId: string, records: CommentRecord[]): Promise<string[]> {
  const ids: string[] = [];
  for (const rec of records) {
    await appendComment(runId, rec);
    ids.push(rec.comment_id);
  }
  return ids;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/core/tools/__tests__/code_comment.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Rewrite the CLI wrapper**

Replace the entire contents of `src/cli/code_comment.ts`:

```ts
#!/usr/bin/env node
import { parseToolArgs } from '../core/tools/args.js';
import { parseComments, persistComments } from '../core/tools/code_comment.js';

async function main(): Promise<void> {
  const { runId, args } = parseToolArgs(process.argv.slice(2));
  const { records, error } = parseComments(args);
  if (error) {
    // Mirrors Go: return the error message as a normal result, exit 0.
    process.stdout.write(error + '\n');
    return;
  }
  const ids = await persistComments(runId, records);
  process.stdout.write(JSON.stringify({ ok: true, count: ids.length, comment_ids: ids }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[code_comment] ${err?.message ?? err}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: Run typecheck + the new test**

Run: `npm run typecheck && npm test -- src/core/tools/__tests__/code_comment.test.ts`
Expected: typecheck clean; test PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/tools/code_comment.ts src/core/tools/__tests__/code_comment.test.ts src/cli/code_comment.ts
git commit -m "feat(tools): code_comment comments-array JSON protocol (Go-aligned)"
```

---

### Task 4: `task_done` core provider + CLI wrapper + tests

**Files:**
- Create: `src/core/tools/task_done.ts`
- Modify: `src/cli/task_done.ts`
- Test: `src/core/tools/__tests__/task_done.test.ts`

**Interfaces:**
- Consumes: `parseToolArgs` (Task 1); `markDone` from `src/core/runs/store.js`.
- Produces: `parseTaskDone(args): { subagent: string; file: string }` — throws on missing/non-string `subagent` or `file` (these are hard usage errors). The CLI wrapper calls it, delegates to `store.markDone`, prints `{"ok":true,"subagent","file"}`.

- [ ] **Step 1: Write the failing test**

Create `src/core/tools/__tests__/task_done.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTaskDone } from '../task_done.js';
import { markDone } from '../../core/runs/store.js';

test('parseTaskDone returns subagent and file', () => {
  const out = parseTaskDone({ subagent: 'reviewer-a', file: 'src/a.ts' });
  assert.deepEqual(out, { subagent: 'reviewer-a', file: 'src/a.ts' });
});

test('parseTaskDone throws when subagent missing', () => {
  assert.throws(() => parseTaskDone({ file: 'src/a.ts' }), /subagent/);
});

test('parseTaskDone throws when file missing', () => {
  assert.throws(() => parseTaskDone({ subagent: 'reviewer-a' }), /file/);
});

test('markDone writes done marker file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-task-done-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    const { subagent, file } = parseTaskDone({ subagent: 'reviewer-a', file: 'src/a.ts' });
    await markDone('run1', subagent, file);
    const body = JSON.parse(await readFile(join(dir, '.ocr-runs/run1/done/reviewer-a.json'), 'utf8'));
    assert.equal(body.subagent, 'reviewer-a');
    assert.equal(body.file, 'src/a.ts');
    assert.ok(body.ts);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/core/tools/__tests__/task_done.test.ts`
Expected: FAIL — `Cannot find module '../task_done.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/core/tools/task_done.ts`:

```ts
/** Mirrors open-code-review TaskDone: validate structured completion args. */
export function parseTaskDone(args: Record<string, unknown>): { subagent: string; file: string } {
  const subagent = typeof args['subagent'] === 'string' ? (args['subagent'] as string).trim() : '';
  if (!subagent) throw new Error("[task_done] missing --args.subagent");
  const file = typeof args['file'] === 'string' ? (args['file'] as string).trim() : '';
  if (!file) throw new Error("[task_done] missing --args.file");
  return { subagent, file };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/core/tools/__tests__/task_done.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Rewrite the CLI wrapper**

Replace the entire contents of `src/cli/task_done.ts`:

```ts
#!/usr/bin/env node
import { parseToolArgs } from '../core/tools/args.js';
import { parseTaskDone } from '../core/tools/task_done.js';
import { markDone } from '../core/runs/store.js';

async function main(): Promise<void> {
  const { runId, args } = parseToolArgs(process.argv.slice(2));
  const { subagent, file } = parseTaskDone(args);
  await markDone(runId, subagent, file);
  process.stdout.write(JSON.stringify({ ok: true, subagent, file }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[task_done] ${err?.message ?? err}\n`);
  process.exit(2);
});
```

- [ ] **Step 6: Run typecheck + the new test**

Run: `npm run typecheck && npm test -- src/core/tools/__tests__/task_done.test.ts`
Expected: typecheck clean; test PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/tools/task_done.ts src/core/tools/__tests__/task_done.test.ts src/cli/task_done.ts
git commit -m "feat(tools): task_done JSON args protocol"
```

---

### Task 5: Update `hook_handler` to parse `--args` JSON

**Files:**
- Modify: `src/host/claude-code/hook_handler.ts`
- Test: `src/host/claude-code/__tests__/hook_handler.test.ts`

**Why:** The PostToolUse hook currently extracts `--path`, `--subagent`, `--start`, `--file` from the Bash command to print a progress line and write `events.jsonl`. Under the new protocol those fields live inside `--args` JSON. Update extraction so progress/events keep working without reintroducing per-field flags.

**Interfaces:**
- `extractToolCall(cmd: string): ToolCallExtraction | null` — unchanged signature; `args` now contains `runId`, the parsed `--args` object fields flattened into `args` (e.g. `args.path`, `args.subagent`, `args.path_array`, `args.file`, `args.start`/`args.end` best-effort from comments[0] if present), so `formatProgressLine` keeps working with minimal changes.

- [ ] **Step 1: Write the failing test (update the file)**

Replace `src/host/claude-code/__tests__/hook_handler.test.ts` with:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHookInput, extractToolCall, formatProgressLine } from '../hook_handler.js';

test('parseHookInput 正确解析 JSON', () => {
  const j = parseHookInput('{"tool_name":"Bash","tool_input":{"command":"code_comment --runId x --args {\"path\":\"y\"}"}}');
  assert.equal(j?.tool_name, 'Bash');
  assert.equal(j?.tool_input?.command?.startsWith('code_comment'), true);
});

test('parseHookInput 容错非 JSON', () => {
  assert.equal(parseHookInput('not json'), null);
});

test('extractToolCall 识别 code_comment 并解析 args', () => {
  const t = extractToolCall('code_comment --runId R --args \'{"path":"src/a.ts","subagent":"reviewer-a","comments":[{"start_line":42,"end_line":50,"content":"x"}]}\'');
  assert.equal(t?.tool, 'code_comment');
  assert.equal(t?.args.runId, 'R');
  assert.equal(t?.args.path, 'src/a.ts');
  assert.equal(t?.args.subagent, 'reviewer-a');
  assert.equal(t?.args.start, '42');
  assert.equal(t?.args.end, '50');
});

test('extractToolCall 识别 task_done', () => {
  const t = extractToolCall('task_done --runId R --args \'{"subagent":"reviewer-a","file":"src/a.ts"}\'');
  assert.equal(t?.tool, 'task_done');
  assert.equal(t?.args.subagent, 'reviewer-a');
  assert.equal(t?.args.file, 'src/a.ts');
});

test('extractToolCall 识别 file_read_diff', () => {
  const t = extractToolCall('file_read_diff --runId R --args \'{"path_array":["src/a.ts"]}\'');
  assert.equal(t?.tool, 'file_read_diff');
  assert.equal(t?.args.runId, 'R');
});

test('extractToolCall 非目标命令返回 null', () => {
  assert.equal(extractToolCall('ls -la'), null);
  assert.equal(extractToolCall('git status'), null);
});

test('formatProgressLine code_comment', () => {
  const line = formatProgressLine({
    tool: 'code_comment',
    args: { runId: 'R', subagent: 'reviewer-a', path: 'src/foo.ts', start: '42' } as any,
  });
  assert.match(line, /💬|reviewer-a|src\/foo\.ts/);
});

test('formatProgressLine task_done', () => {
  const line = formatProgressLine({ tool: 'task_done', args: { subagent: 'reviewer-a', file: 'src/a.ts' } as any });
  assert.match(line, /✅|reviewer-a/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/host/claude-code/__tests__/hook_handler.test.ts`
Expected: FAIL — old `extractToolCall` does not parse `--args` JSON, so `args.path`/`args.subagent` are undefined.

- [ ] **Step 3: Update the implementation**

In `src/host/claude-code/hook_handler.ts`, replace the `extractToolCall` function body (keep `splitArgs`, `TARGET_TOOLS`, `parseHookInput`, `formatProgressLine`, `readStdin`, `main` otherwise) so that after collecting `--runId` and `--args <json>` it parses the JSON and flattens relevant fields. Replace the existing `extractToolCall` with:

```ts
export function extractToolCall(cmd: string): ToolCallExtraction | null {
  const parts = splitArgs(cmd);
  if (parts.length === 0) return null;
  const head = parts[0];
  if (!TARGET_TOOLS.includes(head as typeof TARGET_TOOLS[number])) return null;
  const args: Record<string, string> = {};
  let parsedArgs: Record<string, unknown> | null = null;
  for (let i = 1; i < parts.length; i++) {
    const a = parts[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = parts[i + 1] ?? '';
      i++;
      if (key === 'args') {
        try {
          const p = JSON.parse(val);
          if (typeof p === 'object' && p !== null && !Array.isArray(p)) parsedArgs = p as Record<string, unknown>;
        } catch { /* ignore malformed args in hook best-effort path */ }
      } else {
        args[key] = val;
      }
    }
  }
  if (parsedArgs) {
    for (const [k, v] of Object.entries(parsedArgs)) {
      if (typeof v === 'string') args[k] = v;
      else if (typeof v === 'number') args[k] = String(v);
    }
    // best-effort first-comment line range for progress display
    const comments = parsedArgs['comments'];
    if (Array.isArray(comments) && comments.length > 0 && typeof comments[0] === 'object' && comments[0] !== null) {
      const first = comments[0] as Record<string, unknown>;
      if (typeof first['start_line'] === 'number') args['start'] = String(first['start_line']);
      if (typeof first['end_line'] === 'number') args['end'] = String(first['end_line']);
    }
  }
  return { tool: head as ToolCallExtraction['tool'], args };
}
```

Note: `splitArgs` already preserves quoted JSON as a single token (it keeps spaces inside quotes), so the JSON survives as one `parts` entry. No other function changes.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/host/claude-code/__tests__/hook_handler.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/host/claude-code/hook_handler.ts src/host/claude-code/__tests__/hook_handler.test.ts
git commit -m "fix(hook): parse --args JSON for tool progress/events"
```

---

### Task 6: Update executable prompts (agent, skill, main_task constant)

**Files:**
- Modify: `agents/ocr-reviewer.md`
- Modify: `skills/ocr-review-file/SKILL.md`
- Modify: `src/core/prompts/main_task.ts`

**Why:** These contain the old per-field tool-call examples. They are executable instructions for the reviewer subagent (and `main_task.ts` is mirror-checked against the skill by `skill_consistency.test.ts`). All three must switch to `--args` JSON in lockstep so the consistency test still passes.

**Interfaces:** None (string content only).

- [ ] **Step 1: Update `agents/ocr-reviewer.md`**

In `agents/ocr-reviewer.md`, replace these two lines:

```md
3. For each confirmed issue, run Bash: `code_comment --runId <runId> --path <currentFilePath> --start <n> --end <m> --content <text> --subagent <subagent>`.
4. After all comments are submitted (or if there are no issues), run Bash: `task_done --runId <runId> --subagent <subagent> --file <currentFilePath>`.
```

with:

```md
3. For each confirmed issue (or to submit several at once), run Bash:
   `code_comment --runId <runId> --args '{"path":"<currentFilePath>","subagent":"<subagent>","comments":[{"start_line":<n>,"end_line":<m>,"content":"<text>","suggestion_code":"<code>","existing_code":"<code>","thinking":"<text>"}]}'`
   (omit `suggestion_code` / `existing_code` / `thinking` when not applicable; multiple comments go in the `comments` array.)
4. After all comments are submitted (or if there are no issues), run Bash:
   `task_done --runId <runId> --args '{"subagent":"<subagent>","file":"<currentFilePath>"}'`
```

- [ ] **Step 2: Update `skills/ocr-review-file/SKILL.md`**

In `skills/ocr-review-file/SKILL.md`, replace the three bullet lines under `## Tool Mapping (host: Claude Code)`:

```md
- To read another changed file's diff: run **Bash** with `file_read_diff --runId <runId> --path <path>`.
- To submit a confirmed review comment: run **Bash** with:
  `code_comment --runId <runId> --path <p> --start <n> --end <m> --content <text> [--suggestion-code <code>] [--existing-code <code>] [--thinking <text>] --subagent <subagent_id>`
- When your review is complete, run **Bash** with: `task_done --runId <runId> --subagent <subagent_id> --file <currentFilePath>`.
```

with:

```md
- To read another changed file's diff: run **Bash** with
  `file_read_diff --runId <runId> --args '{"path_array":["<path1>","<path2>"]}'`.
- To submit confirmed review comment(s): run **Bash** with
  `code_comment --runId <runId> --args '{"path":"<p>","subagent":"<subagent_id>","comments":[{"start_line":<n>,"end_line":<m>,"content":"<text>","suggestion_code":"<code>","existing_code":"<code>","thinking":"<text>"}]}'`
  (omit `suggestion_code` / `existing_code` / `thinking` when not applicable; multiple comments go in the `comments` array.)
- When your review is complete, run **Bash** with
  `task_done --runId <runId> --args '{"subagent":"<subagent_id>","file":"<currentFilePath>"}'`.
```

- [ ] **Step 3: Update `src/core/prompts/main_task.ts`**

In `src/core/prompts/main_task.ts`, replace the `## Tool Mapping (host: Claude Code)` block (the four bullets from `- To read a file:` through `file_read_diff.`) with:

```ts
## Tool Mapping (host: Claude Code)
- To read a file: use the **Read** tool.
- To find files by pattern: use the **Glob** tool.
- To search code text: use the **Grep** tool.
- To read another changed file's diff: run \`Bash\` with \`file_read_diff --runId <runId> --args '{"path_array":["<path>"]}'\`.
- To submit a confirmed review comment: run \`Bash\` with \`code_comment --runId <runId> --args '{"path":"<p>","subagent":"<id>","comments":[{"start_line":<n>,"end_line":<m>,"content":"<text>"}]}'\`.
- When your review is complete, run \`Bash\` with \`task_done --runId <runId> --args '{"subagent":"<id>","file":"<path>"}'\` to signal completion.
```

- [ ] **Step 4: Run the consistency test**

Run: `npm test -- src/core/prompts/__tests__/skill_consistency.test.ts`
Expected: PASS. The checked snippets (`To submit a confirmed review comment`, `task_done`, `Focus on issues in newly added code.`, etc.) are still present in both the TS constant and the skill.

- [ ] **Step 5: Run full typecheck**

Run: `npm run typecheck`
Expected: clean (no type errors from the string change).

- [ ] **Step 6: Commit**

```bash
git add agents/ocr-reviewer.md skills/ocr-review-file/SKILL.md src/core/prompts/main_task.ts
git commit -m "docs(prompts): switch reviewer tool calls to --args JSON protocol"
```

---

### Task 7: Update CLI tests (roundtrip + code_comment_id) to `--args`

**Files:**
- Modify: `src/cli/__tests__/roundtrip.test.ts`
- Modify: `src/cli/__tests__/code_comment_id.test.ts`

**Why:** These still invoke the old per-field CLI flags; they must exercise the new JSON protocol and remain green. They also pin the aggregate integration (comments.jsonl + done/ consumed by `ocr-aggregate`).

**Interfaces:** None (test-only).

- [ ] **Step 1: Update `roundtrip.test.ts`**

In `src/cli/__tests__/roundtrip.test.ts`, replace the three CLI invocations inside the test (the `runCli(dir, 'code_comment.ts', [...])`, `runCli(dir, 'task_done.ts', [...])`, and `runCli(dir, 'file_read_diff.ts', [...])` calls) with the `--args` form. Replace this block:

```ts
    await runCli(dir, 'code_comment.ts', [
      '--runId', 'run1',
      '--path', 'src/a.ts',
      '--start', '1',
      '--end', '1',
      '--content', 'Use a clearer value',
      '--subagent', 'reviewer-0',
    ]);
    await runCli(dir, 'task_done.ts', ['--runId', 'run1', '--subagent', 'reviewer-0', '--file', 'src/a.ts']);

    const diff = await runCli(dir, 'file_read_diff.ts', ['--runId', 'run1', '--path', 'src/b.ts']);
    assert.match(diff.stdout, /src\/b\.ts/);
```

with:

```ts
    await runCli(dir, 'code_comment.ts', [
      '--runId', 'run1',
      '--args', JSON.stringify({
        path: 'src/a.ts',
        subagent: 'reviewer-0',
        comments: [{ start_line: 1, end_line: 1, content: 'Use a clearer value' }],
      }),
    ]);
    await runCli(dir, 'task_done.ts', [
      '--runId', 'run1',
      '--args', JSON.stringify({ subagent: 'reviewer-0', file: 'src/a.ts' }),
    ]);

    const diff = await runCli(dir, 'file_read_diff.ts', [
      '--runId', 'run1',
      '--args', JSON.stringify({ path_array: ['src/b.ts'] }),
    ]);
    assert.match(diff.stdout, /==== FILE: src\/b\.ts ====/);
```

- [ ] **Step 2: Run roundtrip test to verify it passes**

Run: `npm test -- src/cli/__tests__/roundtrip.test.ts`
Expected: PASS (1 test). The `aggregate` assertions (`partial === true`, `partialFiles === ['src/b.ts']`, `commentCount === 1`) still hold because the new `code_comment` writes one record and `task_done` marks `reviewer-0` done (leaving `src/b.ts` partial).

- [ ] **Step 3: Update `code_comment_id.test.ts`**

In `src/cli/__tests__/code_comment_id.test.ts`, replace the two `runCodeComment` argument arrays. Replace:

```ts
    const first = await runCodeComment(dir, [
      '--runId', 'run1',
      '--path', 'src/a.ts',
      '--start', '1',
      '--end', '1',
      '--content', 'first',
      '--subagent', 'reviewer-a',
    ]);
    const second = await runCodeComment(dir, [
      '--runId', 'run1',
      '--path', 'src/a.ts',
      '--start', '2',
      '--end', '2',
      '--content', 'second',
      '--subagent', 'reviewer-a',
    ]);
```

with:

```ts
    const first = await runCodeComment(dir, [
      '--runId', 'run1',
      '--args', JSON.stringify({
        path: 'src/a.ts', subagent: 'reviewer-a',
        comments: [{ start_line: 1, end_line: 1, content: 'first' }],
      }),
    ]);
    const second = await runCodeComment(dir, [
      '--runId', 'run1',
      '--args', JSON.stringify({
        path: 'src/a.ts', subagent: 'reviewer-a',
        comments: [{ start_line: 2, end_line: 2, content: 'second' }],
      }),
    ]);
```

Also update the stdout assertion shape. The new `code_comment` stdout is `{"ok":true,"count":1,"comment_ids":["c-..."]}`. Replace:

```ts
    const firstOut = JSON.parse(first.stdout) as { comment_id: string };
    const secondOut = JSON.parse(second.stdout) as { comment_id: string };

    assert.match(firstOut.comment_id, /^c-[0-9a-f-]{36}$/);
    assert.match(secondOut.comment_id, /^c-[0-9a-f-]{36}$/);
    assert.notEqual(firstOut.comment_id, secondOut.comment_id);
```

with:

```ts
    const firstOut = JSON.parse(first.stdout) as { comment_ids: string[] };
    const secondOut = JSON.parse(second.stdout) as { comment_ids: string[] };

    assert.equal(firstOut.comment_ids.length, 1);
    assert.match(firstOut.comment_ids[0], /^c-[0-9a-f-]{36}$/);
    assert.match(secondOut.comment_ids[0], /^c-[0-9a-f-]{36}$/);
    assert.notEqual(firstOut.comment_ids[0], secondOut.comment_ids[0]);
```

And update the jsonl read to use the new id. Replace:

```ts
    const lines = body.trim().split('\n').map((line) => JSON.parse(line) as { comment_id: string; content: string });
    assert.equal(lines.length, 2);
    assert.equal(lines[0].comment_id, firstOut.comment_id);
    assert.equal(lines[1].comment_id, secondOut.comment_id);
```

with:

```ts
    const lines = body.trim().split('\n').map((line) => JSON.parse(line) as { comment_id: string; content: string });
    assert.equal(lines.length, 2);
    assert.equal(lines[0].comment_id, firstOut.comment_ids[0]);
    assert.equal(lines[1].comment_id, secondOut.comment_ids[0]);
```

- [ ] **Step 4: Run code_comment_id test to verify it passes**

Run: `npm test -- src/cli/__tests__/code_comment_id.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/cli/__tests__/roundtrip.test.ts src/cli/__tests__/code_comment_id.test.ts
git commit -m "test(cli): roundtrip + comment_id use --args JSON protocol"
```

---

### Task 8: Update smoke script + README

**Files:**
- Modify: `scripts/smoke.sh`
- Modify: `README.md`

**Why:** `scripts/smoke.sh` drives end-to-end with the real built bins and still calls old per-field flags. README examples are user-facing. Both must reflect the new protocol.

**Interfaces:** None.

- [ ] **Step 1: Update `scripts/smoke.sh`**

In `scripts/smoke.sh`, replace the `code_comment`/`task_done` invocations. First, the relocation comment (lines around `COMMENT_RELOCATE`). Replace:

```bash
COMMENT_RELOCATE="$($PLUGIN_ROOT/bin/code_comment --runId "$RUNID" --path a.ts --start 99 --end 99 --content "Use const" --existing-code "export function hello() {" --subagent reviewer-b)"
RELOCATE_ID="$(echo "$COMMENT_RELOCATE" | grep -o '"comment_id":"[^"]*"' | head -1 | cut -d'"' -f4)"
```

with:

```bash
COMMENT_RELOCATE="$($PLUGIN_ROOT/bin/code_comment --runId "$RUNID" --args '{"path":"a.ts","subagent":"reviewer-b","comments":[{"start_line":99,"end_line":99,"content":"Use const","existing_code":"export function hello() {"}]}')"
RELOCATE_ID="$(echo "$COMMENT_RELOCATE" | grep -o '"comment_ids":\["[^"]*"\]' | head -1 | grep -o 'c-[0-9a-f-]*' | head -1)"
```

Then the reviewer simulation. Replace:

```bash
COMMENT_KEEP="$($PLUGIN_ROOT/bin/code_comment --runId "$RUNID" --path a.ts --start 2 --end 2 --content "Magic string" --subagent reviewer-a)"
COMMENT_HIDE="$($PLUGIN_ROOT/bin/code_comment --runId "$RUNID" --path a.ts --start 2 --end 2 --content "Duplicate noise" --subagent reviewer-a)"
HIDE_ID="$(echo "$COMMENT_HIDE" | grep -o '"comment_id":"[^"]*"' | head -1 | cut -d'"' -f4)"
```

with:

```bash
COMMENT_KEEP="$($PLUGIN_ROOT/bin/code_comment --runId "$RUNID" --args '{"path":"a.ts","subagent":"reviewer-a","comments":[{"start_line":2,"end_line":2,"content":"Magic string"}]}')"
COMMENT_HIDE="$($PLUGIN_ROOT/bin/code_comment --runId "$RUNID" --args '{"path":"a.ts","subagent":"reviewer-a","comments":[{"start_line":2,"end_line":2,"content":"Duplicate noise"}]}')"
HIDE_ID="$(echo "$COMMENT_HIDE" | grep -o '"comment_ids":\["[^"]*"\]' | head -1 | grep -o 'c-[0-9a-f-]*' | head -1)"
```

And the two `task_done` lines. Replace:

```bash
"$PLUGIN_ROOT/bin/task_done" --runId "$RUNID" --subagent reviewer-a --file a.ts >/dev/null
"$PLUGIN_ROOT/bin/task_done" --runId "$RUNID" --subagent reviewer-b --file a.ts >/dev/null
```

with:

```bash
"$PLUGIN_ROOT/bin/task_done" --runId "$RUNID" --args '{"subagent":"reviewer-a","file":"a.ts"}' >/dev/null
"$PLUGIN_ROOT/bin/task_done" --runId "$RUNID" --args '{"subagent":"reviewer-b","file":"a.ts"}' >/dev/null
```

- [ ] **Step 2: Update README architecture bullet**

In `README.md`, §4 Architecture, the bullet currently reads:

```md
4. For each file, a `ocr-reviewer` subagent (defined in `agents/`) runs in parallel.
   Each subagent uses Read/Glob/Grep + Bash `code_comment` to emit comments.
```

This does not show per-field flags, so it stays valid. Leave §4 unchanged. README has no per-field `code_comment`/`task_done`/`file_read_diff` examples to update. Skip a README content change.

- [ ] **Step 3: Build + run smoke**

Run: `npm run build && npm run smoke`
Expected: `[smoke] PASS`. The build regenerates `bin/code_comment`, `bin/task_done`, `bin/file_read_diff` with the new wrapper; smoke validates relocate (99→1), filter hide, and aggregate success.

- [ ] **Step 4: Commit**

```bash
git add scripts/smoke.sh
git commit -m "chore(smoke): use --args JSON protocol for code_comment/task_done"
```

---

### Task 9: Full verification + final guard test

**Files:**
- Test: `src/core/tools/__tests__/legacy_flags_rejected.test.ts` (NEW)

**Why:** Confirm old per-field flags are truly gone: the new CLIs exit non-zero when given `--path`/`--start` (because `--args` is missing), and no executable reference to the old syntax remains. This is the acceptance-criteria guard.

**Interfaces:** None (test-only).

- [ ] **Step 1: Write the guard test**

Create `src/core/tools/__tests__/legacy_flags_rejected.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX_LOADER = join(ROOT, 'node_modules/tsx/dist/loader.mjs');

async function runCli(cwd: string, file: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX_LOADER, join(ROOT, 'src/cli', file), ...args], { cwd });
}

test('code_comment rejects legacy per-field flags (missing --args)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-legacy-'));
  try {
    await assert.rejects(
      runCli(dir, 'code_comment.ts', ['--runId', 'r', '--path', 'a.ts', '--start', '1', '--end', '1', '--content', 'x']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /missing --args/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('file_read_diff rejects legacy --path (missing --args)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-legacy-'));
  try {
    await assert.rejects(
      runCli(dir, 'file_read_diff.ts', ['--runId', 'r', '--path', 'a.ts']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /missing --args/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the guard test**

Run: `npm test -- src/core/tools/__tests__/legacy_flags_rejected.test.ts`
Expected: PASS (2 tests). Both exit code 2 with `missing --args`.

- [ ] **Step 3: Grep for any remaining executable old-syntax references**

Run:

```bash
grep -rnE 'code_comment .*--(path|start|end|content|subagent|existing-code|suggestion-code)|file_read_diff .*--path( |$)|task_done .*--(subagent|file)' agents skills commands scripts README.md src/core/prompts/main_task.ts 2>/dev/null || true
```

Expected: no matches for legacy invocations of the three migrated tools. Other tools such as `ocr-filter-apply --subagent` are unrelated and acceptable.

- [ ] **Step 4: Run the full suite + typecheck + build**

Run:

```bash
npm test && npm run typecheck && npm run build
```

Expected: all tests pass; typecheck clean; build produces `dist/cli/code_comment.mjs`, `dist/cli/task_done.mjs`, `dist/cli/file_read_diff.mjs` and `bin/code_comment`, `bin/task_done`, `bin/file_read_diff`.

- [ ] **Step 5: Commit**

```bash
git add src/core/tools/__tests__/legacy_flags_rejected.test.ts
git commit -m "test(tools): guard legacy per-field CLI flags are rejected"
```

- [ ] **Step 6: Final report**

Run `git log --oneline -9` and `npm run smoke`. Report the green status to the user, including that old per-field CLI flags are removed and the three tools now use `--runId + --args` JSON aligned with `open-code-review`.

---

## Self-Review

**1. Spec coverage:**
- `file_read_diff` `path_array` + `==== FILE:` formatting + Go error strings → Task 2. ✓
- `code_comment` `comments` array + `ParseComments`-style skip + `comment_id` + `_meta` + error strings → Task 3. ✓
- `task_done` JSON args + done marker → Task 4. ✓
- Shared `--runId`/`--args` wrapper + JSON validation → Task 1. ✓
- Prompt/doc updates (agent, skill, README, main_task) → Task 6 (+ Task 8 README check). ✓
- Hook progress/events continue under new protocol → Task 5. ✓
- Tests cover new protocol; old syntax not relied on → Tasks 7 + 9. ✓
- `npm test`, `npm run typecheck`, `npm run build`, `npm run smoke` → Tasks 2/3/4/8/9. ✓
- Acceptance: legacy flags removed → Task 9 guard. ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code. README has no per-field examples to change (verified in Task 8 Step 2), so the "skip README content change" is explicit, not a gap.

**3. Type consistency:** `parseToolArgs` returns `{ runId: string; args: Record<string, unknown> }` in Task 1 and is consumed identically in Tasks 2/3/4. `readFileDiff(args, ctx): string`, `parseComments(args): { records; error? }`, `persistComments(runId, records): Promise<string[]>`, `parseTaskDone(args): { subagent; file }` — names match across tasks and tests. `comment_id` shape is `c-<uuid>` throughout. CLI exit codes: 2 for usage errors (missing `--runId`/`--args`, `task_done` validation), 0 for provider error strings (`code_comment`), 1 for unexpected throws (`code_comment` catch-all) — consistent within each task.

**Risk noted:** `Math.random()` is NOT used (UUID via `node:crypto.randomUUID`), so no workflow-script restriction applies; this is a normal TS codebase under `tsc`.
