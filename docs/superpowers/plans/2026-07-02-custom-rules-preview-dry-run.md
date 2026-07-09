# Custom Rules, Preview, and Dry Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `.code-review.yaml`/`--rules` custom rules plus `--preview` and `--dry-run` no-LLM inspection modes to `open-code-review-plugin`, without changing the "delegate all model calls to the host Claude Code session" architecture.

**Architecture:** Pure-TypeScript deterministic modules in `src/core/*` parse config, filter files, and resolve rules. `src/cli/prepare.ts` gains the new flags and emits a preview/dry-run summary JSON. `commands/review.md` short-circuits when the summary carries `preview` or `dryRun`. Custom rule text flows through `rulesHit[0].message`; built-in rules keep using `rulesHit[0].docPath`.

**Tech Stack:** Node.js 18+, TypeScript 5.5 (`strict`), `node --test`, tsx loader, the `yaml` npm package for YAML parsing.

**Reference spec:** `docs/superpowers/specs/2026-07-02-custom-rules-preview-dry-run-design.md`

## Global Constraints

- Node engine floor: `>=18` (from `package.json`).
- TypeScript config: `strict`, `noImplicitAny`, `isolatedModules`, `moduleResolution: bundler`, `target: ES2022`, `module: ESNext`. All imports must use the `.js` extension in specifiers (e.g. `./foo.js`) even though sources are `.ts`.
- Tests run via: `npm test` → `node --import tsx --test src/**/__tests__/*.test.ts`. Typecheck via `npm run typecheck` → `tsc --noEmit`. Build via `npm run build`.
- The plugin must never perform an HTTP call to any LLM provider. No `OCR_LLM_*` env vars, no API key handling. All model reasoning stays in the host Claude Code session.
- Error codes are prefixes embedded in thrown `Error.message`, e.g. `OCRP-RULES-090: ...`. The `prepare.ts` CLI maps any message matching `/OCRP-/` to exit code `2`, otherwise exit `1`.
- New fields added to existing interfaces MUST be optional (back-compat). No existing fields may be removed.
- Comments and docstrings follow the existing repo style: concise, mix of Chinese and English is acceptable (match surrounding file).
- Frequent commits: each task ends with a commit. Commit messages use conventional-commits style (`feat:`, `test:`, `chore:`, `docs:`).

---

## File Structure

New files:

- `src/core/rules/custom_rules.ts` — discover + load + parse + validate custom rule files (YAML/JSON). Produces `LoadedCustomRules`.
- `src/core/rules/__tests__/custom_rules.test.ts` — unit tests for the loader.
- `src/core/allowlist/__tests__/file_scope.test.ts` — unit tests for `isFileInScope`.

Modified files:

- `src/core/model/request.ts` — add optional `rulesPath`, `preview`, `dryRun` to `ReviewRequest`; add `rulesSource`, `excludedFiles`, `preview`, `dryRun` to `ReviewContext`.
- `src/core/rules/matcher.ts` — add `resolveRule(filePath, customRules)` + `RuleResolution`.
- `src/core/allowlist/allowed_ext.ts` — add `isFileInScope(filePath, customRules)` + `FileScopeReason`.
- `src/core/context/review_context.ts` — load custom rules, filter via `isFileInScope`, record `excludedFiles`, resolve rules custom-first, thread `preview`/`dryRun`/`rulesSource` into context.
- `src/cli/prepare.ts` — parse `--rules`/`--rule`/`--preview`/`-p`/`--dry-run`; emit extended summary; short-circuit artifact writes for preview.
- `src/cli/__tests__/prepare.test.ts` — replace P0 rejection tests with acceptance tests.
- `src/core/rules/__tests__/matcher.test.ts` — add `resolveRule` tests.
- `src/core/context/__tests__/review_context.test.ts` — add custom-rules + include/exclude tests.
- `commands/review.md` — short-circuit on `preview`/`dryRun`; read `message` when `docPath` missing.
- `scripts/smoke.sh` — add a dry-run section.
- `package.json` — add `yaml` dependency.
- `README.md` — document the new flags and `.code-review.yaml`.

---

## Task 1: Add `yaml` dependency and verify build

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json` (via npm)

**Interfaces:**
- Consumes: nothing.
- Produces: `yaml` package importable as `import YAML from 'yaml';` (default export with `.parse(string)` returning a JS object).

- [ ] **Step 1: Add the dependency**

Run:

```bash
npm install yaml@^2.5.0
```

Expected: `package.json` gains `"yaml": "^2.5.0"` under `dependencies`, and `package-lock.json` updates.

- [ ] **Step 2: Verify typecheck still passes**

Run: `npm run typecheck`
Expected: PASS (no output, exit 0).

- [ ] **Step 3: Verify build still passes**

Run: `npm run build`
Expected: build completes (`[shebang] done. processed 9 file(s).`).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add yaml dependency for custom rule parsing"
```

---

## Task 2: Extend `ReviewRequest` / `ReviewContext` types

**Files:**
- Modify: `src/core/model/request.ts:34-60`
- Test: (covered by compile + later tasks)

**Interfaces:**
- Consumes: nothing.
- Produces: `ReviewRequest.rulesPath?: string`, `ReviewRequest.preview?: boolean`, `ReviewRequest.dryRun?: boolean`; `ReviewContext.rulesSource?: string`, `ReviewContext.excludedFiles?: Array<{ path: string; reason: string }>`, `ReviewContext.preview?: boolean`, `ReviewContext.dryRun?: boolean`.

- [ ] **Step 1: Add the optional fields to `ReviewRequest`**

In `src/core/model/request.ts`, the current `ReviewRequest` interface is:

```ts
export interface ReviewRequest {
  repoRoot: string;
  mode: ReviewMode;
  commit?: string;
  from?: string;
  to?: string;
  paths?: string[];
  background?: string;
  rulesPath?: string;
  dryRun?: boolean;
  format?: 'markdown' | 'json' | 'both';
  concurrency?: number;
  maxHunkLines?: number;
}
```

Replace it with:

```ts
export interface ReviewRequest {
  repoRoot: string;
  mode: ReviewMode;
  commit?: string;
  from?: string;
  to?: string;
  paths?: string[];
  background?: string;
  rulesPath?: string;
  preview?: boolean;
  dryRun?: boolean;
  format?: 'markdown' | 'json' | 'both';
  concurrency?: number;
  maxHunkLines?: number;
}
```

- [ ] **Step 2: Add the optional fields to `ReviewContext`**

The current `ReviewContext` interface is:

```ts
export interface ReviewContext {
  runId: string;
  repoRoot: string;
  range: string;
  background: string;
  files: FileChange[];
  changeFiles: string[];
  meta: {
    generatedAt: string;
    pluginVersion: string;
  };
}
```

Replace it with:

```ts
export interface ReviewContext {
  runId: string;
  repoRoot: string;
  range: string;
  background: string;
  files: FileChange[];
  changeFiles: string[];
  meta: {
    generatedAt: string;
    pluginVersion: string;
  };
  rulesSource?: string;
  excludedFiles?: Array<{ path: string; reason: string }>;
  preview?: boolean;
  dryRun?: boolean;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/core/model/request.ts
git commit -m "refactor(model): add optional custom-rules/preview/dry-run fields"
```

---

## Task 3: Custom rule loader (`custom_rules.ts`)

**Files:**
- Create: `src/core/rules/custom_rules.ts`
- Test: `src/core/rules/__tests__/custom_rules.test.ts`

**Interfaces:**
- Consumes: `globToRegExp` from `../allowlist/allowed_ext.js` (not used here, but `LoadedCustomRules` is consumed by Task 4 and Task 5). YAML via `import YAML from 'yaml'`.
- Produces:
  - `interface CustomRuleEntry { path: string; rule: string }`
  - `interface CustomRuleFile { rules?: CustomRuleEntry[]; include?: string[]; exclude?: string[] }`
  - `interface LoadedCustomRules { source: string; sourceKind: 'cli' | 'repo' | 'none'; rules: CustomRuleEntry[]; include: string[]; exclude: string[] }`
  - `function loadCustomRules(repoRoot: string, rulesPath?: string): Promise<LoadedCustomRules>`

- [ ] **Step 1: Write the failing test**

Create `src/core/rules/__tests__/custom_rules.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCustomRules } from '../custom_rules.js';

async function mkRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ocrp-rules-'));
}

test('loadCustomRules: CLI path wins over repo .code-review.yaml', async () => {
  const repo = await mkRepo();
  try {
    await writeFile(join(repo, '.code-review.yaml'), 'rules:\n  - path: "src/**"\n    rule: "repo rule"\n');
    await writeFile(join(repo, 'cli-rules.yaml'), 'rules:\n  - path: "**"\n    rule: "cli rule"\n');
    const r = await loadCustomRules(repo, 'cli-rules.yaml');
    assert.equal(r.sourceKind, 'cli');
    assert.equal(r.source, 'cli-rules.yaml');
    assert.equal(r.rules[0].rule, 'cli rule');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: repo discovery priority .yaml > .yml > .json', async () => {
  const repo = await mkRepo();
  try {
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, '.code-review.yml'), 'rules:\n  - path: "a"\n    rule: "yml"\n');
    await writeFile(join(repo, '.code-review.json'), JSON.stringify({ rules: [{ path: 'b', rule: 'json' }] }));
    const r = await loadCustomRules(repo);
    assert.equal(r.sourceKind, 'repo');
    assert.equal(r.source, '.code-review.yml');
    assert.equal(r.rules[0].rule, 'yml');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: no config returns sourceKind none and empty arrays', async () => {
  const repo = await mkRepo();
  try {
    const r = await loadCustomRules(repo);
    assert.equal(r.sourceKind, 'none');
    assert.equal(r.source, 'system');
    assert.deepEqual(r.rules, []);
    assert.deepEqual(r.include, []);
    assert.deepEqual(r.exclude, []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: JSON file parses include/exclude', async () => {
  const repo = await mkRepo();
  try {
    await writeFile(join(repo, '.code-review.json'), JSON.stringify({
      rules: [{ path: 'src/**/*.ts', rule: 'check types' }],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
    }));
    const r = await loadCustomRules(repo);
    assert.equal(r.sourceKind, 'repo');
    assert.deepEqual(r.include, ['src/**/*.ts']);
    assert.deepEqual(r.exclude, ['**/*.test.ts']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: missing CLI file throws OCRP-RULES-090', async () => {
  const repo = await mkRepo();
  try {
    await assert.rejects(loadCustomRules(repo, 'nope.yaml'), /OCRP-RULES-090/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: malformed YAML throws OCRP-RULES-091', async () => {
  const repo = await mkRepo();
  try {
    await writeFile(join(repo, '.code-review.yaml'), 'rules: [unterminated\n');
    await assert.rejects(loadCustomRules(repo), /OCRP-RULES-091/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: non-object root throws OCRP-RULES-092', async () => {
  const repo = await mkRepo();
  try {
    await writeFile(join(repo, '.code-review.json'), JSON.stringify(['not', 'an', 'object']));
    await assert.rejects(loadCustomRules(repo), /OCRP-RULES-092/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: rule entry missing path throws OCRP-RULES-093', async () => {
  const repo = await mkRepo();
  try {
    await writeFile(join(repo, '.code-review.json'), JSON.stringify({ rules: [{ rule: 'no path' }] }));
    await assert.rejects(loadCustomRules(repo), /OCRP-RULES-093/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: rule entry missing rule throws OCRP-RULES-093', async () => {
  const repo = await mkRepo();
  try {
    await writeFile(join(repo, '.code-review.json'), JSON.stringify({ rules: [{ path: '**' }] }));
    await assert.rejects(loadCustomRules(repo), /OCRP-RULES-093/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="loadCustomRules"`
Expected: FAIL — `Cannot find module '../custom_rules.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/core/rules/custom_rules.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
  sourceKind: 'cli' | 'repo' | 'none';
  rules: CustomRuleEntry[];
  include: string[];
  exclude: string[];
}

const REPO_CANDIDATES = ['.code-review.yaml', '.code-review.yml', '.code-review.json'] as const;

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

async function loadFile(absPath: string, sourceLabel: string, sourceKind: 'cli' | 'repo'): Promise<LoadedCustomRules> {
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

export async function loadCustomRules(repoRoot: string, rulesPath?: string): Promise<LoadedCustomRules> {
  if (rulesPath) {
    const abs = join(repoRoot, rulesPath);
    return loadFile(abs, rulesPath, 'cli');
  }
  for (const name of REPO_CANDIDATES) {
    const abs = join(repoRoot, name);
    if (await exists(abs)) {
      return loadFile(abs, name, 'repo');
    }
  }
  return { source: 'system', sourceKind: 'none', rules: [], include: [], exclude: [] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="loadCustomRules"`
Expected: PASS (9 tests).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/rules/custom_rules.ts src/core/rules/__tests__/custom_rules.test.ts
git commit -m "feat(rules): add custom rule loader for yaml/json"
```

---

## Task 4: `resolveRule` in matcher.ts (custom-first)

**Files:**
- Modify: `src/core/rules/matcher.ts:25-69`
- Test: `src/core/rules/__tests__/matcher.test.ts`

**Interfaces:**
- Consumes: `LoadedCustomRules` from `./custom_rules.js`, existing `buildSystemRulePrompt`/`matchRule`.
- Produces: `interface RuleResolution { ruleId: string; docPath?: string; text: string; source: 'custom' | 'system' }` and `function resolveRule(filePath: string, custom: LoadedCustomRules | null): RuleResolution`.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/rules/__tests__/matcher.test.ts` (after existing tests):

```ts
import { resolveRule } from '../matcher.js';
import type { LoadedCustomRules } from '../custom_rules.js';

function customRules(rules: Array<{ path: string; rule: string }>): LoadedCustomRules {
  return { source: '.code-review.yaml', sourceKind: 'repo', rules, include: [], exclude: [] };
}

test('resolveRule: custom first-match-wins', () => {
  const r = resolveRule('src/a.ts', customRules([
    { path: 'src/**/*.go', rule: 'go rule' },
    { path: 'src/**/*.ts', rule: 'ts rule' },
  ]));
  assert.equal(r.source, 'custom');
  assert.equal(r.text, 'ts rule');
  assert.equal(r.docPath, undefined);
  assert.ok(r.ruleId.startsWith('custom'));
});

test('resolveRule: custom miss falls back to system', () => {
  const r = resolveRule('src/a.ts', customRules([
    { path: 'src/**/*.go', rule: 'go rule' },
  ]));
  assert.equal(r.source, 'system');
  assert.equal(r.docPath, 'ts_js_tsx_jsx.md');
});

test('resolveRule: null custom uses system only', () => {
  const r = resolveRule('src/a.ts', null);
  assert.equal(r.source, 'system');
  assert.equal(r.docPath, 'ts_js_tsx_jsx.md');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="resolveRule"`
Expected: FAIL — `resolveRule is not a function`.

- [ ] **Step 3: Add `resolveRule` to matcher.ts**

In `src/core/rules/matcher.ts`, add the import at the top (after existing imports):

```ts
import type { LoadedCustomRules } from './custom_rules.js';
```

Add `globToRegExp` import if not already present (it is: `import { globToRegExp } from '../allowlist/allowed_ext.js';`). Then append at the end of the file:

```ts
export interface RuleResolution {
  ruleId: string;
  docPath?: string;
  text: string;
  source: 'custom' | 'system';
}

/**
 * 自定义规则优先，first-match-wins；未命中回退内置规则。
 * custom: docPath=undefined, text=rule 文本。
 * system: docPath=内置 doc 名, text=doc 文件内容。
 */
export function resolveRule(filePath: string, custom: LoadedCustomRules | null): RuleResolution {
  if (custom && custom.rules.length > 0) {
    for (const entry of custom.rules) {
      if (globToRegExp(entry.path).test(filePath)) {
        return {
          ruleId: `custom:${entry.path}`,
          docPath: undefined,
          text: entry.rule,
          source: 'custom',
        };
      }
    }
  }
  const sys = buildSystemRulePrompt(filePath);
  return { ruleId: sys.ruleId, docPath: sys.docPath, text: sys.text, source: 'system' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="resolveRule"`
Expected: PASS (3 tests).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/rules/matcher.ts src/core/rules/__tests__/matcher.test.ts
git commit -m "feat(rules): add resolveRule with custom-first matching"
```

---

## Task 5: `isFileInScope` in allowed_ext.ts

**Files:**
- Modify: `src/core/allowlist/allowed_ext.ts:78-86`
- Test: `src/core/allowlist/__tests__/file_scope.test.ts` (new)

**Interfaces:**
- Consumes: `LoadedCustomRules` from `../rules/custom_rules.js`, existing `loadSupportedExtensions`/`loadDefaultExcludes`/`globToRegExp`.
- Produces: `type FileScopeReason = 'unsupported-ext' | 'user-exclude' | 'not-in-include' | 'default-exclude' | 'ok'` and `function isFileInScope(filePath: string, custom: LoadedCustomRules | null): { allowed: boolean; reason: FileScopeReason }`.

- [ ] **Step 1: Write the failing test**

Create `src/core/allowlist/__tests__/file_scope.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFileInScope } from '../allowed_ext.js';
import type { LoadedCustomRules } from '../../rules/custom_rules.js';

function custom(opts: { include?: string[]; exclude?: string[] } = {}): LoadedCustomRules {
  return {
    source: '.code-review.yaml',
    sourceKind: 'repo',
    rules: [],
    include: opts.include ?? [],
    exclude: opts.exclude ?? [],
  };
}

test('isFileInScope: unsupported ext excluded', () => {
  const r = isFileInScope('src/foo.unknownext', null);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'unsupported-ext');
});

test('isFileInScope: user exclude wins over include', () => {
  const r = isFileInScope('src/foo.test.ts', custom({ include: ['src/**'], exclude: ['**/*.test.ts'] }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'user-exclude');
});

test('isFileInScope: include excludes non-matching files', () => {
  const r = isFileInScope('lib/foo.ts', custom({ include: ['src/**'] }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'not-in-include');
});

test('isFileInScope: include match skips default exclude', () => {
  // foo.test.ts would normally be default-excluded, but include match overrides.
  const r = isFileInScope('src/foo.test.ts', custom({ include: ['src/**/*.test.ts'] }));
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'ok');
});

test('isFileInScope: no include, default exclude applies', () => {
  const r = isFileInScope('src/foo.test.ts', null);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'default-exclude');
});

test('isFileInScope: normal ts file without config is ok', () => {
  const r = isFileInScope('src/foo.ts', null);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'ok');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="isFileInScope"`
Expected: FAIL — `isFileInScope is not a function`.

- [ ] **Step 3: Add `isFileInScope` to allowed_ext.ts**

In `src/core/allowlist/allowed_ext.ts`, add the import near the top:

```ts
import type { LoadedCustomRules } from '../rules/custom_rules.js';
```

Append at the end of the file:

```ts
export type FileScopeReason =
  | 'unsupported-ext'
  | 'user-exclude'
  | 'not-in-include'
  | 'default-exclude'
  | 'ok';

/**
 * 组合判断文件是否进入 review：
 * 1. 扩展名不在 supported list → excluded
 * 2. 命中用户 exclude → excluded
 * 3. 配置了 include 时，未命中 → excluded
 * 4. include 命中 → reviewed (跳过默认 exclude)
 * 5. 无 include 时命中默认 exclude → excluded
 * 6. 否则 reviewed
 */
export function isFileInScope(
  filePath: string,
  custom: LoadedCustomRules | null,
): { allowed: boolean; reason: FileScopeReason } {
  const ext = extname(filePath);
  const exts = loadSupportedExtensions();
  if (!exts.includes(ext)) return { allowed: false, reason: 'unsupported-ext' };

  const exclude = custom?.exclude ?? [];
  if (exclude.length > 0 && matchAny(filePath, exclude)) {
    return { allowed: false, reason: 'user-exclude' };
  }

  const include = custom?.include ?? [];
  if (include.length > 0) {
    if (!matchAny(filePath, include)) {
      return { allowed: false, reason: 'not-in-include' };
    }
    return { allowed: true, reason: 'ok' };
  }

  if (matchAny(filePath, loadDefaultExcludes())) {
    return { allowed: false, reason: 'default-exclude' };
  }

  return { allowed: true, reason: 'ok' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="isFileInScope"`
Expected: PASS (6 tests).

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/allowlist/allowed_ext.ts src/core/allowlist/__tests__/file_scope.test.ts
git commit -m "feat(allowlist): add isFileInScope with include/exclude"
```

---

## Task 6: Wire custom rules + filtering into `review_context.ts`

**Files:**
- Modify: `src/core/context/review_context.ts:9-59`
- Test: `src/core/context/__tests__/review_context.test.ts`

**Interfaces:**
- Consumes: `loadCustomRules` from `../rules/custom_rules.js`, `isFileInScope` from `../allowlist/allowed_ext.js`, `resolveRule` from `../rules/matcher.js`, `ReviewRequest`/`ReviewContext` from `../model/request.js`.
- Produces: `buildReviewContext(req)` now: loads custom rules, filters via `isFileInScope`, records `excludedFiles`, resolves rules custom-first, sets `rulesSource`/`preview`/`dryRun` on the returned context.

- [ ] **Step 1: Write the failing tests**

Append to `src/core/context/__tests__/review_context.test.ts` (do not add duplicate imports; the existing file already imports `writeFile` from `node:fs/promises` and `join` from `node:path`):

```ts
async function initRepo(repo: string): Promise<void> {
  await git(repo, ['init', '-q']);
  await git(repo, ['checkout', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
}

test('buildReviewContext applies .code-review.yaml rule text to rulesHit', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-ctx-'));
  try {
    await initRepo(repo);
    await writeFile(join(repo, '.code-review.yaml'),
      'rules:\n  - path: "**/*.ts"\n    rule: "custom rule text"\n');
    await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n');

    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace' });
    assert.equal(ctx.rulesSource, '.code-review.yaml');
    assert.equal(ctx.files[0].rulesHit[0].message, 'custom rule text');
    assert.equal(ctx.files[0].rulesHit[0].docPath, undefined);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('buildReviewContext records excludedFiles with reason for test file', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-ctx-'));
  try {
    await initRepo(repo);
    await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n');
    await writeFile(join(repo, 'a.test.ts'), 'export const t = 1;\n');

    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace' });
    const excluded = ctx.excludedFiles ?? [];
    assert.ok(excluded.some((e) => e.path.endsWith('a.test.ts') && e.reason === 'default-exclude'),
      'a.test.ts should be default-excluded');
    assert.ok(!ctx.changeFiles.some((p) => p.endsWith('a.test.ts')));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('buildReviewContext include limits scope and excluded reason is not-in-include', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-ctx-'));
  try {
    await initRepo(repo);
    await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n');
    await writeFile(join(repo, 'b.ts'), 'export const b = 2;\n');
    await writeFile(join(repo, '.code-review.yaml'),
      'include:\n  - "a.ts"\n');

    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace' });
    assert.deepEqual(ctx.changeFiles.sort(), ['a.ts']);
    assert.ok((ctx.excludedFiles ?? []).some((e) => e.path === 'b.ts' && e.reason === 'not-in-include'));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('buildReviewContext without config preserves system rule docPath', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-ctx-'));
  try {
    await initRepo(repo);
    await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n');

    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace' });
    assert.equal(ctx.rulesSource, 'system');
    assert.equal(ctx.files[0].rulesHit[0].docPath, 'ts_js_tsx_jsx.md');
    assert.equal(ctx.excludedFiles, undefined);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
```

Note: the existing `review_context.test.ts` already imports `writeFile` and `join`; do not add duplicate import declarations.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="buildReviewContext"`
Expected: FAIL — the new assertions fail (no `rulesSource`, no `excludedFiles`, custom rule text not applied).

- [ ] **Step 3: Update `review_context.ts`**

Replace the body of `buildReviewContext` in `src/core/context/review_context.ts`. The current implementation is:

```ts
import { gitRevParseToplevel, gitDiff } from '../diff/git.js';
import { collectWorkspaceDiff } from '../diff/workspace.js';
import { parseUnifiedDiff } from '../diff/parser.js';
import { isAllowed } from '../allowlist/allowed_ext.js';
import { buildSystemRulePrompt } from '../rules/matcher.js';
import { MAX_HUNK_LINES, PLUGIN_VERSION } from '../prompts/constants.js';
import { newRunId } from '../runs/store.js';
import type { ReviewRequest, ReviewContext, FileChange } from '../model/request.js';

export async function buildReviewContext(req: ReviewRequest): Promise<ReviewContext> {
  let repoRoot: string;
  try {
    repoRoot = await gitRevParseToplevel(req.repoRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`OCRP-RUN-010: Not a git repository at ${req.repoRoot}: ${msg}`);
  }

  let diffText: string;
  let rangeLabel: string;
  if (req.mode === 'workspace') {
    diffText = await collectWorkspaceDiff(repoRoot, req.paths);
    rangeLabel = 'workspace';
  } else if (req.mode === 'staged') {
    diffText = await gitDiff({ repoRoot, range: 'staged', paths: req.paths });
    rangeLabel = 'staged';
  } else if (req.mode === 'commit') {
    if (!req.commit) throw new Error('OCRP-RUN-011: --commit required when mode=commit');
    diffText = await gitDiff({ repoRoot, range: `commit:${req.commit}`, paths: req.paths });
    rangeLabel = `commit:${req.commit}`;
  } else {
    // range
    if (!req.from || !req.to) throw new Error('OCRP-RUN-011: --from and --to required when mode=range');
    diffText = await gitDiff({ repoRoot, range: `${req.from}..${req.to}`, paths: req.paths });
    rangeLabel = `${req.from}..${req.to}`;
  }

  const maxHunkLines = req.maxHunkLines ?? MAX_HUNK_LINES;
  let files: FileChange[] = parseUnifiedDiff(diffText, { maxHunkLines });

  // allowlist 过滤
  files = files.filter((f) => isAllowed(f.path));

  // 规则匹配
  for (const f of files) {
    const rule = buildSystemRulePrompt(f.path);
    f.rulesHit = [{ ruleId: rule.ruleId, message: '', docPath: rule.docPath }];
  }

  const runId = newRunId();
  return {
    runId,
    repoRoot,
    range: rangeLabel,
    background: req.background ?? '',
    files,
    changeFiles: files.map((f) => f.path),
    meta: { generatedAt: new Date().toISOString(), pluginVersion: PLUGIN_VERSION },
  };
}
```

Replace the whole file with:

```ts
import { gitRevParseToplevel, gitDiff } from '../diff/git.js';
import { collectWorkspaceDiff } from '../diff/workspace.js';
import { parseUnifiedDiff } from '../diff/parser.js';
import { isFileInScope } from '../allowlist/allowed_ext.js';
import { resolveRule } from '../rules/matcher.js';
import { loadCustomRules } from '../rules/custom_rules.js';
import { MAX_HUNK_LINES, PLUGIN_VERSION } from '../prompts/constants.js';
import { newRunId } from '../runs/store.js';
import type { ReviewRequest, ReviewContext, FileChange } from '../model/request.js';

export async function buildReviewContext(req: ReviewRequest): Promise<ReviewContext> {
  let repoRoot: string;
  try {
    repoRoot = await gitRevParseToplevel(req.repoRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`OCRP-RUN-010: Not a git repository at ${req.repoRoot}: ${msg}`);
  }

  const custom = await loadCustomRules(repoRoot, req.rulesPath);

  let diffText: string;
  let rangeLabel: string;
  if (req.mode === 'workspace') {
    diffText = await collectWorkspaceDiff(repoRoot, req.paths);
    rangeLabel = 'workspace';
  } else if (req.mode === 'staged') {
    diffText = await gitDiff({ repoRoot, range: 'staged', paths: req.paths });
    rangeLabel = 'staged';
  } else if (req.mode === 'commit') {
    if (!req.commit) throw new Error('OCRP-RUN-011: --commit required when mode=commit');
    diffText = await gitDiff({ repoRoot, range: `commit:${req.commit}`, paths: req.paths });
    rangeLabel = `commit:${req.commit}`;
  } else {
    // range
    if (!req.from || !req.to) throw new Error('OCRP-RUN-011: --from and --to required when mode=range');
    diffText = await gitDiff({ repoRoot, range: `${req.from}..${req.to}`, paths: req.paths });
    rangeLabel = `${req.from}..${req.to}`;
  }

  const maxHunkLines = req.maxHunkLines ?? MAX_HUNK_LINES;
  const parsed: FileChange[] = parseUnifiedDiff(diffText, { maxHunkLines });

  // scope 过滤：扩展名 + include/exclude + 默认排除
  const files: FileChange[] = [];
  const excludedFiles: Array<{ path: string; reason: string }> = [];
  for (const f of parsed) {
    const scope = isFileInScope(f.path, custom);
    if (scope.allowed) {
      files.push(f);
    } else {
      excludedFiles.push({ path: f.path, reason: scope.reason });
    }
  }

  // 规则匹配：自定义优先，内置回退
  for (const f of files) {
    const rule = resolveRule(f.path, custom);
    f.rulesHit = [{
      ruleId: rule.ruleId,
      message: rule.source === 'custom' ? rule.text : '',
      docPath: rule.docPath,
    }];
  }

  const runId = newRunId();
  const ctx: ReviewContext = {
    runId,
    repoRoot,
    range: rangeLabel,
    background: req.background ?? '',
    files,
    changeFiles: files.map((f) => f.path),
    meta: { generatedAt: new Date().toISOString(), pluginVersion: PLUGIN_VERSION },
    rulesSource: custom.source,
    excludedFiles: excludedFiles.length > 0 ? excludedFiles : undefined,
  };
  if (req.preview) ctx.preview = true;
  if (req.dryRun) ctx.dryRun = true;
  return ctx;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="buildReviewContext"`
Expected: PASS (all `buildReviewContext` tests, old and new).

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: PASS (no regressions).

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/context/review_context.ts src/core/context/__tests__/review_context.test.ts
git commit -m "feat(context): apply custom rules and scope filtering"
```

---

## Task 7: `prepare.ts` flags + summary + dry-run artifact

**Files:**
- Modify: `src/cli/prepare.ts`
- Modify: `src/cli/__tests__/prepare.test.ts`

**Interfaces:**
- Consumes: `buildReviewContext` (now rules-aware), `writeContext` from `../core/runs/store.js`, `ReviewRequest`/`ReviewContext`.
- Produces: `ocr-prepare` accepts `--rules`/`--rule`/`--preview`/`-p`/`--dry-run`; emits extended summary JSON; for `--dry-run` also writes `.ocr-runs/<runId>/preview.json`.

- [ ] **Step 1: Replace the P0 rejection tests**

The current `src/cli/__tests__/prepare.test.ts` contains two tests: `ocr-prepare rejects --rules in P0...` and `ocr-prepare rejects preview and dry-run flags in P0`. Replace the entire file contents with:

```ts
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

async function runPrepare(cwd: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX, join(ROOT, 'src/cli/prepare.ts'), ...args], {
    cwd,
  });
}

async function initGitRepo(repo: string): Promise<void> {
  const git = (args: string[]) => execFileAsync('git', args, { cwd: repo });
  await git(['init', '-q']);
  await git(['checkout', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'init']);
  await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n');
}

test('ocr-prepare accepts --rules and --rule alias', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await initGitRepo(repo);
    await writeFile(join(repo, 'custom.yaml'), 'rules:\n  - path: "**/*.ts"\n    rule: "x"\n');
    for (const flag of ['--rules', '--rule']) {
      const { stdout } = await runPrepare(repo, [flag, 'custom.yaml']);
      const j = JSON.parse(stdout);
      assert.equal(j.rulesSource, 'custom.yaml');
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare rejects missing --rules path with OCRP-RUN-011', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await assert.rejects(
      runPrepare(repo, ['--rules']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /OCRP-RUN-011/);
        return true;
      },
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare --preview returns preview:true and no contextPath', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await initGitRepo(repo);
    const { stdout } = await runPrepare(repo, ['--preview']);
    const j = JSON.parse(stdout);
    assert.equal(j.preview, true);
    assert.equal(j.contextPath, null);
    assert.ok(j.fileCount >= 1);
    assert.ok(Array.isArray(j.files));
    assert.ok(Array.isArray(j.excludedFiles));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare -p is an alias for --preview', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await initGitRepo(repo);
    const { stdout } = await runPrepare(repo, ['-p']);
    const j = JSON.parse(stdout);
    assert.equal(j.preview, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare --dry-run writes context.json and preview.json', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await initGitRepo(repo);
    const { stdout } = await runPrepare(repo, ['--dry-run']);
    const j = JSON.parse(stdout);
    assert.equal(j.dryRun, true);
    assert.ok(j.contextPath, 'contextPath should be set');
    assert.ok(j.previewPath, 'previewPath should be set');
    const ctx = await readFile(join(repo, j.contextPath), 'utf8');
    assert.ok(JSON.parse(ctx).files.length >= 1);
    const prev = await readFile(join(repo, j.previewPath), 'utf8');
    assert.equal(JSON.parse(prev).dryRun, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare rejects --preview --dry-run with OCRP-RUN-011', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await initGitRepo(repo);
    await assert.rejects(
      runPrepare(repo, ['--preview', '--dry-run']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /OCRP-RUN-011/);
        return true;
      },
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="ocr-prepare"`
Expected: FAIL — `--rules`/`--preview` still rejected.

- [ ] **Step 3: Rewrite `prepare.ts`**

Replace the entire contents of `src/cli/prepare.ts` with:

```ts
#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildReviewContext } from '../core/context/review_context.js';
import { writeContext, runDir } from '../core/runs/store.js';
import type { ReviewRequest } from '../core/model/request.js';
import type { ReviewMode } from '../core/types.js';
import type { LoadedCustomRules } from '../core/rules/custom_rules.js';

interface ParsedArgs {
  mode: ReviewMode;
  commit?: string;
  from?: string;
  to?: string;
  paths?: string[];
  background?: string;
  format?: 'markdown' | 'json' | 'both';
  concurrency?: number;
  rulesPath?: string;
  preview?: boolean;
  dryRun?: boolean;
  unsupported: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { mode: 'workspace', unsupported: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('-')) {
        throw new Error(`OCRP-RUN-011: ${a} requires a value`);
      }
      return v;
    };
    if (a === '--staged') out.mode = 'staged';
    else if (a === '--commit' || a === '-c') {
      out.mode = 'commit';
      out.commit = next();
    } else if (a === '--from') {
      out.mode = 'range';
      out.from = next();
    } else if (a === '--to') {
      out.mode = 'range';
      out.to = next();
    } else if (a === '--paths') out.paths = next().split(',');
    else if (a === '--background' || a === '-b') out.background = next();
    else if (a === '--rules' || a === '--rule') out.rulesPath = next();
    else if (a === '--format' || a === '-f') out.format = next() as ParsedArgs['format'];
    else if (a === '--concurrency') out.concurrency = parseInt(next(), 10);
    else if (a === '--preview' || a === '-p') out.preview = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (!a.startsWith('-')) {
      if (a === 'staged') out.mode = 'staged';
      else if (a === 'workspace') out.mode = 'workspace';
      else if (a.includes('..')) {
        out.mode = 'range';
        const [from, to] = a.split('..');
        out.from = from;
        out.to = to;
      } else {
        out.mode = 'commit';
        out.commit = a;
      }
    }
    i++;
  }
  return out;
}

function fileSummary(ctx: Awaited<ReturnType<typeof buildReviewContext>>) {
  return ctx.files.map((f) => ({
    path: f.path,
    status: f.status,
    hunkCount: f.hunks.length,
    changedLines: f.hunks.reduce((s, h) => s + h.lines.filter((l) => l.kind !== ' ').length, 0),
    ruleId: f.rulesHit[0]?.ruleId ?? '',
    ruleSource: f.rulesHit[0]?.docPath === undefined && (f.rulesHit[0]?.message ?? '') !== '' ? 'custom' : 'system',
  }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.unsupported.length > 0) {
    throw new Error(`OCRP-RUN-011: unsupported flag: ${args.unsupported.join('; ')}`);
  }
  if (args.preview && args.dryRun) {
    throw new Error('OCRP-RUN-011: --preview and --dry-run are mutually exclusive');
  }

  const req: ReviewRequest = {
    repoRoot: process.cwd(),
    mode: args.mode,
    commit: args.commit,
    from: args.from,
    to: args.to,
    paths: args.paths,
    background: args.background,
    rulesPath: args.rulesPath,
    preview: args.preview,
    dryRun: args.dryRun,
    format: args.format,
    concurrency: args.concurrency,
  };
  const ctx = await buildReviewContext(req);

  const hunkCount = ctx.files.reduce((s, f) => s + f.hunks.length, 0);
  const changedLines = ctx.files.reduce(
    (s, f) => s + f.hunks.reduce((ss, h) => ss + h.lines.filter((l) => l.kind !== ' ').length, 0),
    0,
  );
  const excludedFiles = ctx.excludedFiles ?? [];

  // preview: 不写 context.json，只输出 summary
  if (args.preview) {
    const summary = {
      runId: ctx.runId,
      preview: true,
      fileCount: ctx.files.length,
      excludedCount: excludedFiles.length,
      hunkCount,
      changedLines,
      contextPath: null,
      rulesSource: ctx.rulesSource,
      files: fileSummary(ctx),
      excludedFiles,
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    return;
  }

  // 正常 review 或 dry-run 都写 context.json
  await writeContext(ctx.runId, ctx);

  let previewPath: string | undefined;
  if (args.dryRun) {
    previewPath = `.ocr-runs/${ctx.runId}/preview.json`;
    const previewAbsPath = join(runDir(ctx.runId), 'preview.json');
    const preview = {
      runId: ctx.runId,
      dryRun: true,
      range: ctx.range,
      rulesSource: ctx.rulesSource,
      fileCount: ctx.files.length,
      excludedCount: excludedFiles.length,
      hunkCount,
      changedLines,
      files: fileSummary(ctx),
      excludedFiles,
    };
    await writeFile(previewAbsPath, JSON.stringify(preview, null, 2), 'utf8');
  }

  const summary = {
    runId: ctx.runId,
    preview: false,
    dryRun: args.dryRun ?? false,
    fileCount: ctx.files.length,
    excludedCount: excludedFiles.length,
    hunkCount,
    changedLines,
    contextPath: `.ocr-runs/${ctx.runId}/context.json`,
    previewPath,
    rulesSource: ctx.rulesSource,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch((err) => {
  const code = (err && err.message && /OCRP-/.test(err.message)) ? 2 : 1;
  process.stderr.write(`[ocr-prepare] ${err?.message ?? err}\n`);
  process.exit(code);
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --test-name-pattern="ocr-prepare"`
Expected: PASS (6 tests).

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: PASS (no regressions).

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/prepare.ts src/cli/__tests__/prepare.test.ts
git commit -m "feat(prepare): support --rules/--preview/--dry-run"
```

---

## Task 8: `commands/review.md` short-circuit + custom rule injection

**Files:**
- Modify: `commands/review.md`

**Interfaces:**
- Consumes: the extended `ocr-prepare` stdout summary (now includes `preview`/`dryRun`/`files`/`excludedFiles`).
- Produces: the `/review` command short-circuits when `preview` or `dryRun` is true; reviewer dispatch reads `message` when `docPath` is absent.

- [ ] **Step 1: Add the short-circuit section after Step 1**

In `commands/review.md`, the file currently has `### Step 1 — Prepare` then `### Step 2 — Plan`. Insert a new section between the prepare capture and Step 2.

Find this text (the end of Step 1):

```markdown
If `fileCount` is 0 → tell the user "No changes to review." and stop. This is a successful skipped review, not a hard failure.
If the command exits non-zero → surface the stderr to the user and stop.
```

Immediately after it, insert:

```markdown
### Step 1.5 — Preview / dry-run short-circuit

Parse the `ocr-prepare` stdout JSON.

- If `preview == true`:
  - Do NOT run plan, reviewer, filter, relocation, or aggregate.
  - Present a summary to the user:
    - review range
    - rules source (`rulesSource`)
    - file count / excluded count / hunk count / changed lines
    - the `files[]` list (path, status, hunkCount, changedLines, ruleId, ruleSource)
    - the `excludedFiles[]` list (path, reason)
  - Stop. No artifacts are written.
- If `dryRun == true`:
  - Do NOT run plan, reviewer, filter, relocation, or aggregate.
  - Tell the user the artifacts were written and where:
    - `<repo>/.ocr-runs/<runId>/context.json`
    - `<repo>/.ocr-runs/<runId>/preview.json`
  - Present the same `files[]` / `excludedFiles[]` summary as preview.
  - Stop.
- Otherwise continue to Step 2.
```

- [ ] **Step 2: Update reviewer dispatch to handle custom rule text**

In `commands/review.md`, Step 3 currently instructs the reviewer prompt to include:

```text
systemRule:
<contents of assets/rule_docs/<rulesHit[0].docPath> verbatim>
```

Replace that line within the Step 3 reviewer prompt template with instructions that handle both cases. Find the block:

```text
systemRule:
<contents of assets/rule_docs/<rulesHit[0].docPath> verbatim>
planGuidance:
<planGuidance string or "">
```

Replace with:

```text
systemRule:
<If `rulesHit[0].docPath` is present: read `assets/rule_docs/<docPath>` verbatim.
 If `docPath` is absent but `rulesHit[0].message` is non-empty: use that message text verbatim.
 Otherwise: read `assets/rule_docs/default.md` verbatim.>
planGuidance:
<planGuidance string or "">
```

- [ ] **Step 3: Update the error-handling table**

In the `## Error handling` table, add rows after the existing `OCRP-RUN-011` rows:

```markdown
| OCRP-RULES-090 | Custom rule file missing/unreadable. Fix the `--rules` path or `.code-review.yaml`. |
| OCRP-RULES-091 | Rule file JSON/YAML parse failure. Fix the syntax. |
| OCRP-RULES-092 | Rule file root is not an object. |
| OCRP-RULES-093 | A rule entry or include/exclude field is invalid. |
```

- [ ] **Step 4: Verify the command file is well-formed**

Run: `node -e "const fs=require('fs');const s=fs.readFileSync('commands/review.md','utf8');if(!s.includes('Step 1.5')||!s.includes('OCRP-RULES-090')){process.exit(1)}console.log('ok')"`
Expected: prints `ok`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add commands/review.md
git commit -m "docs(command): short-circuit preview/dry-run and custom rule injection"
```

---

## Task 9: Smoke test dry-run section

**Files:**
- Modify: `scripts/smoke.sh`

**Interfaces:**
- Consumes: the built `bin/ocr-prepare --dry-run`.
- Produces: `npm run smoke` also exercises a `.code-review.yaml` + `--dry-run` flow.

- [ ] **Step 1: Add a dry-run section to smoke.sh**

In `scripts/smoke.sh`, find the final lines:

```bash
# rules_check 冒烟
RC="$($PLUGIN_ROOT/bin/ocr-rules-check a.ts)"
echo "[smoke] rules-check: $RC"
echo "$RC" | grep -q '"docPath": "ts_js_tsx_jsx.md"' || { echo "[smoke] FAIL: rules-check docPath"; exit 1; }

echo "[smoke] PASS"
```

Replace with:

```bash
# rules_check 冒烟
RC="$($PLUGIN_ROOT/bin/ocr-rules-check a.ts)"
echo "[smoke] rules-check: $RC"
echo "$RC" | grep -q '"docPath": "ts_js_tsx_jsx.md"' || { echo "[smoke] FAIL: rules-check docPath"; exit 1; }

# --- Test 3: custom rules + dry-run (no LLM, no subagents) ---
echo ""
echo "=== Test 3: custom rules + dry-run ==="

cat > .code-review.yaml <<'YAML'
rules:
  - path: "**/*.ts"
    rule: "Focus on type safety."
include:
  - "**/*.ts"
YAML

DRY="$($PLUGIN_ROOT/bin/ocr-prepare --dry-run)"
echo "[smoke] dry-run: $DRY"
echo "$DRY" | grep -q '"dryRun": true' || { echo "[smoke] FAIL: dryRun not true"; exit 1; }
echo "$DRY" | grep -q '"rulesSource": ".code-review.yaml"' || { echo "[smoke] FAIL: rulesSource"; exit 1; }
DRY_RUNID="$(echo "$DRY" | grep -o '"runId": "[^"]*"' | head -1 | cut -d'"' -f4)"
if [ -z "$DRY_RUNID" ]; then echo "[smoke] FAIL: no dry-run runId"; exit 1; fi
if [ ! -f ".ocr-runs/$DRY_RUNID/context.json" ]; then echo "[smoke] FAIL: dry-run context.json missing"; exit 1; fi
if [ ! -f ".ocr-runs/$DRY_RUNID/preview.json" ]; then echo "[smoke] FAIL: dry-run preview.json missing"; exit 1; fi
echo "PASS: dry-run wrote context.json + preview.json"

# preview must NOT write context.json
PREV="$($PLUGIN_ROOT/bin/ocr-prepare --preview)"
echo "[smoke] preview: $PREV"
echo "$PREV" | grep -q '"preview": true' || { echo "[smoke] FAIL: preview not true"; exit 1; }
echo "$PREV" | grep -q '"contextPath": null' || { echo "[smoke] FAIL: preview contextPath not null"; exit 1; }
echo "PASS: preview did not write context.json"

echo "[smoke] PASS"
```

- [ ] **Step 2: Build and run the smoke test**

Run:

```bash
npm run build
npm run smoke
```

Expected: prints `PASS: dry-run wrote context.json + preview.json`, `PASS: preview did not write context.json`, and `[smoke] PASS`; exit 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/smoke.sh
git commit -m "test(smoke): cover custom rules and dry-run/preview"
```

---

## Task 10: README documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the implemented flags.
- Produces: documented user-facing behavior for `.code-review.yaml`, `--rules`, `--preview`, `--dry-run`.

- [ ] **Step 1: Add a new section after Section 6 (Configuration)**

In `README.md`, find Section 6 `## 6. Configuration` which currently ends with:

```markdown
P1 (planned): `.code-review.yaml` at repo root, falling back to
`~/.code-review/rules.yaml`, falling back to built-in.
```

Replace that P1 line and append a new section. Change the block to:

```markdown
### Custom rules

Place a `.code-review.yaml` (or `.code-review.yml`, or `.code-review.json`) at
your repo root. The first existing file wins; rules, `include`, and `exclude`
are not merged across files.

```yaml
rules:
  - path: "src/**/*.ts"
    rule: "Focus on type safety, async error handling, and boundary conditions."
include:
  - "src/**/*.ts"
exclude:
  - "**/*.test.ts"
```

- `rules[].path` supports `**` / `*` / `?` / `{a,b}` globs; first match wins.
- `include` / `exclude` control which changed files enter the review scope. When `include` is set, only matching files are reviewed and default excludes (test files, etc.) are skipped for them.
- When no custom rule matches a file, the built-in `system_rules.json` + `rule_docs/` apply.

Override or point at a one-off rule file with `--rules <path>` (alias `--rule <path>`):

```
/open-code-review:review --rules ./ci-rules.yaml
```

Rule file errors are hard failures (`OCRP-RULES-090`…`093`) — they do not silently fall back to defaults.

## 7. Preview and dry-run

Inspect what would be reviewed without invoking Claude Code subagents.

- `--preview` (alias `-p`): prints which files would be reviewed, their rule source, and which files are excluded and why. Writes no artifacts.
- `--dry-run`: same no-LLM preparation, but writes `.ocr-runs/<runId>/context.json` and `.ocr-runs/<runId>/preview.json` for CI and scripting.

```
/open-code-review:review --preview
/open-code-review:review --dry-run
```

`--preview` and `--dry-run` are mutually exclusive. Neither runs plan, reviewer, filter, relocation, or aggregate.
```

- [ ] **Step 2: Update the comparison / flag tables**

In `README.md` Section 3, the flag table row for P1 flags currently says (around line 51):

```markdown
P1 planned flags are parsed defensively but rejected in P0 with `OCRP-RUN-011`: `--rules`, `--preview` / `-p`, and `--dry-run`. This prevents silent false support until custom rules and preview mode are implemented.
```

Replace that paragraph with:

```markdown
`--rules <path>` (alias `--rule`), `--preview` / `-p`, and `--dry-run` are supported. See §6 (Custom rules) and §7 (Preview and dry-run).
```

- [ ] **Step 3: Renumber the subsequent section headers if needed**

Because the new "Preview and dry-run" was inserted as `## 7.`, check that the following sections (`## 7. Troubleshooting`, `## 8. Development`, `## 9. License`) are renumbered to `## 8.`, `## 9.`, `## 10.` respectively. Update both the headers and the directory-contract reference if it points at a section number.

Run: `grep -n '^## [0-9]' README.md`
Expected: consecutive numbering with no duplicates.

- [ ] **Step 4: Verify the README renders sensibly**

Run: `grep -n 'Preview and dry-run\|Custom rules\|OCRP-RULES-090' README.md`
Expected: matches found.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(readme): document custom rules, preview, and dry-run"
```

---

## Task 11: Full build, test, and final verification

**Files:**
- None (verification only)

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a green build + test + smoke + typecheck.

- [ ] **Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no output, exit 0).

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all tests PASS (the original 20 plus the new ones; no failures).

- [ ] **Step 3: Run the build**

Run: `npm run build`
Expected: build completes; `[build-mjs] done. converted 38 file(s).` (the count may be higher after new files) and `[shebang] done. processed 9 file(s).`.

- [ ] **Step 4: Run the smoke test**

Run: `npm run smoke`
Expected: `[smoke] PASS`, including the new Test 3 lines.

- [ ] **Step 5: Verify no LLM provider code was introduced**

Run: `rg -n "OCR_LLM_|api.anthropic.com|api.openai.com|x-api-key|fetch\(" src/`
Expected: no matches (empty output). The plugin still delegates all model calls to the host.

- [ ] **Step 6: Final commit if anything is uncommitted**

Run: `git status --short`
Expected: clean (no uncommitted changes). If anything remains, commit it with an appropriate message.

```bash
git add -A
git commit -m "chore: finalize custom rules, preview, dry-run"
```
