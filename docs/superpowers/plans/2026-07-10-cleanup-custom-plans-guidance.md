# Cleanup and Custom Plans Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean local repository state and add custom markdown plans guidance that is loaded during prepare and merged into per-file `ocr-plan-guidance` output.

**Architecture:** Cleanup is a one-time local maintenance task with conservative deletion rules. Custom plans guidance follows the existing custom rules pattern: a focused loader resolves CLI/repo/user markdown sources, `ReviewContext` stores the resolved source/text, and `ocr-plan-guidance` combines stored custom guidance with existing `plan.json` guidance without changing the LLM PLAN schema.

**Tech Stack:** TypeScript ES modules, Node.js >=18, native `node:test`, `tsx`, git CLI.

## Global Constraints

- Node.js >=18.
- TypeScript source uses ESM imports/exports and `.js` import specifiers.
- Do not add external npm dependencies.
- Use TDD for product code changes: write a failing test, observe it fail, implement the minimal fix, observe it pass.
- Do not force-delete locked or dirty worktrees.
- Preserve `bin/` and `dist/`; remove only `.ocr-runs/` as runtime cleanup.
- Normalize remotes to `origin=https://github.com/xjtulixiangyang/open_code_review_plugin.git`.
- Custom plans guidance is plain markdown only; no YAML DSL or path-specific parsing in this iteration.

---

## File Structure

Cleanup-only commands do not create product files.

Product changes:

- Create: `src/core/plans/custom_plans.ts` — resolves and loads CLI/repo/user custom plans markdown.
- Create: `src/core/plans/__tests__/custom_plans.test.ts` — loader priority and error behavior tests.
- Modify: `src/core/model/request.ts` — add `plansPath`, `plansGuidanceSource`, `plansGuidanceText` fields.
- Modify: `src/cli/prepare.ts` — parse `--plans`, pass it into `ReviewRequest`, include `plansGuidanceSource` in summary.
- Modify: `src/core/context/review_context.ts` — load custom plans and store source/text in `ReviewContext`.
- Modify: `src/core/prompts/plan_guidance.ts` — add pure `combinePlanGuidance()` helper.
- Modify: `src/cli/plan_guidance.ts` — read context, combine plan guidance with custom plans guidance, emit new flags.
- Modify: `src/cli/__tests__/prepare.test.ts` — CLI prepare integration coverage for `--plans`.
- Modify: `src/cli/__tests__/plan_guidance.test.ts` — CLI coverage for custom-only and combined guidance.
- Modify: `src/core/prompts/__tests__/plan_guidance.test.ts` — pure helper tests.
- Modify: `commands/review.md` and `commands/review-opencode.md` — document custom plans guidance in orchestration.
- Modify: `README.md` — document custom plans usage and error code.

---

### Task 1: Conservative Local Cleanup

**Files:**
- No product source files.
- Local git config and ignored runtime directories only.

**Interfaces:**
- Consumes: current repository state.
- Produces: cleaner local worktree/remotes/artifacts with no committed product changes.

- [ ] **Step 1: Confirm clean main before cleanup**

Run:

```bash
git status --short
git branch --show-current
```

Expected:

- Empty `git status --short` output.
- Branch is `main`.

- [ ] **Step 2: Save worktree inventory for audit**

Run:

```bash
git worktree list --porcelain > /tmp/ocr-worktrees-before.txt
```

Expected: `/tmp/ocr-worktrees-before.txt` contains registered worktrees.

- [ ] **Step 3: Remove eligible clean, unlocked `.claude/worktrees` worktrees**

Run this script from repo root:

```bash
python3 - <<'PY'
import subprocess
from pathlib import Path

root = Path.cwd().resolve()
text = subprocess.check_output(['git', 'worktree', 'list', '--porcelain'], text=True)
entries = []
cur = {}
for line in text.splitlines():
    if not line:
        if cur:
            entries.append(cur)
            cur = {}
        continue
    if line.startswith('worktree '):
        cur['path'] = line[len('worktree '):]
    elif line.startswith('branch '):
        cur['branch'] = line[len('branch refs/heads/'):]
    elif line.startswith('locked'):
        cur['locked'] = True
if cur:
    entries.append(cur)

removed = []
skipped = []
for e in entries:
    p = Path(e.get('path', '')).resolve()
    b = e.get('branch', '')
    if p == root:
        continue
    if root / '.claude' / 'worktrees' not in p.parents:
        skipped.append((str(p), b, 'outside .claude/worktrees'))
        continue
    if e.get('locked'):
        skipped.append((str(p), b, 'locked'))
        continue
    if not (b.startswith('worktree-agent-') or b in {'ocr-context-tools', 'review-partial-ref-fix'}):
        skipped.append((str(p), b, 'branch not eligible'))
        continue
    status = subprocess.check_output(['git', '-C', str(p), 'status', '--short'], text=True)
    if status.strip():
        skipped.append((str(p), b, 'dirty'))
        continue
    subprocess.check_call(['git', 'worktree', 'remove', str(p)])
    removed.append((str(p), b))

subprocess.check_call(['git', 'worktree', 'prune'])

print('REMOVED')
for p, b in removed:
    print(f'{b} {p}')
print('SKIPPED')
for p, b, reason in skipped:
    print(f'{b} {p} ({reason})')
PY
```

Expected:

- Worktrees listed under `REMOVED` are deleted.
- Locked or dirty worktrees are listed under `SKIPPED`.
- Script exits 0.

- [ ] **Step 4: Delete local branches for removed worktrees when safe**

Run:

```bash
for b in $(git branch --format='%(refname:short)' | grep -E '^(worktree-agent-|ocr-context-tools$|review-partial-ref-fix$)' || true); do
  if git worktree list --porcelain | grep -q "branch refs/heads/${b}$"; then
    echo "skip checked-out branch $b"
  else
    git branch -d "$b" || echo "skip unmerged branch $b"
  fi
done
```

Expected:

- Branches no longer associated with worktrees are deleted if merged.
- Unmerged branches are skipped, not force-deleted.

- [ ] **Step 5: Normalize remotes**

Run:

```bash
git remote set-url origin https://github.com/xjtulixiangyang/open_code_review_plugin.git
if git remote get-url github >/dev/null 2>&1; then git remote remove github; fi
if git remote get-url target >/dev/null 2>&1; then git remote remove target; fi
git fetch --prune origin
git branch --set-upstream-to=origin/main main
```

Expected:

- `origin` points to GitHub.
- `github` and `target` are removed.
- `main` tracks `origin/main`.

- [ ] **Step 6: Remove only `.ocr-runs/`**

Run:

```bash
rm -rf .ocr-runs
```

Expected:

- `.ocr-runs/` no longer exists.
- `bin/` and `dist/` still exist.

- [ ] **Step 7: Verify cleanup state**

Run:

```bash
git status --short
git remote -v
git branch -vv
test -d bin && test -d dist && test ! -e .ocr-runs
```

Expected:

- No product source changes from cleanup.
- Only `origin` remote remains and points to GitHub.
- `main` tracks `origin/main`.
- `bin/` and `dist/` exist; `.ocr-runs/` does not.

---

### Task 2: Add Custom Plans Loader

**Files:**
- Create: `src/core/plans/custom_plans.ts`
- Create: `src/core/plans/__tests__/custom_plans.test.ts`

**Interfaces:**
- Consumes: `repoRoot: string`, optional CLI path, optional `homeDir` test override.
- Produces:
  - `LoadedPlansGuidance`
  - `LoadPlansGuidanceOptions`
  - `loadPlansGuidance(repoRoot: string, plansPath?: string, opts?: LoadPlansGuidanceOptions): Promise<LoadedPlansGuidance>`

- [ ] **Step 1: Write failing loader tests**

Create `src/core/plans/__tests__/custom_plans.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlansGuidance } from '../custom_plans.js';

test('loadPlansGuidance: CLI path wins over repo and user defaults', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-plans-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'ocrp-plans-home-'));
  try {
    await mkdir(join(home, '.code-review'), { recursive: true });
    await writeFile(join(repo, '.code-review-plans.md'), 'repo guidance');
    await writeFile(join(home, '.code-review', 'plans.md'), 'user guidance');
    await writeFile(join(repo, 'custom-plans.md'), 'cli guidance');

    const loaded = await loadPlansGuidance(repo, 'custom-plans.md', { homeDir: home });

    assert.equal(loaded.sourceKind, 'cli');
    assert.equal(loaded.source, 'custom-plans.md');
    assert.equal(loaded.text, 'cli guidance');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('loadPlansGuidance: repo default wins over user default', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-plans-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'ocrp-plans-home-'));
  try {
    await mkdir(join(home, '.code-review'), { recursive: true });
    await writeFile(join(repo, '.code-review-plans.md'), 'repo guidance');
    await writeFile(join(home, '.code-review', 'plans.md'), 'user guidance');

    const loaded = await loadPlansGuidance(repo, undefined, { homeDir: home });

    assert.equal(loaded.sourceKind, 'repo');
    assert.equal(loaded.source, '.code-review-plans.md');
    assert.equal(loaded.text, 'repo guidance');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('loadPlansGuidance: user default is used when repo has none', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-plans-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'ocrp-plans-home-'));
  try {
    await mkdir(join(home, '.code-review'), { recursive: true });
    await writeFile(join(home, '.code-review', 'plans.md'), 'user guidance');

    const loaded = await loadPlansGuidance(repo, undefined, { homeDir: home });

    assert.equal(loaded.sourceKind, 'user');
    assert.equal(loaded.source, '~/.code-review/plans.md');
    assert.equal(loaded.text, 'user guidance');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('loadPlansGuidance: no files returns none', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-plans-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'ocrp-plans-home-'));
  try {
    const loaded = await loadPlansGuidance(repo, undefined, { homeDir: home });

    assert.deepEqual(loaded, { sourceKind: 'none', text: '' });
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('loadPlansGuidance: missing CLI path throws OCRP-PLANS-100', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-plans-repo-'));
  try {
    await assert.rejects(
      () => loadPlansGuidance(repo, 'missing.md'),
      /OCRP-PLANS-100: cannot read plans file missing\.md/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run loader tests to verify RED**

Run:

```bash
node --import tsx --test src/core/plans/__tests__/custom_plans.test.ts
```

Expected: FAIL with module not found for `../custom_plans.js`.

- [ ] **Step 3: Implement loader**

Create `src/core/plans/custom_plans.ts`:

```ts
import { readFile, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

export interface LoadedPlansGuidance {
  sourceKind: 'cli' | 'repo' | 'user' | 'none';
  source?: string;
  text: string;
}

export interface LoadPlansGuidanceOptions {
  homeDir?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function readPlansFile(
  absPath: string,
  source: string,
  sourceKind: 'cli' | 'repo' | 'user',
): Promise<LoadedPlansGuidance> {
  let text: string;
  try {
    text = await readFile(absPath, 'utf8');
  } catch (err) {
    throw new Error(`OCRP-PLANS-100: cannot read plans file ${source}: ${(err as Error).message}`);
  }
  return { sourceKind, source, text };
}

export async function loadPlansGuidance(
  repoRoot: string,
  plansPath?: string,
  opts: LoadPlansGuidanceOptions = {},
): Promise<LoadedPlansGuidance> {
  if (plansPath) {
    const abs = isAbsolute(plansPath) ? plansPath : join(repoRoot, plansPath);
    return readPlansFile(abs, plansPath, 'cli');
  }

  const repoDefault = join(repoRoot, '.code-review-plans.md');
  if (await exists(repoDefault)) {
    return readPlansFile(repoDefault, '.code-review-plans.md', 'repo');
  }

  const home = opts.homeDir ?? homedir();
  const userDefault = join(home, '.code-review', 'plans.md');
  if (await exists(userDefault)) {
    return readPlansFile(userDefault, '~/.code-review/plans.md', 'user');
  }

  return { sourceKind: 'none', text: '' };
}
```

- [ ] **Step 4: Run loader tests to verify GREEN**

Run:

```bash
node --import tsx --test src/core/plans/__tests__/custom_plans.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit loader**

Run:

```bash
git add src/core/plans/custom_plans.ts src/core/plans/__tests__/custom_plans.test.ts
git commit -m "feat(plans): load custom markdown plan guidance

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Thread Plans Guidance Through Prepare Context

**Files:**
- Modify: `src/core/model/request.ts`
- Modify: `src/cli/prepare.ts`
- Modify: `src/core/context/review_context.ts`
- Modify: `src/cli/__tests__/prepare.test.ts`

**Interfaces:**
- Consumes: `loadPlansGuidance(repoRoot, plansPath)` from Task 2.
- Produces:
  - `ReviewRequest.plansPath?: string`
  - `ReviewContext.plansGuidanceSource?: string`
  - `ReviewContext.plansGuidanceText?: string`
  - `ParsedArgs.plansPath?: string`
  - prepare summary field `plansGuidanceSource?: string`

- [ ] **Step 1: Add failing parseArgs test**

Modify `src/cli/__tests__/prepare.test.ts`. Add this import near existing imports if missing:

```ts
import { parseArgs } from '../prepare.js';
```

Then append this test:

```ts
test('parseArgs accepts --plans and stores plansPath', () => {
  const args = parseArgs(['--plans', 'review-plans.md']);
  assert.equal(args.plansPath, 'review-plans.md');
});
```

- [ ] **Step 2: Run parseArgs test to verify RED**

Run:

```bash
node --import tsx --test src/cli/__tests__/prepare.test.ts
```

Expected: FAIL because `plansPath` is undefined or typecheck fails after import adjustment.

- [ ] **Step 3: Add failing prepare integration test**

Append to `src/cli/__tests__/prepare.test.ts`:

```ts
test('ocr-prepare --plans writes custom plans guidance into context and summary', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo });
    await writeFile(join(repo, 'plans.md'), 'custom plan guidance');

    const { stdout } = await runPrepare(repo, ['--plans', 'plans.md']);
    const summary = JSON.parse(stdout);
    assert.equal(summary.plansGuidanceSource, 'plans.md');

    const contextPath = join(repo, summary.contextPath);
    const ctx = JSON.parse(await readFile(contextPath, 'utf8'));
    assert.equal(ctx.plansGuidanceSource, 'plans.md');
    assert.equal(ctx.plansGuidanceText, 'custom plan guidance');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run prepare integration test to verify RED**

Run:

```bash
node --import tsx --test src/cli/__tests__/prepare.test.ts
```

Expected: FAIL because `--plans` is not parsed and context lacks guidance fields.

- [ ] **Step 5: Extend request model**

Modify `src/core/model/request.ts`:

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
  plansPath?: string;
  preview?: boolean;
  dryRun?: boolean;
  resumeRunId?: string;
  format?: 'markdown' | 'json' | 'both';
  concurrency?: number;
  maxHunkLines?: number;
}
```

Also modify `ReviewContext`:

```ts
export interface ReviewContext {
  runId: string;
  repoRoot: string;
  range: string;
  background: string;
  files: FileChange[];
  changeFiles: string[];
  rulesSource?: string;
  plansGuidanceSource?: string;
  plansGuidanceText?: string;
  excludedFiles?: Array<{ path: string; reason: string }>;
  preview?: boolean;
  dryRun?: boolean;
  resumed?: boolean;
  remainingFileCount?: number;
  meta: {
    generatedAt: string;
    pluginVersion: string;
  };
}
```

- [ ] **Step 6: Parse `--plans` and pass into request**

Modify `src/cli/prepare.ts`:

In `ParsedArgs`, add:

```ts
plansPath?: string;
```

In `parseArgs`, after rules parsing, add:

```ts
else if (a === '--plans') {
  out.plansPath = next();
}
```

In `req`, add:

```ts
plansPath: args.plansPath,
```

In `summary`, add after `rulesSource`:

```ts
plansGuidanceSource: ctx.plansGuidanceSource,
```

- [ ] **Step 7: Load plans in context builder**

Modify `src/core/context/review_context.ts`:

Add import:

```ts
import { loadPlansGuidance } from '../plans/custom_plans.js';
```

After custom rules load, add:

```ts
const plansGuidance = await loadPlansGuidance(repoRoot, req.plansPath);
```

In returned context object, add after `rulesSource`:

```ts
plansGuidanceSource: plansGuidance.source,
plansGuidanceText: plansGuidance.text,
```

- [ ] **Step 8: Run prepare tests to verify GREEN**

Run:

```bash
node --import tsx --test src/cli/__tests__/prepare.test.ts src/cli/__tests__/prepare_args.test.ts
```

Expected: PASS.

- [ ] **Step 9: Run typecheck**

Run:

```bash
npx tsc --noEmit
```

Expected: PASS with no output.

- [ ] **Step 10: Commit prepare/context integration**

Run:

```bash
git add src/core/model/request.ts src/cli/prepare.ts src/core/context/review_context.ts src/cli/__tests__/prepare.test.ts
git commit -m "feat(plans): store custom guidance in review context

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Merge Custom Plans Into Plan Guidance Output

**Files:**
- Modify: `src/core/prompts/plan_guidance.ts`
- Modify: `src/core/prompts/__tests__/plan_guidance.test.ts`
- Modify: `src/cli/plan_guidance.ts`
- Modify: `src/cli/__tests__/plan_guidance.test.ts`

**Interfaces:**
- Consumes: `ReviewContext.plansGuidanceText` from Task 3.
- Produces:
  - `combinePlanGuidance(planGuidance: string, customPlansText: string): string`
  - CLI JSON `{ path: string; guidance: string; hasPlan: boolean; hasCustomPlans: boolean }`

- [ ] **Step 1: Add failing pure helper tests**

Append to `src/core/prompts/__tests__/plan_guidance.test.ts`:

```ts
import { combinePlanGuidance } from '../plan_guidance.js';

test('combinePlanGuidance returns empty string when both inputs are empty', () => {
  assert.equal(combinePlanGuidance('', ''), '');
});

test('combinePlanGuidance returns custom section when only custom plans exist', () => {
  const g = combinePlanGuidance('', 'custom guidance');
  assert.match(g, /Custom plans guidance:/);
  assert.match(g, /custom guidance/);
  assert.doesNotMatch(g, /PLAN guidance:/);
});

test('combinePlanGuidance combines plan and custom sections', () => {
  const g = combinePlanGuidance('plan guidance', 'custom guidance');
  assert.match(g, /PLAN guidance:/);
  assert.match(g, /plan guidance/);
  assert.match(g, /Custom plans guidance:/);
  assert.match(g, /custom guidance/);
});
```

If the file already imports `planOutputToGuidance`, change the import to:

```ts
import { planOutputToGuidance, combinePlanGuidance } from '../plan_guidance.js';
```

- [ ] **Step 2: Run pure helper tests to verify RED**

Run:

```bash
node --import tsx --test src/core/prompts/__tests__/plan_guidance.test.ts
```

Expected: FAIL because `combinePlanGuidance` is not exported.

- [ ] **Step 3: Implement `combinePlanGuidance`**

Append to `src/core/prompts/plan_guidance.ts`:

```ts
export function combinePlanGuidance(planGuidance: string, customPlansText: string): string {
  const plan = planGuidance.trim();
  const custom = customPlansText.trim();
  if (!plan && !custom) return '';

  const sections: string[] = [];
  if (plan) {
    sections.push('PLAN guidance:', '', plan);
  }
  if (custom) {
    if (sections.length > 0) sections.push('');
    sections.push('Custom plans guidance:', '', custom);
  }
  return sections.join('\n');
}
```

- [ ] **Step 4: Run pure helper tests to verify GREEN**

Run:

```bash
node --import tsx --test src/core/prompts/__tests__/plan_guidance.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add failing CLI tests for custom guidance**

Modify `src/cli/__tests__/plan_guidance.test.ts` imports:

```ts
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
```

Add import:

```ts
import { writeContext } from '../../core/runs/store.js';
```

Append tests:

```ts
test('plan_guidance CLI returns custom plans guidance when plan is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-plan-cli-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run-custom', {
      runId: 'run-custom',
      repoRoot: dir,
      range: 'workspace',
      background: '',
      files: [],
      changeFiles: [],
      plansGuidanceSource: '.code-review-plans.md',
      plansGuidanceText: 'custom guidance',
      meta: { generatedAt: '2026-07-10T00:00:00.000Z', pluginVersion: '0.1.0' },
    });
    process.chdir(oldCwd);

    const { stdout } = await runCli(dir, ['--runId', 'run-custom', '--path', 'src/a.ts']);
    const json = JSON.parse(stdout) as { path: string; guidance: string; hasPlan: boolean; hasCustomPlans: boolean };

    assert.equal(json.path, 'src/a.ts');
    assert.equal(json.hasPlan, false);
    assert.equal(json.hasCustomPlans, true);
    assert.match(json.guidance, /Custom plans guidance:/);
    assert.match(json.guidance, /custom guidance/);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('plan_guidance CLI combines plan and custom plans guidance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-plan-cli-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run-combined', {
      runId: 'run-combined',
      repoRoot: dir,
      range: 'workspace',
      background: '',
      files: [],
      changeFiles: [],
      plansGuidanceSource: '.code-review-plans.md',
      plansGuidanceText: 'custom guidance',
      meta: { generatedAt: '2026-07-10T00:00:00.000Z', pluginVersion: '0.1.0' },
    });
    await writePlan('run-combined', {
      change_summary: 'summary text',
      issues: [
        { severity: 'high', description: 'Fix src/a.ts race', tool_guidance: [] },
      ],
    });
    process.chdir(oldCwd);

    const { stdout } = await runCli(dir, ['--runId', 'run-combined', '--path', 'src/a.ts']);
    const json = JSON.parse(stdout) as { guidance: string; hasPlan: boolean; hasCustomPlans: boolean };

    assert.equal(json.hasPlan, true);
    assert.equal(json.hasCustomPlans, true);
    assert.match(json.guidance, /PLAN guidance:/);
    assert.match(json.guidance, /Fix src\/a\.ts race/);
    assert.match(json.guidance, /Custom plans guidance:/);
    assert.match(json.guidance, /custom guidance/);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: Run CLI tests to verify RED**

Run:

```bash
node --import tsx --test src/cli/__tests__/plan_guidance.test.ts
```

Expected: FAIL because CLI does not read context or emit new fields.

- [ ] **Step 7: Update `plan_guidance` CLI**

Modify `src/cli/plan_guidance.ts` to:

```ts
#!/usr/bin/env node
import { readContext, readPlan } from '../core/runs/store.js';
import { combinePlanGuidance, planOutputToGuidance } from '../core/prompts/plan_guidance.js';
import type { PlanOutput } from '../core/model/plan.js';
import type { ReviewContext } from '../core/model/request.js';

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] ?? '';
      out[k] = v;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  for (const r of ['runId', 'path']) {
    if (!f[r]) {
      process.stderr.write(`[ocr-plan-guidance] missing --${r}\n`);
      process.exit(2);
    }
  }

  const plan = await readPlan<PlanOutput>(f.runId);
  let ctx: ReviewContext | null = null;
  try {
    ctx = await readContext<ReviewContext>(f.runId);
  } catch {
    ctx = null;
  }

  const planGuidance = plan ? planOutputToGuidance(plan, f.path) : '';
  const customPlansText = ctx?.plansGuidanceText ?? '';
  const guidance = combinePlanGuidance(planGuidance, customPlansText);
  process.stdout.write(JSON.stringify({
    path: f.path,
    guidance,
    hasPlan: planGuidance.trim().length > 0,
    hasCustomPlans: customPlansText.trim().length > 0,
  }, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[ocr-plan-guidance] ${err?.message ?? err}\n`);
  process.exit(1);
});
```

- [ ] **Step 8: Run CLI tests to verify GREEN**

Run:

```bash
node --import tsx --test src/cli/__tests__/plan_guidance.test.ts src/core/prompts/__tests__/plan_guidance.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit guidance merge behavior**

Run:

```bash
git add src/core/prompts/plan_guidance.ts src/core/prompts/__tests__/plan_guidance.test.ts src/cli/plan_guidance.ts src/cli/__tests__/plan_guidance.test.ts
git commit -m "feat(plans): merge custom guidance into plan guidance

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Document Custom Plans Guidance

**Files:**
- Modify: `commands/review.md`
- Modify: `commands/review-opencode.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: `--plans`, context fields, and `ocr-plan-guidance` behavior from Tasks 3-4.
- Produces: user-facing usage docs.

- [ ] **Step 1: Update `commands/review.md` prepare summary wording**

Modify the Step 1 summary field list in `commands/review.md` so it includes `plansGuidanceSource`:

```md
Capture the stdout JSON. It contains `runId`, `fileCount`, `hunkCount`, `changedLines`, `contextPath`, `concurrency`, `preview`, `dryRun`, `resumed`, `remainingFileCount`, `rulesSource`, `plansGuidanceSource`, `excludedFileCount`, and `fileCountWarning`.
```

- [ ] **Step 2: Update `commands/review.md` planGuidance wording**

In Step 3 where `ocr-plan-guidance` is described, add this sentence after parsing guidance:

```md
The returned `guidance` may include both file-specific PLAN output and repository/user custom plans guidance loaded via `--plans`, `.code-review-plans.md`, or `~/.code-review/plans.md`.
```

- [ ] **Step 3: Update `commands/review-opencode.md` with the same wording**

Make the same two edits in `commands/review-opencode.md`:

- Step 1 summary field list includes `plansGuidanceSource`.
- Step 3 planGuidance description explains custom plans sources.

- [ ] **Step 4: Update README flags table**

In `README.md`, add this row after `--rules` is mentioned or in the flags table:

```md
| `--plans <path>` | custom plan guidance | — | Loads markdown review planning guidance and appends it to per-file reviewer guidance |
```

Because the current README mentions `--rules` below the table, also add:

```md
The `--plans` flag is supported for custom review planning guidance (see Configuration).
```

- [ ] **Step 5: Add README configuration section for custom plans**

After the Custom rules section in `README.md`, add:

```md
### Custom plans guidance

Custom plans guidance is plain Markdown that is appended to each file's reviewer `planGuidance`. It is useful for repository-specific review focus areas that are not file inclusion rules and do not replace system rule text.

Load priority:

1. CLI `--plans <path>`
2. Repository `.code-review-plans.md`
3. User `~/.code-review/plans.md`
4. No custom plans guidance

Example `.code-review-plans.md`:

```md
# Code Review Plan Guidance

Focus on:
- External API calls must treat non-2xx responses as failures.
- CLI commands should validate flags before reading run artifacts.
- Host adapter files must use the target host's frontmatter semantics.
```

In this iteration the markdown applies globally to every reviewed file. Path-specific sections are intentionally not parsed.
```

- [ ] **Step 6: Add README troubleshooting row**

In README troubleshooting table, add:

```md
| `OCRP-PLANS-100` | CLI `--plans` file cannot be read | Check the path and permissions, or remove `--plans` to use default lookup |
```

- [ ] **Step 7: Run a docs-sensitive grep verification**

Run:

```bash
grep -R "--plans\|code-review-plans\|plansGuidanceSource" -n README.md commands/review.md commands/review-opencode.md
```

Expected: matches in all three files.

- [ ] **Step 8: Commit docs**

Run:

```bash
git add commands/review.md commands/review-opencode.md README.md
git commit -m "docs(plans): document custom plans guidance

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Final Verification and Push

**Files:**
- No new source files unless earlier tasks require fixes.

**Interfaces:**
- Consumes: all prior task outputs.
- Produces: verified main branch with clean status.

- [ ] **Step 1: Run full tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npx tsc --noEmit
```

Expected: no output and exit 0.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: build completes and regenerates `dist/` and `bin/`.

- [ ] **Step 4: Verify git status**

Run:

```bash
git status --short
git log --oneline --decorate --max-count=8
```

Expected:

- No uncommitted source changes.
- Recent commits include Tasks 2-5 plus the already committed design spec.

- [ ] **Step 5: Push main to origin**

Run:

```bash
git push origin main
```

Expected: push succeeds.

---

## Self-Review Notes

Spec coverage:

- Conservative worktree cleanup: Task 1.
- Remote normalization: Task 1.
- `.ocr-runs` cleanup while preserving `bin/`/`dist/`: Task 1.
- `--plans`, repo, user loading priority: Task 2 and Task 3.
- Context storage: Task 3.
- `ocr-plan-guidance` custom and combined output: Task 4.
- Command and README docs: Task 5.
- Final tests/typecheck/build: Task 6.

Placeholder scan: no TBD/TODO placeholders remain.

Type consistency:

- `plansPath`, `plansGuidanceSource`, `plansGuidanceText` are used consistently across request/context/prepare.
- `LoadedPlansGuidance` and `loadPlansGuidance()` signatures match all task references.
- `combinePlanGuidance()` signature matches pure and CLI tests.
