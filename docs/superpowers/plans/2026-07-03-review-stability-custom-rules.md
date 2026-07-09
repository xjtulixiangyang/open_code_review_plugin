# Review Stability + Custom Rules Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/review` stable by defaulting file-review concurrency to 2, adding explicit retry orchestration, and fully wiring custom rule loading into review context generation.

**Architecture:** Keep deterministic work in TypeScript CLI/core modules and leave LLM orchestration in `commands/review.md`. Custom rules are loaded once during `ocr-prepare`, applied to file scoping and rule resolution, then persisted in `ReviewContext.files[].rulesHit[]` so reviewer/filter/relocate prompts use the exact effective rule. Concurrency/retry behavior is surfaced in `ocr-prepare` output and made explicit in the slash command orchestration, following the reference OCR semaphore/retry intent from `/Users/lixiangyang/Desktop/代码/open-code-review/internal/agent/agent.go` while adapting to Claude Code subagent dispatch.

**Tech Stack:** TypeScript 5.5 strict mode · Node >=18 ESM · `node --import tsx --test` · `yaml` package already present · git CLI · Claude Code plugin command/skill/subagent assets.

## Global Constraints

- Do not add any LLM SDK, HTTP provider client, API key field, or standalone AI loop.
- Keep `LlmComment` / `PlanOutput` OCR-compatible snake_case fields unchanged.
- Follow current project patterns: deterministic TS code under `src/core` and `src/cli`; orchestration text under `commands/review.md`.
- Reference OCR behavior where applicable: original OCR defaults concurrency to 8 and uses a semaphore in `internal/agent/agent.go`; this plugin intentionally changes default to 2 for stability while preserving user override.
- Rule priority for this increment is exactly: CLI `--rules <path>` > repo `.code-review.yaml/.yml/.json` > user `~/.code-review/rules.yaml/.yml/.json` > built-in system rules.
- Custom `include`/`exclude` affects file scope during `ocr-prepare`; custom `rules[]` affects prompt rule text through `resolveRule()`.
- Keep failures explicit with `OCRP-*` errors; malformed rule files are hard prepare failures.
- Every task must run `npm test` or a targeted `node --import tsx --test ...` command before commit.

---

## File Structure

**Modify:**

- `src/core/rules/custom_rules.ts` — load CLI, repo, and user-level custom rule files; expose source kind and effective source label.
- `src/core/rules/__tests__/custom_rules.test.ts` — add tests for user-level discovery, CLI/repo/user priority, absolute CLI paths, and malformed user files.
- `src/core/context/review_context.ts` — call `loadCustomRules()`, use `isFileInScope()`, use `resolveRule()`, persist `rulesSource`, `excludedFiles`, and effective per-file rule text/source.
- `src/core/context/__tests__/review_context.test.ts` — add context-level tests for custom include/exclude and custom rule text wiring.
- `src/core/model/request.ts` — extend `RuleHit` with optional `source` and `text` fields used by command orchestration.
- `src/cli/prepare.ts` — parse `--rules`, normalize/default `--concurrency`, include concurrency in stdout JSON, reject invalid concurrency.
- `src/cli/__tests__/prepare_args.test.ts` — add parser/normalizer unit tests. If `parseArgs` is currently private, export it as `export function parseArgs` and add `normalizeConcurrency` export.
- `commands/review.md` — use prepare summary concurrency (default 2), describe bounded batches, reviewer retry attempts, filter/relocate retry behavior, and custom-rule prompt injection.
- `README.md` — update configuration/concurrency docs to match implemented behavior.

**No new runtime dependencies.**

---

### Task 1: Complete 4-level custom rule loading

**Files:**
- Modify: `src/core/rules/custom_rules.ts`
- Modify: `src/core/rules/__tests__/custom_rules.test.ts`

**Interfaces:**
- Consumes existing `CustomRuleEntry`, `CustomRuleFile`, and `LoadedCustomRules`.
- Produces updated signature:
  ```ts
  export interface LoadedCustomRules {
    source: string;
    sourceKind: 'cli' | 'repo' | 'user' | 'none';
    rules: CustomRuleEntry[];
    include: string[];
    exclude: string[];
  }

  export interface LoadCustomRulesOptions {
    homeDir?: string;
  }

  export async function loadCustomRules(
    repoRoot: string,
    rulesPath?: string,
    opts?: LoadCustomRulesOptions,
  ): Promise<LoadedCustomRules>;
  ```

- [ ] **Step 1: Add failing tests for user rules and priority**

Append these tests to `src/core/rules/__tests__/custom_rules.test.ts`:

```ts
import { resolve } from 'node:path';

async function mkHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ocrp-home-'));
}

test('loadCustomRules: user ~/.code-review/rules.yaml is used when repo has no config', async () => {
  const repo = await mkRepo();
  const home = await mkHome();
  try {
    await mkdir(join(home, '.code-review'), { recursive: true });
    await writeFile(join(home, '.code-review', 'rules.yaml'), 'rules:\n  - path: "src/**"\n    rule: "user rule"\n');
    const r = await loadCustomRules(repo, undefined, { homeDir: home });
    assert.equal(r.sourceKind, 'user');
    assert.equal(r.source, '~/.code-review/rules.yaml');
    assert.equal(r.rules[0].rule, 'user rule');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('loadCustomRules: repo config wins over user config', async () => {
  const repo = await mkRepo();
  const home = await mkHome();
  try {
    await mkdir(join(home, '.code-review'), { recursive: true });
    await writeFile(join(home, '.code-review', 'rules.yaml'), 'rules:\n  - path: "**"\n    rule: "user rule"\n');
    await writeFile(join(repo, '.code-review.yaml'), 'rules:\n  - path: "**"\n    rule: "repo rule"\n');
    const r = await loadCustomRules(repo, undefined, { homeDir: home });
    assert.equal(r.sourceKind, 'repo');
    assert.equal(r.source, '.code-review.yaml');
    assert.equal(r.rules[0].rule, 'repo rule');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('loadCustomRules: CLI path wins over repo and user config', async () => {
  const repo = await mkRepo();
  const home = await mkHome();
  try {
    await mkdir(join(home, '.code-review'), { recursive: true });
    await writeFile(join(home, '.code-review', 'rules.yaml'), 'rules:\n  - path: "**"\n    rule: "user rule"\n');
    await writeFile(join(repo, '.code-review.yaml'), 'rules:\n  - path: "**"\n    rule: "repo rule"\n');
    await writeFile(join(repo, 'cli.yaml'), 'rules:\n  - path: "**"\n    rule: "cli rule"\n');
    const r = await loadCustomRules(repo, 'cli.yaml', { homeDir: home });
    assert.equal(r.sourceKind, 'cli');
    assert.equal(r.source, 'cli.yaml');
    assert.equal(r.rules[0].rule, 'cli rule');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('loadCustomRules: absolute CLI path is accepted', async () => {
  const repo = await mkRepo();
  const other = await mkRepo();
  try {
    const abs = join(other, 'external-rules.yaml');
    await writeFile(abs, 'rules:\n  - path: "**"\n    rule: "absolute cli rule"\n');
    const r = await loadCustomRules(repo, abs);
    assert.equal(r.sourceKind, 'cli');
    assert.equal(r.source, abs);
    assert.equal(r.rules[0].rule, 'absolute cli rule');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test('loadCustomRules: user malformed YAML throws OCRP-RULES-091', async () => {
  const repo = await mkRepo();
  const home = await mkHome();
  try {
    await mkdir(join(home, '.code-review'), { recursive: true });
    await writeFile(join(home, '.code-review', 'rules.yaml'), 'rules: [unterminated\n');
    await assert.rejects(loadCustomRules(repo, undefined, { homeDir: home }), /OCRP-RULES-091/);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the custom rules tests and verify they fail**

Run:

```bash
node --import tsx --test src/core/rules/__tests__/custom_rules.test.ts
```

Expected: failures mentioning user-level discovery or `sourceKind` not accepting `'user'`.

- [ ] **Step 3: Implement user-level discovery and absolute CLI paths**

Edit `src/core/rules/custom_rules.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { stat } from 'node:fs/promises';
import YAML from 'yaml';

export interface CustomRuleEntry {
  path: string;
  rule: string;
}

export interface CustomRuleFile {
  rules?: CustomRuleEntry[];
  include?: string[];
  exclude?: string[];
}

export interface LoadedCustomRules {
  source: string;
  sourceKind: 'cli' | 'repo' | 'user' | 'none';
  rules: CustomRuleEntry[];
  include: string[];
  exclude: string[];
}

export interface LoadCustomRulesOptions {
  homeDir?: string;
}

const REPO_CANDIDATES = ['.code-review.yaml', '.code-review.yml', '.code-review.json'] as const;
const USER_CANDIDATES = ['rules.yaml', 'rules.yml', 'rules.json'] as const;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isRuleEntry(v: unknown): v is CustomRuleEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['path'] === 'string' && typeof o['rule'] === 'string';
}

function validateRoot(raw: unknown, source: string): CustomRuleFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`OCRP-RULES-092: rule file ${source} root must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const rules = o['rules'];
  if (rules !== undefined) {
    if (!Array.isArray(rules) || !rules.every(isRuleEntry)) {
      throw new Error(`OCRP-RULES-093: rule file ${source} has invalid rules[] entries (each needs string path and rule)`);
    }
  }
  if (o['include'] !== undefined && !isStringArray(o['include'])) {
    throw new Error(`OCRP-RULES-093: rule file ${source} include must be a string array`);
  }
  if (o['exclude'] !== undefined && !isStringArray(o['exclude'])) {
    throw new Error(`OCRP-RULES-093: rule file ${source} exclude must be a string array`);
  }
  return {
    rules: (rules as CustomRuleEntry[] | undefined) ?? [],
    include: (o['include'] as string[] | undefined) ?? [],
    exclude: (o['exclude'] as string[] | undefined) ?? [],
  };
}

function parseContent(text: string, source: string): CustomRuleFile {
  let raw: unknown;
  if (source.endsWith('.json')) {
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`OCRP-RULES-091: failed to parse JSON ${source}: ${(err as Error).message}`);
    }
  } else {
    try {
      raw = YAML.parse(text);
    } catch (err) {
      throw new Error(`OCRP-RULES-091: failed to parse YAML ${source}: ${(err as Error).message}`);
    }
  }
  return validateRoot(raw, source);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function loadFile(
  absPath: string,
  sourceLabel: string,
  sourceKind: 'cli' | 'repo' | 'user',
): Promise<LoadedCustomRules> {
  let text: string;
  try {
    text = await readFile(absPath, 'utf8');
  } catch (err) {
    throw new Error(`OCRP-RULES-090: cannot read rule file ${sourceLabel}: ${(err as Error).message}`);
  }
  const f = parseContent(text, sourceLabel);
  return {
    source: sourceLabel,
    sourceKind,
    rules: f.rules ?? [],
    include: f.include ?? [],
    exclude: f.exclude ?? [],
  };
}

export async function loadCustomRules(
  repoRoot: string,
  rulesPath?: string,
  opts: LoadCustomRulesOptions = {},
): Promise<LoadedCustomRules> {
  if (rulesPath) {
    const abs = isAbsolute(rulesPath) ? rulesPath : join(repoRoot, rulesPath);
    return loadFile(abs, rulesPath, 'cli');
  }

  for (const name of REPO_CANDIDATES) {
    const abs = join(repoRoot, name);
    if (await exists(abs)) {
      return loadFile(abs, name, 'repo');
    }
  }

  const home = opts.homeDir ?? homedir();
  for (const name of USER_CANDIDATES) {
    const abs = join(home, '.code-review', name);
    if (await exists(abs)) {
      return loadFile(abs, `~/.code-review/${name}`, 'user');
    }
  }

  return { source: 'system', sourceKind: 'none', rules: [], include: [], exclude: [] };
}
```

- [ ] **Step 4: Run the custom rules tests and verify they pass**

Run:

```bash
node --import tsx --test src/core/rules/__tests__/custom_rules.test.ts
```

Expected: all tests in `custom_rules.test.ts` pass.

- [ ] **Step 5: Run all rule tests**

Run:

```bash
node --import tsx --test src/core/rules/__tests__/*.test.ts
```

Expected: all rule tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/rules/custom_rules.ts src/core/rules/__tests__/custom_rules.test.ts
git commit -m "feat(rules): load user custom rules with priority

- support ~/.code-review/rules.yaml/.yml/.json
- keep priority CLI > repo > user > built-in
- accept absolute --rules paths
- cover priority and malformed user config tests

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Wire custom rules and file scope into ReviewContext

**Files:**
- Modify: `src/core/model/request.ts`
- Modify: `src/core/context/review_context.ts`
- Create or Modify: `src/core/context/__tests__/review_context.test.ts`

**Interfaces:**
- Consumes from Task 1: `loadCustomRules(repoRoot, rulesPath?)`.
- Consumes existing: `isFileInScope(filePath, custom)`, `resolveRule(filePath, custom)`.
- Produces:
  ```ts
  export interface RuleHit {
    ruleId: string;
    message: string;
    docPath?: string;
    source?: 'custom' | 'system';
    text?: string;
  }
  ```
- `ReviewContext.rulesSource` is the selected source label (`cli.yaml`, `.code-review.yaml`, `~/.code-review/rules.yaml`, or `system`).
- `ReviewContext.excludedFiles` records files removed by custom/default scoping.

- [ ] **Step 1: Extend `RuleHit` type**

Edit `src/core/model/request.ts` so `RuleHit` is:

```ts
export interface RuleHit {
  ruleId: string;
  message: string;
  docPath?: string;
  source?: 'custom' | 'system';
  text?: string;
}
```

- [ ] **Step 2: Add failing ReviewContext tests**

Create `src/core/context/__tests__/review_context.test.ts` if it does not exist. Use a real temporary git repository because `buildReviewContext()` calls git:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildReviewContext } from '../review_context.js';

async function mkGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-context-'));
  const git = (args: string[]) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  };
  git(['init']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test User']);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'keep.ts'), 'export const keep = 1;\n');
  await writeFile(join(dir, 'src', 'skip.ts'), 'export const skip = 1;\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);
  await writeFile(join(dir, 'src', 'keep.ts'), 'export const keep = 2;\n');
  await writeFile(join(dir, 'src', 'skip.ts'), 'export const skip = 2;\n');
  return dir;
}

test('buildReviewContext applies custom include/exclude and custom rule text', async () => {
  const repo = await mkGitRepo();
  try {
    await writeFile(join(repo, '.code-review.yaml'), [
      'include:',
      '  - "src/**/*.ts"',
      'exclude:',
      '  - "src/skip.ts"',
      'rules:',
      '  - path: "src/keep.ts"',
      '    rule: "custom keep rule"',
      '',
    ].join('\n'));

    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace' });

    assert.equal(ctx.rulesSource, '.code-review.yaml');
    assert.deepEqual(ctx.changeFiles, ['src/keep.ts']);
    assert.ok(ctx.excludedFiles?.some((f) => f.path === 'src/skip.ts' && f.reason === 'user-exclude'));

    const hit = ctx.files[0].rulesHit[0];
    assert.equal(hit.ruleId, 'custom:src/keep.ts');
    assert.equal(hit.source, 'custom');
    assert.equal(hit.message, 'custom keep rule');
    assert.equal(hit.text, 'custom keep rule');
    assert.equal(hit.docPath, undefined);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('buildReviewContext falls back to system rule when no custom rule matches', async () => {
  const repo = await mkGitRepo();
  try {
    await writeFile(join(repo, '.code-review.yaml'), [
      'rules:',
      '  - path: "docs/**"',
      '    rule: "docs only"',
      '',
    ].join('\n'));

    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace' });
    const hit = ctx.files.find((f) => f.path === 'src/keep.ts')!.rulesHit[0];

    assert.equal(ctx.rulesSource, '.code-review.yaml');
    assert.equal(hit.source, 'system');
    assert.equal(hit.docPath, 'ts_js_tsx_jsx.md');
    assert.ok(hit.text && hit.text.length > 50);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run context tests and verify they fail**

Run:

```bash
node --import tsx --test src/core/context/__tests__/review_context.test.ts
```

Expected: fail because `buildReviewContext()` still uses `isAllowed()` and `buildSystemRulePrompt()` only.

- [ ] **Step 4: Wire custom rules into `review_context.ts`**

Edit `src/core/context/review_context.ts` to replace the imports and filtering/rule matching logic.

Use these imports:

```ts
import { gitRevParseToplevel, gitDiff } from '../diff/git.js';
import { collectWorkspaceDiff } from '../diff/workspace.js';
import { parseUnifiedDiff } from '../diff/parser.js';
import { isFileInScope } from '../allowlist/allowed_ext.js';
import { loadCustomRules } from '../rules/custom_rules.js';
import { resolveRule } from '../rules/matcher.js';
import { MAX_HUNK_LINES, PLUGIN_VERSION } from '../prompts/constants.js';
import { newRunId } from '../runs/store.js';
import type { ReviewRequest, ReviewContext, FileChange } from '../model/request.js';
```

Replace the allowlist/rule block with:

```ts
  const customRules = await loadCustomRules(repoRoot, req.rulesPath);
  const excludedFiles: Array<{ path: string; reason: string }> = [];
  const scopedFiles: FileChange[] = [];

  for (const f of files) {
    const scope = isFileInScope(f.path, customRules);
    if (!scope.allowed) {
      excludedFiles.push({ path: f.path, reason: scope.reason });
      continue;
    }
    scopedFiles.push(f);
  }
  files = scopedFiles;

  for (const f of files) {
    const rule = resolveRule(f.path, customRules);
    f.rulesHit = [{
      ruleId: rule.ruleId,
      message: rule.text,
      docPath: rule.docPath,
      source: rule.source,
      text: rule.text,
    }];
  }
```

In the returned context object, add:

```ts
    rulesSource: customRules.source,
    excludedFiles,
```

The final return object shape should include these keys before `meta` or after `meta`; JSON order is not semantically important.

- [ ] **Step 5: Run context tests and verify they pass**

Run:

```bash
node --import tsx --test src/core/context/__tests__/review_context.test.ts
```

Expected: both context tests pass.

- [ ] **Step 6: Run allowlist/rules/context tests together**

Run:

```bash
node --import tsx --test src/core/allowlist/__tests__/*.test.ts src/core/rules/__tests__/*.test.ts src/core/context/__tests__/*.test.ts
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/model/request.ts src/core/context/review_context.ts src/core/context/__tests__/review_context.test.ts
git commit -m "feat(review): apply custom rules in review context

- load effective rules during ocr-prepare
- apply custom include/exclude file scope
- resolve custom rules before built-in system rules
- persist rule source and effective rule text in ReviewContext

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Parse `--rules` and default concurrency to 2

**Files:**
- Modify: `src/cli/prepare.ts`
- Create: `src/cli/__tests__/prepare_args.test.ts`

**Interfaces:**
- Consumes: `ReviewRequest.rulesPath?: string`, `ReviewRequest.concurrency?: number`.
- Produces:
  ```ts
  export const DEFAULT_REVIEW_CONCURRENCY = 2;
  export const MAX_REVIEW_CONCURRENCY = 8;
  export function normalizeConcurrency(value: number | undefined): number;
  export function parseArgs(argv: string[]): ParsedArgs;
  ```
- `ocr-prepare` stdout JSON includes `concurrency`.

- [ ] **Step 1: Export parser types/functions and add failing tests**

Create `src/cli/__tests__/prepare_args.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REVIEW_CONCURRENCY,
  MAX_REVIEW_CONCURRENCY,
  normalizeConcurrency,
  parseArgs,
} from '../prepare.js';

test('parseArgs accepts --rules and stores rulesPath', () => {
  const args = parseArgs(['--rules', 'team-rules.yaml']);
  assert.equal(args.rulesPath, 'team-rules.yaml');
  assert.deepEqual(args.unsupported, []);
});

test('parseArgs keeps --preview and --dry-run unsupported in this increment', () => {
  const args = parseArgs(['--preview', '--dry-run']);
  assert.ok(args.unsupported.some((x) => x.includes('--preview')));
  assert.ok(args.unsupported.some((x) => x.includes('--dry-run')));
});

test('normalizeConcurrency defaults to 2', () => {
  assert.equal(normalizeConcurrency(undefined), DEFAULT_REVIEW_CONCURRENCY);
  assert.equal(DEFAULT_REVIEW_CONCURRENCY, 2);
});

test('normalizeConcurrency accepts valid positive values', () => {
  assert.equal(normalizeConcurrency(1), 1);
  assert.equal(normalizeConcurrency(4), 4);
  assert.equal(normalizeConcurrency(MAX_REVIEW_CONCURRENCY), MAX_REVIEW_CONCURRENCY);
});

test('normalizeConcurrency rejects zero, negative, and NaN', () => {
  assert.throws(() => normalizeConcurrency(0), /OCRP-RUN-011/);
  assert.throws(() => normalizeConcurrency(-1), /OCRP-RUN-011/);
  assert.throws(() => normalizeConcurrency(Number.NaN), /OCRP-RUN-011/);
});

test('normalizeConcurrency caps values above MAX_REVIEW_CONCURRENCY', () => {
  assert.equal(normalizeConcurrency(MAX_REVIEW_CONCURRENCY + 10), MAX_REVIEW_CONCURRENCY);
});
```

- [ ] **Step 2: Run prepare arg tests and verify they fail**

Run:

```bash
node --import tsx --test src/cli/__tests__/prepare_args.test.ts
```

Expected: fail because `parseArgs`, constants, and `normalizeConcurrency` are not exported and `--rules` is still unsupported.

- [ ] **Step 3: Implement parser/rules/concurrency changes**

Edit `src/cli/prepare.ts`:

1. Export constants near the top:

```ts
export const DEFAULT_REVIEW_CONCURRENCY = 2;
export const MAX_REVIEW_CONCURRENCY = 8;
```

2. Add `rulesPath?: string;` to `ParsedArgs`, and export the interface:

```ts
export interface ParsedArgs {
  mode: ReviewMode;
  commit?: string;
  from?: string;
  to?: string;
  paths?: string[];
  background?: string;
  rulesPath?: string;
  format?: 'markdown' | 'json' | 'both';
  concurrency?: number;
  unsupported: string[];
}
```

3. Export `parseArgs`:

```ts
export function parseArgs(argv: string[]): ParsedArgs {
```

4. Change `--rules` parsing from unsupported to supported:

```ts
    else if (a === '--rules' || a === '--rule') {
      out.rulesPath = next();
    } else if (a === '--format' || a === '-f') out.format = next() as ParsedArgs['format'];
```

5. Add `normalizeConcurrency`:

```ts
export function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REVIEW_CONCURRENCY;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`OCRP-RUN-011: --concurrency must be a positive integer`);
  }
  if (value > MAX_REVIEW_CONCURRENCY) return MAX_REVIEW_CONCURRENCY;
  return value;
}
```

6. In `main()`, compute concurrency once and put `rulesPath` into `ReviewRequest`:

```ts
  const concurrency = normalizeConcurrency(args.concurrency);
  const req: ReviewRequest = {
    repoRoot: process.cwd(),
    mode: args.mode,
    commit: args.commit,
    from: args.from,
    to: args.to,
    paths: args.paths,
    background: args.background,
    rulesPath: args.rulesPath,
    format: args.format,
    concurrency,
  };
```

7. Add `concurrency` to the stdout summary:

```ts
    concurrency,
```

- [ ] **Step 4: Run prepare arg tests and verify they pass**

Run:

```bash
node --import tsx --test src/cli/__tests__/prepare_args.test.ts
```

Expected: all prepare arg tests pass.

- [ ] **Step 5: Run all CLI/core tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/cli/prepare.ts src/cli/__tests__/prepare_args.test.ts
git commit -m "feat(review): default concurrency to 2 and enable --rules

- parse --rules/--rule into ReviewRequest.rulesPath
- default review concurrency to 2 for stable Claude Code dispatch
- cap concurrency above 8 and reject invalid values
- include effective concurrency in ocr-prepare summary

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Update `/review` orchestration for bounded concurrency, retries, and custom rule text

**Files:**
- Modify: `commands/review.md`

**Interfaces:**
- Consumes `ocr-prepare` stdout fields: `runId`, `fileCount`, `hunkCount`, `changedLines`, `contextPath`, `concurrency`.
- Consumes `ReviewContext.files[].rulesHit[0]` where `message`/`text` may contain custom rule text and `docPath` may be absent.
- Produces deterministic operator instructions for:
  - concurrency batches of size `concurrency` (default 2),
  - reviewer attempts `1..2`,
  - filter apply retry once,
  - relocation apply retry once.

- [ ] **Step 1: Update Step 1 prepare summary text**

In `commands/review.md`, replace the sentence:

```md
Capture the stdout JSON. It contains `runId`, `fileCount`, `hunkCount`, `changedLines`, `contextPath`.
```

with:

```md
Capture the stdout JSON. It contains `runId`, `fileCount`, `hunkCount`, `changedLines`, `contextPath`, and `concurrency`. If `concurrency` is absent because an older build produced the summary, use `2`.
```

- [ ] **Step 2: Replace Step 3 concurrency/rule injection section**

In Step 3, replace the per-file dispatch block from `For each file in context.files[]:` through `Cap concurrency at 8...` with:

```md
Process `context.files[]` in bounded batches. Let `reviewConcurrency = prepareSummary.concurrency || 2`. Dispatch at most `reviewConcurrency` reviewer subagents at the same time. Do not start the next batch until every file in the current batch has either completed review or exhausted its retry attempts.

For each file in a batch:

1. Compute `planGuidance` deterministically. If `.ocr-runs/<runId>/plan.json` exists, run:
   ```bash
   ocr-plan-guidance --runId <runId> --path <currentFilePath>
   ```
   Parse stdout JSON and use its `guidance` field. If the command fails, set `planGuidance = ""` and mention `OCRP-SKILL-040` in the final report. Do not manually re-implement plan filtering in the main conversation.
2. Compute `systemRule` from `context.files[].rulesHit[0]`:
   - If `rulesHit[0].text` is a non-empty string, use it verbatim.
   - Else if `rulesHit[0].message` is a non-empty string, use it verbatim.
   - Else read `assets/rule_docs/<rulesHit[0].docPath>` verbatim.
   - Else use an empty string and mention `OCRP-RULES-094` in the final report.
3. Dispatch a `ocr-reviewer` subagent with a prompt containing exactly:

   ```
   runId: <runId>
   subagent: reviewer-<index>-attempt-<attempt>
   currentFilePath: <path>
   currentFileDiff:
   <fenced diff block>
   changeFiles: <comma-joined list>
   requirementBackground: <background or "">
   systemRule:
   <effective systemRule text>
   planGuidance:
   <planGuidance string or "">
   currentSystemDateTime: <ISO-8601>
   ```
4. Retry reviewer dispatch at most once for the same file when the subagent errors, times out, or returns without a matching `.ocr-runs/<runId>/done/reviewer-*.json` entry for that file. Use `reviewer-<index>-attempt-2` for the retry subagent id. Do not retry a file after `task_done` is recorded.
5. If both attempts fail, continue to the next file and let `ocr-aggregate` report the file as partial (`OCRP-SUB-050/051`).
```

- [ ] **Step 3: Add explicit filter retry behavior**

In Step 3.5, replace the existing item 6 with:

```md
6. If the skill output is unparseable, treat it as a soft failure: continue without filtering this file and mention `OCRP-FILTER-070` in the final report.
7. If `ocr-filter-apply` exits non-zero, retry the exact same `ocr-filter-apply` command once. If the second attempt also exits non-zero, continue without filtering this file and mention `OCRP-FILTER-070` in the final report.
```

- [ ] **Step 4: Add explicit relocation retry behavior**

In Step 3.6, replace item 4 with:

```md
4. If `ocr-relocate-apply` exits non-zero, retry the exact same command once. If the second attempt also exits non-zero, treat it as a soft failure: continue without relocating this file and mention `OCRP-RELOCATE-080` in the final report.
```

- [ ] **Step 5: Update error handling table for custom rules**

Add these rows to the Error handling table:

```md
| OCRP-RULES-090/091/092/093 | Custom rule file cannot be read, parsed, or validated; surface stderr from `ocr-prepare` and stop. |
| OCRP-RULES-094 | Effective rule text could not be loaded for a file; continue with an empty rule and mention in final report. |
```

- [ ] **Step 6: Validate command doc has no stale default 8**

Run:

```bash
grep -n "default 8\|Cap concurrency at 8\|concurrency is 8" commands/review.md
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add commands/review.md
git commit -m "docs(review): bound concurrency and add retry orchestration

- use ocr-prepare concurrency with stable default 2
- dispatch reviewer subagents in bounded batches
- retry reviewer failures once before marking partial
- retry filter/relocate apply commands once
- inject custom rule text from ReviewContext

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Update README and run final verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes implemented behavior from Tasks 1-4.
- Produces user-facing docs matching reality.

- [ ] **Step 1: Locate README sections to edit**

Run:

```bash
grep -n "Configuration\|concurrency\|--rules\|rule\|code-review" README.md | head -80
```

Expected: shows the current configuration and command sections.

- [ ] **Step 2: Update configuration docs**

Edit README so the custom rules section states exactly:

```md
### Custom rules

`/open-code-review:review` supports custom rule files loaded in this priority order:

1. CLI `--rules <path>` / `--rule <path>`
2. Repository `.code-review.yaml`, `.code-review.yml`, or `.code-review.json`
3. User `~/.code-review/rules.yaml`, `~/.code-review/rules.yml`, or `~/.code-review/rules.json`
4. Built-in OCR-compatible system rules under `assets/rule_docs/`

YAML/JSON shape:

```yaml
include:
  - "src/**/*.ts"
exclude:
  - "src/**/*.test.ts"
rules:
  - path: "src/**/*.ts"
    rule: |
      Review TypeScript changes for API compatibility, async error handling,
      and unsafe type assertions.
```

`include` narrows the reviewed file set. `exclude` removes files from the reviewed file set. `rules` are first-match-wins and override the built-in rule text for matching paths.
```

- [ ] **Step 3: Update concurrency docs**

Edit README command/usage docs so concurrency states exactly:

```md
`--concurrency <n>` controls how many file reviewer subagents are dispatched at once. The default is `2` for stability in Claude Code sessions. Values above `8` are capped to `8`.
```

- [ ] **Step 4: Verify README has no stale unsupported text for `--rules` or default 8**

Run:

```bash
grep -n "--rules.*unsupported\|planned for P1 custom\|default 8\|concurrency.*8 file" README.md commands/review.md src/cli/prepare.ts
```

Expected: no output.

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: exits 0.

- [ ] **Step 6: Run full test suite**

Run:

```bash
npm test
```

Expected: exits 0.

- [ ] **Step 7: Run build**

Run:

```bash
npm run build
```

Expected: exits 0; `bin/ocr-prepare` and other bin entries are refreshed.

- [ ] **Step 8: Run smoke test**

Run:

```bash
npm run smoke
```

Expected: exits 0. If smoke currently exercises unsupported preview/dry-run behavior, update only the smoke invocation to use supported workspace/range behavior and record the exact change in the commit message.

- [ ] **Step 9: Commit**

```bash
git add README.md package.json package-lock.json dist bin
git commit -m "docs: document custom rules and stable concurrency

- document CLI/repo/user/built-in rule priority
- document include/exclude/rules YAML shape
- document default concurrency 2 and cap 8
- verify typecheck, tests, build, and smoke

Co-Authored-By: Claude <noreply@anthropic.com>"
```

If `dist/` or `bin/` are not tracked in this repository, remove them from `git add` and commit only tracked source/docs/lockfile changes.

---

## Self-Review

**Spec coverage:**

- Default concurrency 2: Task 3 implements parser/default; Task 4 updates orchestration; Task 5 documents it.
- Retry mechanism: Task 4 adds reviewer retry once plus filter/relocate apply retry once, matching the plugin's host-orchestrated architecture.
- Custom rules 4-level priority: Task 1 implements loader priority; Task 2 wires effective rules into context; Task 3 enables CLI `--rules`; Task 5 documents it.
- Reference OCR logic: Task 4 adapts OCR's semaphore idea to bounded subagent batches; retry behavior follows OCR's retry-on-invalid/no-tool-results intent while fitting Claude Code command orchestration.
- Stability: concurrency cap and default are deterministic; malformed rule configs fail early in `ocr-prepare`.

**Placeholder scan:** No placeholders, TBDs, or "implement later" steps remain.

**Type consistency:** `LoadedCustomRules.sourceKind` includes `'user'`; `RuleHit.source` uses `'custom' | 'system'`; `ReviewContext.rulesSource` and `excludedFiles` already exist in `request.ts`; `parseArgs` and `normalizeConcurrency` are exported for tests and used by `main()`.
