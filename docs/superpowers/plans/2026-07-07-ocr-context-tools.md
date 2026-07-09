# OCR Context Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the three original OCR context tools — `file_read`, `file_find`, and `code_search` — with commit/range ref awareness so reviewers can inspect the exact code version under review.

**Architecture:** Add a small shared context-tool layer that derives a git ref from `ReviewContext.range`, safely reads files from either the workspace or `git show <ref>:<path>`, and runs bounded git commands. Then expose one core provider plus one CLI wrapper for each OCR tool, and update reviewer prompts to prefer these CLIs over host `Read`/`Glob`/`Grep` when review context must match the prepared run.

**Tech Stack:** TypeScript ESM, Node.js built-in `fs/promises`, `child_process`, `node:test`, existing `--runId` / `--args` CLI protocol, git CLI.

## Global Constraints

- Node.js runtime remains `>=18` from `package.json`.
- Keep CLI protocol consistent with existing tools: `<tool> --runId <runId> --args '<json object>'`.
- Match original OCR behavior where practical: `file_read` max 500 lines, `file_find` max 100 files, `code_search` max 100 matches, 10-second git search/list timeout.
- `file_read`, `file_find`, and `code_search` must use the prepared `ReviewContext` to resolve historical code for `commit:<sha>` and `<from>..<to>` review modes.
- Do not edit user code during review; these tools are read-only context tools.
- Preserve existing `file_read_diff`, `code_comment`, and `task_done` behavior.

---

## File Structure

- Create `src/core/tools/context_ref.ts` — derive the correct read/search ref from `ReviewContext.range`.
- Create `src/core/tools/git_exec.ts` — run git commands with stdout/stderr/exit-code access and timeout support.
- Create `src/core/tools/context_file_reader.ts` — safe workspace reads and `git show` reads, including line-window logic shared by `file_read`.
- Create `src/core/tools/file_read.ts` — OCR-compatible `file_read` provider.
- Create `src/core/tools/file_find.ts` — OCR-compatible `file_find` provider.
- Create `src/core/tools/code_search.ts` — OCR-compatible `code_search` provider.
- Create `src/cli/file_read.ts` — CLI wrapper loading `ReviewContext` and calling `readFile`.
- Create `src/cli/file_find.ts` — CLI wrapper loading `ReviewContext` and calling `findFiles`.
- Create `src/cli/code_search.ts` — CLI wrapper loading `ReviewContext` and calling `searchCode`.
- Create tests under `src/core/tools/__tests__/` for all new core behavior.
- Modify `src/cli/__tests__/roundtrip.test.ts` — exercise the new CLIs with an existing run context.
- Modify `agents/ocr-reviewer.md` and `skills/ocr-review-file/SKILL.md` — document the new tool commands.
- Modify `README.md` only if it currently describes context tools or reviewer tool mappings.

---

### Task 1: Shared Ref-Aware Context Reader Utilities

**Files:**
- Create: `src/core/tools/context_ref.ts`
- Create: `src/core/tools/git_exec.ts`
- Create: `src/core/tools/context_file_reader.ts`
- Test: `src/core/tools/__tests__/context_file_reader.test.ts`

**Interfaces:**
- Consumes: `ReviewContext` from `src/core/model/request.ts`
- Produces:
  - `resolveContextRef(ctx: ReviewContext): string | undefined`
  - `runGitSplit(args: string[], opts: GitSplitOpts): Promise<GitSplitResult>`
  - `readContextFile(ctx: ReviewContext, filePath: string): Promise<string>`
  - `readContextFileLines(ctx: ReviewContext, filePath: string, startLine: number, maxLines: number): Promise<{ lines: string[]; totalLines: number }>`

- [ ] **Step 1: Write failing tests for ref resolution and file reading**

Create `src/core/tools/__tests__/context_file_reader.test.ts` with this full content:

```ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveContextRef } from '../context_ref.js';
import { readContextFile, readContextFileLines } from '../context_file_reader.js';
import type { ReviewContext } from '../../model/request.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function ctx(repoRoot: string, range: string): ReviewContext {
  return {
    runId: 'run1',
    repoRoot,
    range,
    background: '',
    files: [],
    changeFiles: [],
    meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
  };
}

async function setupRepo(): Promise<{ repo: string; first: string; second: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-context-reader-'));
  await git(repo, ['init', '-q']);
  await git(repo, ['checkout', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.ts'), 'export const value = 1;\nline2\n');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'nested.ts'), 'nested-v1\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'first']);
  const first = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(join(repo, 'a.ts'), 'export const value = 2;\nline2\nline3\n');
  await writeFile(join(repo, 'src', 'nested.ts'), 'nested-v2\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'second']);
  const second = await git(repo, ['rev-parse', 'HEAD']);
  return { repo, first, second };
}

test('resolveContextRef returns undefined for workspace and staged ranges', () => {
  assert.equal(resolveContextRef(ctx('/repo', 'workspace')), undefined);
  assert.equal(resolveContextRef(ctx('/repo', 'staged')), undefined);
});

test('resolveContextRef returns commit hash for commit range', () => {
  assert.equal(resolveContextRef(ctx('/repo', 'commit:abc123')), 'abc123');
});

test('resolveContextRef returns right side for two-dot range', () => {
  assert.equal(resolveContextRef(ctx('/repo', 'main..feature')), 'feature');
});

test('readContextFile reads workspace content when range has no ref', async () => {
  const { repo } = await setupRepo();
  try {
    await writeFile(join(repo, 'a.ts'), 'workspace-version\n');
    const out = await readContextFile(ctx(repo, 'workspace'), 'a.ts');
    assert.equal(out, 'workspace-version\n');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('readContextFile reads historical commit content when range is commit', async () => {
  const { repo, first } = await setupRepo();
  try {
    const out = await readContextFile(ctx(repo, `commit:${first}`), 'a.ts');
    assert.equal(out, 'export const value = 1;\nline2\n');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('readContextFile reads range right-side content for from..to reviews', async () => {
  const { repo, first, second } = await setupRepo();
  try {
    const out = await readContextFile(ctx(repo, `${first}..${second}`), 'src/nested.ts');
    assert.equal(out, 'nested-v2\n');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('readContextFileLines preserves trailing empty line and line windows', async () => {
  const { repo, first } = await setupRepo();
  try {
    const result = await readContextFileLines(ctx(repo, `commit:${first}`), 'a.ts', 1, 10);
    assert.deepEqual(result.lines, ['export const value = 1;', 'line2', '']);
    assert.equal(result.totalLines, 3);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('readContextFile rejects paths outside the repository in workspace mode', async () => {
  const { repo } = await setupRepo();
  try {
    await assert.rejects(readContextFile(ctx(repo, 'workspace'), '../secret.txt'), /outside repository/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the failing shared utility tests**

Run:

```bash
npm test -- src/core/tools/__tests__/context_file_reader.test.ts
```

Expected: FAIL with module-not-found errors for `context_ref.js` and `context_file_reader.js`.

- [ ] **Step 3: Implement ref resolution**

Create `src/core/tools/context_ref.ts`:

```ts
import type { ReviewContext } from '../model/request.js';

export function resolveContextRef(ctx: ReviewContext): string | undefined {
  if (ctx.range === 'workspace' || ctx.range === 'staged') return undefined;
  if (ctx.range.startsWith('commit:')) {
    const ref = ctx.range.slice('commit:'.length).trim();
    return ref || undefined;
  }
  const idx = ctx.range.indexOf('..');
  if (idx !== -1) {
    const to = ctx.range.slice(idx + 2).trim();
    return to || undefined;
  }
  const trimmed = ctx.range.trim();
  return trimmed || undefined;
}
```

- [ ] **Step 4: Implement bounded git execution helper**

Create `src/core/tools/git_exec.ts`:

```ts
import { spawn } from 'node:child_process';

export interface GitSplitOpts {
  cwd: string;
  timeoutMs?: number;
  allowExitCodes?: number[];
}

export interface GitSplitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runGitSplit(args: string[], opts: GitSplitOpts): Promise<GitSplitResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const actualCode = code ?? -1;
      const allow = opts.allowExitCodes ?? [0];
      if (!allow.includes(actualCode)) {
        reject(new Error(`git ${args.join(' ')} exit ${actualCode}: ${stderr.trim()}`));
        return;
      }
      resolve({ stdout, stderr, code: actualCode });
    });
  });
}
```

- [ ] **Step 5: Implement safe context file reader**

Create `src/core/tools/context_file_reader.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { resolveContextRef } from './context_ref.js';
import { runGitSplit } from './git_exec.js';
import type { ReviewContext } from '../model/request.js';

function assertInsideRepo(repoRoot: string, path: string): string {
  const root = resolve(repoRoot);
  const candidate = isAbsolute(path) ? resolve(root, `.${path}`) : resolve(join(root, path));
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || rel === '..' || isAbsolute(rel)) {
    throw new Error(`file path ${JSON.stringify(path)} is outside repository`);
  }
  return candidate;
}

export async function readContextFile(ctx: ReviewContext, filePath: string): Promise<string> {
  const ref = resolveContextRef(ctx);
  if (!ref) {
    const fullPath = assertInsideRepo(ctx.repoRoot, filePath);
    return readFile(fullPath, 'utf8');
  }

  const result = await runGitSplit(
    ['-c', 'core.quotepath=false', 'show', '--end-of-options', `${ref}:${filePath}`],
    { cwd: ctx.repoRoot, timeoutMs: 30_000 },
  );
  return result.stdout;
}

export async function readContextFileLines(
  ctx: ReviewContext,
  filePath: string,
  startLine: number,
  maxLines: number,
): Promise<{ lines: string[]; totalLines: number }> {
  const content = await readContextFile(ctx, filePath);
  const allLines = content.length === 0 ? [] : content.split('\n');
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.max(startIndex, startIndex + maxLines);
  return {
    lines: allLines.slice(startIndex, endIndex),
    totalLines: allLines.length,
  };
}
```

- [ ] **Step 6: Run shared utility tests and full typecheck**

Run:

```bash
npm test -- src/core/tools/__tests__/context_file_reader.test.ts
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 7: Commit shared utilities**

```bash
git add src/core/tools/context_ref.ts src/core/tools/git_exec.ts src/core/tools/context_file_reader.ts src/core/tools/__tests__/context_file_reader.test.ts
git commit -m "feat(tools): add ref-aware context file reader"
```

---

### Task 2: Implement OCR-Compatible `file_read`

**Files:**
- Create: `src/core/tools/file_read.ts`
- Create: `src/core/tools/__tests__/file_read.test.ts`
- Create: `src/cli/file_read.ts`
- Modify: `src/cli/__tests__/roundtrip.test.ts`

**Interfaces:**
- Consumes:
  - `readContextFileLines(ctx, filePath, startLine, maxLines)` from Task 1
  - `parseToolArgs(argv)` from `src/core/tools/args.ts`
  - `readContext(runId)` from `src/core/runs/store.ts`
- Produces:
  - `readFile(args: Record<string, unknown>, ctx: ReviewContext): Promise<string>`
  - CLI binary name generated automatically by `scripts/shebang.mjs`: `bin/file_read`

- [ ] **Step 1: Write failing core tests for `file_read`**

Create `src/core/tools/__tests__/file_read.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile as readOcrFile } from '../file_read.js';
import type { ReviewContext } from '../../model/request.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function ctx(repoRoot: string, range: string): ReviewContext {
  return {
    runId: 'run1',
    repoRoot,
    range,
    background: '',
    files: [],
    changeFiles: [],
    meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
  };
}

async function setupRepo(): Promise<{ repo: string; first: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-file-read-'));
  await git(repo, ['init', '-q']);
  await git(repo, ['checkout', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.ts'), 'one\ntwo\nthree\nfour\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'first']);
  const first = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(join(repo, 'a.ts'), 'changed\n');
  return { repo, first };
}

test('readFile requires file_path', async () => {
  const out = await readOcrFile({}, ctx('/repo', 'workspace'));
  assert.equal(out, 'Error: file_path is required');
});

test('readFile formats requested line range', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await readOcrFile({ file_path: 'a.ts', start_line: 2, end_line: 3 }, ctx(repo, 'workspace'));
    assert.match(out, /File: a\.ts \(Total lines: 2\)/);
    assert.match(out, /IS_TRUNCATED: false/);
    assert.match(out, /LINE_RANGE: 2-2/);
    assert.match(out, /2\|/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('readFile reads commit content instead of workspace content', async () => {
  const { repo, first } = await setupRepo();
  try {
    const out = await readOcrFile({ file_path: 'a.ts', start_line: 1, end_line: 2 }, ctx(repo, `commit:${first}`));
    assert.match(out, /1\|one/);
    assert.match(out, /2\|two/);
    assert.doesNotMatch(out, /changed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('readFile truncates to 500 lines', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-file-read-truncate-'));
  try {
    const body = Array.from({ length: 550 }, (_, i) => `line-${i + 1}`).join('\n') + '\n';
    await writeFile(join(repo, 'big.ts'), body);
    const out = await readOcrFile({ file_path: 'big.ts' }, ctx(repo, 'workspace'));
    assert.match(out, /IS_TRUNCATED: true/);
    assert.match(out, /LINE_RANGE: 1-500/);
    assert.match(out, /500\|line-500/);
    assert.doesNotMatch(out, /501\|line-501/);
    assert.match(out, /Note: Results truncated to 500 lines/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing `file_read` tests**

Run:

```bash
npm test -- src/core/tools/__tests__/file_read.test.ts
```

Expected: FAIL with module-not-found for `../file_read.js`.

- [ ] **Step 3: Implement `file_read` provider**

Create `src/core/tools/file_read.ts`:

```ts
import { readContextFileLines } from './context_file_reader.js';
import type { ReviewContext } from '../model/request.js';

const FILE_READ_MAX_LINES = 500;

function asPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

export async function readFile(args: Record<string, unknown>, ctx: ReviewContext): Promise<string> {
  const filePath = typeof args['file_path'] === 'string' ? args['file_path'] : '';
  if (filePath === '') return 'Error: file_path is required';

  const startLine = asPositiveInteger(args['start_line'], 1);
  const endLineRaw = asPositiveInteger(args['end_line'], 0);
  let maxLines = FILE_READ_MAX_LINES;

  if (endLineRaw > 0) {
    const requested = endLineRaw - startLine + 1;
    if (requested <= 0) {
      throw new Error(`invalid line range: start_line ${startLine} is greater than end_line ${endLineRaw}`);
    }
    if (requested < maxLines) maxLines = requested;
  }

  let result: { lines: string[]; totalLines: number };
  try {
    result = await readContextFileLines(ctx, filePath, startLine, maxLines);
  } catch (err) {
    throw new Error(`file ${JSON.stringify(filePath)} not found: ${(err as Error).message}`);
  }

  if (result.totalLines > 0 && startLine - 1 >= result.totalLines) {
    throw new Error(`file ${JSON.stringify(filePath)} has only ${result.totalLines} lines, requested range ${startLine}-${endLineRaw}`);
  }

  let effectiveEnd = result.totalLines;
  if (endLineRaw > 0 && endLineRaw < effectiveEnd) effectiveEnd = endLineRaw;
  const fullRange = effectiveEnd - (startLine - 1);
  const truncated = fullRange > FILE_READ_MAX_LINES;
  const displayEnd = startLine - 1 + result.lines.length;

  let out = '';
  out += `File: ${filePath} (Total lines: ${result.totalLines})\n`;
  out += `IS_TRUNCATED: ${truncated}\n`;
  out += `LINE_RANGE: ${startLine}-${displayEnd}\n`;
  for (let i = 0; i < result.lines.length; i++) {
    out += `${startLine + i}|${result.lines[i]}\n`;
  }
  if (truncated) {
    out += `\nNote: Results truncated to ${FILE_READ_MAX_LINES} lines. Please narrow your line range.\n`;
  }
  return out;
}
```

- [ ] **Step 4: Implement `file_read` CLI wrapper**

Create `src/cli/file_read.ts`:

```ts
#!/usr/bin/env node
import { parseToolArgs } from '../core/tools/args.js';
import { readFile } from '../core/tools/file_read.js';
import { readContext } from '../core/runs/store.js';
import type { ReviewContext } from '../core/model/request.js';

async function main(): Promise<void> {
  const { runId, args } = parseToolArgs(process.argv.slice(2));
  const ctx = await readContext<ReviewContext>(runId);
  const result = await readFile(args, ctx);
  process.stdout.write(result + (result.endsWith('\n') ? '' : '\n'));
}

main().catch((err) => {
  process.stderr.write(`[file_read] ${err?.message ?? err}\n`);
  process.exit(2);
});
```

- [ ] **Step 5: Add `file_read` to roundtrip CLI coverage**

Modify `src/cli/__tests__/roundtrip.test.ts` inside the existing `test('CLI tools write comments...')` after the `file_read_diff` assertion:

```ts
    const read = await runCli(dir, 'file_read.ts', [
      '--runId', 'run1',
      '--args', JSON.stringify({ file_path: 'src/a.ts', start_line: 1, end_line: 2 }),
    ]);
    assert.match(read.stdout, /File: src\/a\.ts/);
```

Also change `const CTX: ReviewContext = { repoRoot: '/repo', ... }` in the same file to use the temporary directory before writing context. Replace lines 20-45 with a factory:

```ts
function makeCtx(repoRoot: string): ReviewContext {
  return {
    runId: 'run1',
    repoRoot,
    range: 'workspace',
    background: '',
    files: [
      {
        path: 'src/a.ts',
        status: 'modified',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n',
        truncated: false,
        hunks: [],
        rulesHit: [],
      },
      {
        path: 'src/b.ts',
        status: 'modified',
        diff: 'diff --git a/src/b.ts b/src/b.ts\n@@ -1 +1 @@\n-export const b = 1;\n+export const b = 2;\n',
        truncated: false,
        hunks: [],
        rulesHit: [],
      },
    ],
    changeFiles: ['src/a.ts', 'src/b.ts'],
    meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
  };
}
```

Then, inside the test after `process.chdir(dir);`, add files before `writeContext`:

```ts
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    await writeFile(join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
    await writeContext('run1', makeCtx(dir));
```

Update the import at the top from:

```ts
import { mkdtemp, rm, readFile } from 'node:fs/promises';
```

to:

```ts
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
```

Remove the old line:

```ts
    await writeContext('run1', CTX);
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm test -- src/core/tools/__tests__/file_read.test.ts src/cli/__tests__/roundtrip.test.ts
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 7: Commit `file_read`**

```bash
git add src/core/tools/file_read.ts src/core/tools/__tests__/file_read.test.ts src/cli/file_read.ts src/cli/__tests__/roundtrip.test.ts
git commit -m "feat(tools): add ref-aware file_read"
```

---

### Task 3: Implement OCR-Compatible `file_find`

**Files:**
- Create: `src/core/tools/file_find.ts`
- Create: `src/core/tools/__tests__/file_find.test.ts`
- Create: `src/cli/file_find.ts`
- Modify: `src/cli/__tests__/roundtrip.test.ts`

**Interfaces:**
- Consumes:
  - `resolveContextRef(ctx)` from Task 1
  - `runGitSplit(args, opts)` from Task 1
- Produces:
  - `findFiles(args: Record<string, unknown>, ctx: ReviewContext): Promise<string>`
  - CLI binary name generated automatically by `scripts/shebang.mjs`: `bin/file_find`

- [ ] **Step 1: Write failing core tests for `file_find`**

Create `src/core/tools/__tests__/file_find.test.ts`:

```ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { findFiles } from '../file_find.js';
import type { ReviewContext } from '../../model/request.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function ctx(repoRoot: string, range: string): ReviewContext {
  return {
    runId: 'run1',
    repoRoot,
    range,
    background: '',
    files: [],
    changeFiles: [],
    meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
  };
}

async function setupRepo(): Promise<{ repo: string; first: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-file-find-'));
  await git(repo, ['init', '-q']);
  await git(repo, ['checkout', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'AlphaService.ts'), 'export const a = 1;\n');
  await writeFile(join(repo, 'src', 'beta-service.ts'), 'export const b = 1;\n');
  await writeFile(join(repo, 'README.md'), '# readme\n');
  await writeFile(join(repo, 'no_extension'), 'skip me\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'first']);
  const first = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(join(repo, 'src', 'NewService.ts'), 'export const n = 1;\n');
  return { repo, first };
}

test('findFiles returns not-found marker for blank query_name', async () => {
  const out = await findFiles({}, ctx('/repo', 'workspace'));
  assert.equal(out, '// The file was not found');
});

test('findFiles searches workspace tracked and untracked files case-insensitively', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await findFiles({ query_name: 'service' }, ctx(repo, 'workspace'));
    assert.match(out, /src\/AlphaService\.ts/);
    assert.match(out, /src\/beta-service\.ts/);
    assert.match(out, /src\/NewService\.ts/);
    assert.doesNotMatch(out, /no_extension/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('findFiles honors case_sensitive', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await findFiles({ query_name: 'Service', case_sensitive: true }, ctx(repo, 'workspace'));
    assert.match(out, /src\/AlphaService\.ts/);
    assert.match(out, /src\/NewService\.ts/);
    assert.doesNotMatch(out, /src\/beta-service\.ts/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('findFiles uses commit tree when range has a commit ref', async () => {
  const { repo, first } = await setupRepo();
  try {
    const out = await findFiles({ query_name: 'Service' }, ctx(repo, `commit:${first}`));
    assert.match(out, /src\/AlphaService\.ts/);
    assert.match(out, /src\/beta-service\.ts/);
    assert.doesNotMatch(out, /src\/NewService\.ts/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('findFiles returns not-found marker when no file matches', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await findFiles({ query_name: 'Missing' }, ctx(repo, 'workspace'));
    assert.equal(out, '// The file was not found');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing `file_find` tests**

Run:

```bash
npm test -- src/core/tools/__tests__/file_find.test.ts
```

Expected: FAIL with module-not-found for `../file_find.js`.

- [ ] **Step 3: Implement `file_find` provider**

Create `src/core/tools/file_find.ts`:

```ts
import { resolveContextRef } from './context_ref.js';
import { runGitSplit } from './git_exec.js';
import type { ReviewContext } from '../model/request.js';

const FILE_FIND_MAX_COUNT = 100;
const FILE_FIND_TIMEOUT_MS = 10_000;

function shouldSkipFile(path: string): boolean {
  const base = path.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  const hasExt = base.includes('.');
  if (!hasExt) {
    return !['Makefile', 'Dockerfile', 'LICENSE', 'Vagrantfile', 'Containerfile'].includes(base);
  }
  return false;
}

async function listFiles(ctx: ReviewContext): Promise<string[]> {
  const ref = resolveContextRef(ctx);
  const args = ref
    ? ['ls-tree', '-r', '--name-only', '--end-of-options', ref]
    : ['ls-files', '--cached', '--others', '--exclude-standard'];
  const result = await runGitSplit(args, { cwd: ctx.repoRoot, timeoutMs: FILE_FIND_TIMEOUT_MS });
  return result.stdout
    .trimEnd()
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((path) => !shouldSkipFile(path));
}

export async function findFiles(args: Record<string, unknown>, ctx: ReviewContext): Promise<string> {
  const queryName = typeof args['query_name'] === 'string' ? args['query_name'] : '';
  if (queryName.trim() === '') return '// The file was not found';

  const caseSensitive = args['case_sensitive'] === true;
  const needle = caseSensitive ? queryName : queryName.toLowerCase();
  const files = await listFiles(ctx);
  const matched: string[] = [];

  for (const file of files) {
    const base = file.includes('/') ? file.slice(file.lastIndexOf('/') + 1) : file;
    const haystack = caseSensitive ? base : base.toLowerCase();
    if (haystack.includes(needle)) matched.push(file);
    if (matched.length >= FILE_FIND_MAX_COUNT) break;
  }

  return matched.length === 0 ? '// The file was not found' : matched.join('\n');
}
```

- [ ] **Step 4: Implement `file_find` CLI wrapper**

Create `src/cli/file_find.ts`:

```ts
#!/usr/bin/env node
import { parseToolArgs } from '../core/tools/args.js';
import { findFiles } from '../core/tools/file_find.js';
import { readContext } from '../core/runs/store.js';
import type { ReviewContext } from '../core/model/request.js';

async function main(): Promise<void> {
  const { runId, args } = parseToolArgs(process.argv.slice(2));
  const ctx = await readContext<ReviewContext>(runId);
  const result = await findFiles(args, ctx);
  process.stdout.write(result + (result.endsWith('\n') ? '' : '\n'));
}

main().catch((err) => {
  process.stderr.write(`[file_find] ${err?.message ?? err}\n`);
  process.exit(2);
});
```

- [ ] **Step 5: Add `file_find` to roundtrip CLI coverage**

In `src/cli/__tests__/roundtrip.test.ts`, after the `file_read` assertion from Task 2, add:

```ts
    const found = await runCli(dir, 'file_find.ts', [
      '--runId', 'run1',
      '--args', JSON.stringify({ query_name: 'a.ts' }),
    ]);
    assert.match(found.stdout, /src\/a\.ts/);
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm test -- src/core/tools/__tests__/file_find.test.ts src/cli/__tests__/roundtrip.test.ts
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 7: Commit `file_find`**

```bash
git add src/core/tools/file_find.ts src/core/tools/__tests__/file_find.test.ts src/cli/file_find.ts src/cli/__tests__/roundtrip.test.ts
git commit -m "feat(tools): add ref-aware file_find"
```

---

### Task 4: Implement OCR-Compatible `code_search`

**Files:**
- Create: `src/core/tools/code_search.ts`
- Create: `src/core/tools/__tests__/code_search.test.ts`
- Create: `src/cli/code_search.ts`
- Modify: `src/cli/__tests__/roundtrip.test.ts`

**Interfaces:**
- Consumes:
  - `resolveContextRef(ctx)` from Task 1
  - `runGitSplit(args, opts)` from Task 1
- Produces:
  - `searchCode(args: Record<string, unknown>, ctx: ReviewContext): Promise<string>`
  - CLI binary name generated automatically by `scripts/shebang.mjs`: `bin/code_search`

- [ ] **Step 1: Write failing core tests for `code_search`**

Create `src/core/tools/__tests__/code_search.test.ts`:

```ts
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCode } from '../code_search.js';
import type { ReviewContext } from '../../model/request.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function ctx(repoRoot: string, range: string): ReviewContext {
  return {
    runId: 'run1',
    repoRoot,
    range,
    background: '',
    files: [],
    changeFiles: [],
    meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
  };
}

async function setupRepo(): Promise<{ repo: string; first: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-code-search-'));
  await git(repo, ['init', '-q']);
  await git(repo, ['checkout', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'a.ts'), 'export const token = "OLD_TOKEN";\nexport const other = 1;\n');
  await writeFile(join(repo, 'src', 'b.ts'), 'export const token = "SECOND";\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'first']);
  const first = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(join(repo, 'src', 'a.ts'), 'export const token = "NEW_TOKEN";\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'second']);
  return { repo, first };
}

test('searchCode returns blank-search error', async () => {
  const out = await searchCode({}, ctx('/repo', 'workspace'));
  assert.equal(out, 'Error: search_text is blank');
});

test('searchCode searches workspace with fixed string by default', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await searchCode({ search_text: 'NEW_TOKEN' }, ctx(repo, 'workspace'));
    assert.match(out, /File: src\/a\.ts/);
    assert.match(out, /1\|export const token = "NEW_TOKEN";/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('searchCode searches historical commit when context has commit ref', async () => {
  const { repo, first } = await setupRepo();
  try {
    const out = await searchCode({ search_text: 'OLD_TOKEN' }, ctx(repo, `commit:${first}`));
    assert.match(out, /File: src\/a\.ts/);
    assert.match(out, /1\|export const token = "OLD_TOKEN";/);
    assert.doesNotMatch(out, /NEW_TOKEN/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('searchCode honors file_patterns pathspecs', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await searchCode({ search_text: 'token', file_patterns: ['src/b.ts'] }, ctx(repo, 'workspace'));
    assert.match(out, /File: src\/b\.ts/);
    assert.doesNotMatch(out, /File: src\/a\.ts/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('searchCode supports Perl regular expressions when requested', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await searchCode({ search_text: 'NEW_[A-Z]+', use_perl_regexp: true }, ctx(repo, 'workspace'));
    assert.match(out, /NEW_TOKEN/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('searchCode returns no matches marker for empty result', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await searchCode({ search_text: 'DOES_NOT_EXIST' }, ctx(repo, 'workspace'));
    assert.equal(out, 'No matches found');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run failing `code_search` tests**

Run:

```bash
npm test -- src/core/tools/__tests__/code_search.test.ts
```

Expected: FAIL with module-not-found for `../code_search.js`.

- [ ] **Step 3: Implement `code_search` provider**

Create `src/core/tools/code_search.ts`:

```ts
import { resolveContextRef } from './context_ref.js';
import { runGitSplit } from './git_exec.js';
import type { ReviewContext } from '../model/request.js';

const GIT_GREP_MAX_COUNT = 100;
const GIT_GREP_TIMEOUT_MS = 10_000;

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item !== '');
}

function buildGrepArgs(
  ctx: ReviewContext,
  searchText: string,
  caseSensitive: boolean,
  usePerlRegexp: boolean,
  pathspec: string[],
): string[] {
  const args = ['--no-pager', 'grep'];
  if (!caseSensitive) args.push('-i');
  args.push(usePerlRegexp ? '-P' : '-F');
  args.push('-n', '--no-color', '--max-count', `${GIT_GREP_MAX_COUNT}`, '-e', searchText);

  const ref = resolveContextRef(ctx);
  if (ref) {
    args.push('--end-of-options', ref);
  }

  args.push('--', ...pathspec);
  return args;
}

interface MatchLine {
  lineNum: number;
  content: string;
}

export async function searchCode(args: Record<string, unknown>, ctx: ReviewContext): Promise<string> {
  const searchText = typeof args['search_text'] === 'string' ? args['search_text'] : '';
  if (searchText.trim() === '') return 'Error: search_text is blank';

  const caseSensitive = args['case_sensitive'] === true;
  const usePerlRegexp = args['use_perl_regexp'] === true;
  const filePatterns = stringArray(args['file_patterns']);
  const gitArgs = buildGrepArgs(ctx, searchText, caseSensitive, usePerlRegexp, filePatterns);

  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await runGitSplit(gitArgs, {
      cwd: ctx.repoRoot,
      timeoutMs: GIT_GREP_TIMEOUT_MS,
      allowExitCodes: [0, 1],
    });
  } catch (err) {
    if ((err as Error).message.includes('timed out')) {
      return 'code_search timed out. Try narrowing file_patterns to a more specific path.';
    }
    throw new Error(`code_search failed: ${(err as Error).message}`);
  }

  if (result.code !== 0 && result.stdout === '') {
    if (result.stderr.trim() === '') return 'No matches found';
    return `Error: ${result.stderr.trim()}`;
  }

  const lines = result.stdout.trimEnd().split('\n').filter(Boolean);
  if (lines.length === 0) return 'No matches found';
  const truncated = lines.length >= GIT_GREP_MAX_COUNT;
  const hasRef = resolveContextRef(ctx) !== undefined;
  const splitN = hasRef ? 4 : 3;
  const offset = hasRef ? 1 : 0;

  const fileOrder: string[] = [];
  const seen = new Set<string>();
  const fileMatches = new Map<string, MatchLine[]>();

  for (const line of lines) {
    const parts = line.split(':');
    if (parts.length < splitN) continue;
    const prefix = parts.slice(0, offset).join(':');
    void prefix;
    const fname = parts[offset];
    const lineNum = Number.parseInt(parts[offset + 1], 10);
    const content = parts.slice(offset + 2).join(':');
    if (!fname || !Number.isFinite(lineNum)) continue;
    if (!seen.has(fname)) {
      seen.add(fname);
      fileOrder.push(fname);
      fileMatches.set(fname, []);
    }
    fileMatches.get(fname)?.push({ lineNum, content });
  }

  let out = '';
  if (truncated) {
    out += `Note: The results have been truncated. Only showing first ${GIT_GREP_MAX_COUNT} results.\n`;
  }

  for (const path of fileOrder) {
    const matches = fileMatches.get(path) ?? [];
    out += `File: ${path}\nMatch lines: ${matches.length}\n`;
    for (const match of matches) {
      out += `${match.lineNum}|${match.content}\n`;
    }
    out += '\n';
  }

  if (result.code !== 0 && result.stderr.trim() !== '') {
    out += `Warning: ${result.stderr.trim()}\n`;
  }
  return out;
}
```

- [ ] **Step 4: Implement `code_search` CLI wrapper**

Create `src/cli/code_search.ts`:

```ts
#!/usr/bin/env node
import { parseToolArgs } from '../core/tools/args.js';
import { searchCode } from '../core/tools/code_search.js';
import { readContext } from '../core/runs/store.js';
import type { ReviewContext } from '../core/model/request.js';

async function main(): Promise<void> {
  const { runId, args } = parseToolArgs(process.argv.slice(2));
  const ctx = await readContext<ReviewContext>(runId);
  const result = await searchCode(args, ctx);
  process.stdout.write(result + (result.endsWith('\n') ? '' : '\n'));
}

main().catch((err) => {
  process.stderr.write(`[code_search] ${err?.message ?? err}\n`);
  process.exit(2);
});
```

- [ ] **Step 5: Add `code_search` to roundtrip CLI coverage**

In `src/cli/__tests__/roundtrip.test.ts`, after the `file_find` assertion from Task 3, add:

```ts
    const searched = await runCli(dir, 'code_search.ts', [
      '--runId', 'run1',
      '--args', JSON.stringify({ search_text: 'export const a' }),
    ]);
    assert.match(searched.stdout, /File: src\/a\.ts/);
    assert.match(searched.stdout, /1\|export const a = 2;/);
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm test -- src/core/tools/__tests__/code_search.test.ts src/cli/__tests__/roundtrip.test.ts
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 7: Commit `code_search`**

```bash
git add src/core/tools/code_search.ts src/core/tools/__tests__/code_search.test.ts src/cli/code_search.ts src/cli/__tests__/roundtrip.test.ts
git commit -m "feat(tools): add ref-aware code_search"
```

---

### Task 5: Update Reviewer Prompts and Validate Binaries

**Files:**
- Modify: `agents/ocr-reviewer.md:15-24`
- Modify: `skills/ocr-review-file/SKILL.md:38-55`
- Modify: `README.md` if it mentions `Read`/`Glob`/`Grep` as the only context tools
- Generated by build: `bin/file_read`, `bin/file_find`, `bin/code_search`

**Interfaces:**
- Consumes:
  - `file_read --runId <runId> --args '{"file_path":"src/a.ts","start_line":1,"end_line":80}'`
  - `file_find --runId <runId> --args '{"query_name":"Service","case_sensitive":false}'`
  - `code_search --runId <runId> --args '{"search_text":"foo","file_patterns":["src/**/*.ts"]}'`
- Produces: live reviewer instructions that use the new OCR-compatible context tools.

- [ ] **Step 1: Update reviewer agent workflow text**

In `agents/ocr-reviewer.md`, replace workflow step 2:

```md
2. Apply the **ocr-review-file** skill: analyze the diff, gather context via Read/Glob/Grep/file_read_diff as needed.
```

with:

```md
2. Apply the **ocr-review-file** skill: analyze the diff, gather context via `file_read`, `file_find`, `code_search`, and `file_read_diff` Bash commands as needed. Prefer these commands over host Read/Glob/Grep when the prepared run is `commit:<sha>` or `<from>..<to>`, because they read/search the reviewed ref rather than the current workspace.
```

- [ ] **Step 2: Update review-file skill tool mapping**

In `skills/ocr-review-file/SKILL.md`, replace lines 38-55 with:

```md
## Tool Mapping (host: Claude Code)

- To read a file from the prepared review context: run **Bash** with
  `file_read --runId <runId> --args '{"file_path":"<path>","start_line":1,"end_line":120}'`.
- To find files by name in the prepared review context: run **Bash** with
  `file_find --runId <runId> --args '{"query_name":"<filename-fragment>","case_sensitive":false}'`.
- To search code text in the prepared review context: run **Bash** with
  `code_search --runId <runId> --args '{"search_text":"<literal-or-regex>","case_sensitive":false,"use_perl_regexp":false,"file_patterns":["src/**/*.ts"]}'`.
  Omit `file_patterns` to search the whole repository. Set `use_perl_regexp` to `true` only when the search string is a Perl-compatible regular expression.
- To read another changed file's diff: run **Bash** with
  `file_read_diff --runId <runId> --args '{"path_array":["<path1>","<path2>"]}'`.
- To submit a confirmed review comment (or multiple): run **Bash** with
  `code_comment --runId <runId> --args '{"path":"<p>","subagent":"<subagent_id>","comments":[{"start_line":<n>,"end_line":<m>,"content":"<text>","suggestion_code":"<code>","existing_code":"<code>","thinking":"<text>"}]}'`
  (omit `suggestion_code` / `existing_code` / `thinking` when not applicable; multiple comments go in the `comments` array.)
- When your review is complete, run **Bash** with
  `task_done --runId <runId> --args '{"subagent":"<subagent_id>","file":"<currentFilePath>"}'`.

## Reply limit

- If the current code review task is complete, run the `task_done` Bash command to end the task.
- If a code issue has been identified and confirmed, run the `code_comment` Bash command to provide feedback.
- If additional context is needed to confirm the issue, use file_read / file_find / code_search / file_read_diff.
```

- [ ] **Step 3: Update README only if it contains stale context-tool mapping**

Run:

```bash
grep -n "Read/Glob/Grep\|code_search\|file_read\|file_find" README.md
```

If it prints no lines, skip this step. If it prints lines claiming `file_read`, `file_find`, or `code_search` are not implemented or should be replaced by host tools, replace that paragraph with:

```md
Reviewer subagents gather context through the plugin CLIs `file_read`, `file_find`, `code_search`, and `file_read_diff`. These commands load `.ocr-runs/<runId>/context.json`, so commit and range reviews inspect the reviewed git ref rather than whatever happens to be checked out in the workspace.
```

- [ ] **Step 4: Build and verify generated binaries**

Run:

```bash
npm run build
ls -la bin/file_read bin/file_find bin/code_search
```

Expected: build PASS and all three bin paths exist.

- [ ] **Step 5: Run complete verification**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run smoke
```

Expected: all PASS. If `npm run smoke` fails because it asserts an exact bin count, update `scripts/smoke.sh` to include `file_read`, `file_find`, and `code_search`, then rerun `npm run smoke`.

- [ ] **Step 6: Commit prompt and binary validation updates**

```bash
git add agents/ocr-reviewer.md skills/ocr-review-file/SKILL.md README.md scripts/smoke.sh
git commit -m "docs(tools): document ref-aware context tools"
```

---

## Self-Review

**Spec coverage:**
- `file_read` from original OCR is covered by Task 2, including `file_path`, `start_line`, `end_line`, 500-line truncation, formatted line output, and commit/range ref reads.
- `file_find` from original OCR is covered by Task 3, including `query_name`, `case_sensitive`, max 100 results, workspace tracked/untracked listing, and commit/range tree listing.
- `code_search` from original OCR is covered by Task 4, including `search_text`, `case_sensitive`, `use_perl_regexp`, `file_patterns`, max 100 matches, grouped output, no-match output, and commit/range `git grep <ref>` behavior.
- Reviewer prompt integration is covered by Task 5.
- Build/bin generation is covered by Task 5 because `scripts/shebang.mjs` automatically exposes any `dist/cli/*.mjs` file.

**Placeholder scan:**
- The plan contains no `TBD`, no unspecified edge-case steps, and no references to undefined functions. Each task lists exact files, interfaces, code, commands, and expected outcomes.

**Type consistency:**
- Task 1 exports `resolveContextRef`, `runGitSplit`, `readContextFile`, and `readContextFileLines`; Tasks 2-4 consume those exact names.
- Provider names are `readFile`, `findFiles`, and `searchCode`; CLI wrappers import those exact functions.
- CLI args remain `--runId` and `--args` via existing `parseToolArgs`.
