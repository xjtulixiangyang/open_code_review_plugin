# Per-File PLAN Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/open-code-review:review` run generated PLAN per sufficiently large file, matching the original Go `open-code-review` per-file PLAN semantics.

**Architecture:** Keep `ocr-prepare` deterministic and keep reviewer dispatch file-based. Add per-file plan artifacts under `.ocr-runs/<runId>/plans/<safePathKey>.json`, teach `ocr-plan-guidance` to prefer them over legacy `plan.json`, and update command/skill orchestration so PLAN runs immediately before each file's reviewer only when that file's changed lines are at least 50.

**Tech Stack:** TypeScript ES modules, Node.js >=18, native `node:test`, `tsx`, Markdown command/skill prompts, git.

## Global Constraints

- Node.js >=18.
- TypeScript source uses ESM imports/exports and `.js` import specifiers.
- Do not add external npm dependencies.
- Preserve the existing `PlanOutput` schema.
- Preserve custom plans markdown priority and storage.
- Keep legacy `.ocr-runs/<runId>/plan.json` read support in `ocr-plan-guidance`.
- Do not add a standalone `ocr-plan-file` CLI in this iteration.
- Do not implement Go-style memory compression in this change.

---

## File Structure

- Modify `src/core/runs/store.ts` — add per-file plan artifact helpers using the existing `safePathKey()` and run-dir resolution.
- Modify `src/core/runs/__tests__/store.test.ts` — cover per-file plan write/read and missing-file behavior.
- Modify `src/cli/plan_guidance.ts` — prefer per-file plan, fallback to legacy global plan, keep custom plans merge.
- Modify `src/cli/__tests__/plan_guidance.test.ts` — cover per-file plan, precedence over legacy global plan, legacy fallback, and custom-only guidance.
- Modify `skills/ocr-plan/SKILL.md` — change contract from run-wide plan to single-file plan with `currentFilePath`.
- Modify `commands/review.md` — remove global generated PLAN step; add per-file threshold, per-file `ocr-plan` invocation, and per-file plan write before reviewer dispatch.
- Modify `commands/review-opencode.md` — same per-file PLAN semantics for sequential OpenCode orchestration.
- Modify `src/core/prompts/__tests__/skill_consistency.test.ts` — assert the skill no longer says it produces one plan for all files and does mention `currentFilePath`.

---

### Task 1: Add Per-File Plan Store Helpers

**Files:**
- Modify: `src/core/runs/store.ts`
- Modify: `src/core/runs/__tests__/store.test.ts`

**Interfaces:**
- Consumes: existing `resolveRunDir(runId)`, `ensureDir(path)`, and `safePathKey(path)` from `src/core/runs/store.ts`.
- Produces:
  - `writeFilePlan(runId: string, path: string, plan: unknown): Promise<void>`
  - `readFilePlan<T = unknown>(runId: string, path: string): Promise<T | null>`

- [ ] **Step 1: Add failing store tests**

Append these imports in `src/core/runs/__tests__/store.test.ts`:

```ts
import { existsSync } from 'node:fs';
```

Extend the existing import from `../store.js` so it includes the new functions:

```ts
import {
  newRunId,
  runDir,
  writeContext,
  readContext,
  appendComment,
  readComments,
  writePlan,
  readPlan,
  writeFilePlan,
  readFilePlan,
  appendEvent,
  markDone,
  listDone,
  writeReport,
  safePathKey,
} from '../store.js';
```

Append these tests after the existing `writePlan + readPlan 往返` test:

```ts
test('writeFilePlan + readFilePlan stores per-file plan by safe path key', async () => {
  const { dir, restore } = await setupTempRepo();
  try {
    const id = newRunId();
    const plan: PlanOutput = {
      change_summary: 'file summary',
      issues: [{ severity: 'high', description: 'Fix src/a.ts race', tool_guidance: [] }],
    };

    assert.equal(await readFilePlan(id, 'src/a.ts'), null);
    await writeFilePlan(id, 'src/a.ts', plan);

    assert.deepEqual(await readFilePlan(id, 'src/a.ts'), plan);
    const expectedPath = join(dir, '.ocr-runs', id, 'plans', `${safePathKey('src/a.ts')}.json`);
    assert.equal(existsSync(expectedPath), true);
  } finally {
    restore();
  }
});

test('readFilePlan returns null for a different path without falling back', async () => {
  const { restore } = await setupTempRepo();
  try {
    const id = newRunId();
    await writeFilePlan(id, 'src/a.ts', { change_summary: 'a', issues: [] });

    assert.equal(await readFilePlan(id, 'src/b.ts'), null);
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: Run store tests to verify RED**

Run:

```bash
node --import tsx --test src/core/runs/__tests__/store.test.ts
```

Expected: FAIL because `writeFilePlan` and `readFilePlan` are not exported.

- [ ] **Step 3: Implement per-file plan helpers**

In `src/core/runs/store.ts`, add these functions immediately after `readPlan()`:

```ts
export async function writeFilePlan(runId: string, path: string, plan: unknown): Promise<void> {
  const dir = join(await resolveRunDir(runId), 'plans');
  await ensureDir(dir);
  await writeFile(join(dir, `${safePathKey(path)}.json`), JSON.stringify(plan, null, 2), 'utf8');
}

export async function readFilePlan<T = unknown>(runId: string, path: string): Promise<T | null> {
  try {
    const body = await readFile(join(await resolveRunDir(runId), 'plans', `${safePathKey(path)}.json`), 'utf8');
    return JSON.parse(body) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
```

- [ ] **Step 4: Run store tests to verify GREEN**

Run:

```bash
node --import tsx --test src/core/runs/__tests__/store.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit per-file plan store helpers**

Run:

```bash
git add src/core/runs/store.ts src/core/runs/__tests__/store.test.ts
git commit -m "feat(plans): store per-file plan artifacts

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Teach `ocr-plan-guidance` to Prefer Per-File Plans

**Files:**
- Modify: `src/cli/plan_guidance.ts`
- Modify: `src/cli/__tests__/plan_guidance.test.ts`

**Interfaces:**
- Consumes: `readFilePlan<T>(runId: string, path: string): Promise<T | null>` from Task 1.
- Produces: `ocr-plan-guidance` reads `.ocr-runs/<runId>/plans/<safePathKey(path)>.json` first, then falls back to legacy `.ocr-runs/<runId>/plan.json`.

- [ ] **Step 1: Add failing CLI tests for per-file plans**

Modify the import in `src/cli/__tests__/plan_guidance.test.ts`:

```ts
import { writeFilePlan, writePlan } from '../../core/runs/store.js';
```

Append these tests after `plan_guidance CLI prints file-specific guidance JSON`:

```ts
test('plan_guidance CLI reads per-file plan artifact', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-plan-cli-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeFilePlan('run-file', 'src/a.ts', {
      change_summary: 'per-file summary',
      issues: [
        { severity: 'high', description: 'Fix src/a.ts race', tool_guidance: [] },
      ],
    });
    process.chdir(oldCwd);

    const { stdout } = await runCli(dir, ['--runId', 'run-file', '--path', 'src/a.ts']);
    const json = JSON.parse(stdout) as { guidance: string; hasPlan: boolean; hasCustomPlans: boolean };

    assert.equal(json.hasPlan, true);
    assert.equal(json.hasCustomPlans, false);
    assert.match(json.guidance, /per-file summary/);
    assert.match(json.guidance, /Fix src\/a\.ts race/);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('plan_guidance CLI per-file plan takes precedence over legacy global plan', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-plan-cli-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writePlan('run-precedence', {
      change_summary: 'legacy summary',
      issues: [
        { severity: 'high', description: 'Legacy src/a.ts issue', tool_guidance: [] },
      ],
    });
    await writeFilePlan('run-precedence', 'src/a.ts', {
      change_summary: 'per-file summary',
      issues: [
        { severity: 'high', description: 'Per-file src/a.ts issue', tool_guidance: [] },
      ],
    });
    process.chdir(oldCwd);

    const { stdout } = await runCli(dir, ['--runId', 'run-precedence', '--path', 'src/a.ts']);
    const json = JSON.parse(stdout) as { guidance: string; hasPlan: boolean };

    assert.equal(json.hasPlan, true);
    assert.match(json.guidance, /per-file summary/);
    assert.match(json.guidance, /Per-file src\/a\.ts issue/);
    assert.doesNotMatch(json.guidance, /legacy summary/);
    assert.doesNotMatch(json.guidance, /Legacy src\/a\.ts issue/);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
```

The existing `plan_guidance CLI prints file-specific guidance JSON` test remains the legacy global fallback test.

- [ ] **Step 2: Run plan guidance tests to verify RED**

Run:

```bash
node --import tsx --test src/cli/__tests__/plan_guidance.test.ts
```

Expected: FAIL because `writeFilePlan` may not be imported yet if Task 1 is absent, or because `ocr-plan-guidance` still reads only legacy `plan.json`.

- [ ] **Step 3: Update CLI to prefer per-file plan**

In `src/cli/plan_guidance.ts`, change the import:

```ts
import { readContext, readFilePlan, readPlan } from '../core/runs/store.js';
```

Replace:

```ts
const plan = await readPlan<PlanOutput>(f.runId);
const planGuidance = plan ? planOutputToGuidance(plan, f.path) : '';
```

with:

```ts
const plan = await readFilePlan<PlanOutput>(f.runId, f.path) ?? await readPlan<PlanOutput>(f.runId);
const planGuidance = plan ? planOutputToGuidance(plan, f.path) : '';
```

- [ ] **Step 4: Run plan guidance tests to verify GREEN**

Run:

```bash
node --import tsx --test src/cli/__tests__/plan_guidance.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit per-file plan guidance behavior**

Run:

```bash
git add src/cli/plan_guidance.ts src/cli/__tests__/plan_guidance.test.ts
git commit -m "feat(plans): prefer per-file plan guidance

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Update `ocr-plan` Skill Contract to Single-File Planning

**Files:**
- Modify: `skills/ocr-plan/SKILL.md`
- Modify: `src/core/prompts/__tests__/skill_consistency.test.ts`

**Interfaces:**
- Consumes: run orchestration now passes `runId` and `currentFilePath`.
- Produces: skill output remains one fenced `json` block matching `PlanOutput`, scoped to the current file only.

- [ ] **Step 1: Add failing skill consistency assertions**

Append this test to `src/core/prompts/__tests__/skill_consistency.test.ts`:

```ts
test('ocr-plan skill describes single-file PLAN handoff', () => {
  const skill = readRoot('skills/ocr-plan/SKILL.md');

  assert.ok(skill.includes('currentFilePath'), 'ocr-plan skill must require currentFilePath');
  assert.ok(skill.includes('Produce ONE PlanOutput JSON for the current file only'), 'ocr-plan skill must be single-file scoped');
  assert.equal(skill.includes('covering ALL files in `context.files[]`'), false);
  assert.equal(skill.includes('triggered by totalChangedLines >= 50'), false);
});
```

- [ ] **Step 2: Run skill consistency tests to verify RED**

Run:

```bash
node --import tsx --test src/core/prompts/__tests__/skill_consistency.test.ts
```

Expected: FAIL because `ocr-plan` still describes all-files planning.

- [ ] **Step 3: Update `skills/ocr-plan/SKILL.md` frontmatter description**

Replace the frontmatter description with:

```md
description: |
  Generate a structured per-file review plan (PLAN_TASK). Input: runId and
  currentFilePath from a prepared ReviewContext. Output: a JSON object with
  {change_summary, issues[]} for that file only.
  Use only when the host /open-code-review:review command requests it for a
  file whose changed lines are at least PLAN_MODE_LINE_THRESHOLD (50).
```

- [ ] **Step 4: Update `skills/ocr-plan/SKILL.md` input hand-off section**

Replace the `## Input Hand-off` section with:

```md
## Input Hand-off

The /open-code-review:review command will pass you `runId` and `currentFilePath`. You should:

1. Read `.ocr-runs/<runId>/context.json` to get the ReviewContext (files, diffs, rulesHit).
2. Find the file where `file.path === currentFilePath`.
3. Produce ONE PlanOutput JSON for the current file only.
4. Use `context.changeFiles` only as surrounding context; do not produce issues for other files unless they directly affect the current file's review strategy.
5. Return the JSON inside a single fenced ```json block. The command will parse it and write to `.ocr-runs/<runId>/plans/<safePathKey(currentFilePath)>.json`.

If your output cannot be parsed as JSON, the host command will downgrade with error code OCRP-SKILL-040 for this file and proceed without generated plan_guidance.
```

- [ ] **Step 5: Run skill consistency tests to verify GREEN**

Run:

```bash
node --import tsx --test src/core/prompts/__tests__/skill_consistency.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit single-file plan skill contract**

Run:

```bash
git add skills/ocr-plan/SKILL.md src/core/prompts/__tests__/skill_consistency.test.ts
git commit -m "docs(plans): scope plan skill to one file

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Update Claude Code Review Command Orchestration

**Files:**
- Modify: `commands/review.md`

**Interfaces:**
- Consumes:
  - `ocr-plan` skill with `runId` and `currentFilePath`.
  - `ocr-plan-guidance --runId <runId> --path <file>` from Task 2.
  - Per-file plan storage path `.ocr-runs/<runId>/plans/<safePathKey>.json`.
- Produces: `/open-code-review:review` runs generated PLAN per file only when that file has at least 50 changed lines.

- [ ] **Step 1: Replace global Step 2 wording**

In `commands/review.md`, replace the current Step 2 block beginning at `### Step 2 — Plan (only when changedLines >= 50)` through `Otherwise skip this step.` with:

```md
### Step 2 — Load context for per-file PLAN/review

Read `.ocr-runs/<runId>/context.json` to load the ReviewContext.

Generated PLAN is not run once for the whole review. It is run per file in Step 3, matching the original OCR behavior: only files whose own changed-line count is at least `PLAN_MODE_LINE_THRESHOLD` (`50`) get generated PLAN guidance before their reviewer subagent runs.
```

- [ ] **Step 2: Insert per-file PLAN instructions before `ocr-plan-guidance`**

In `commands/review.md`, within `For each file in a batch:`, replace item `1. Compute planGuidance deterministically. Run:` through the paragraph ending `Do not manually re-implement plan filtering in the main conversation.` with:

```md
1. Compute this file's changed-line count as the sum of all `hunk.lines` where `kind != " "` for `currentFilePath`.
2. If this file's changed-line count is at least `50`, run per-file generated PLAN before reviewer dispatch:
   - Invoke the `ocr-plan` skill with exactly: `runId` and `currentFilePath`.
   - Parse the fenced ```json PlanOutput.
   - If parsing succeeds, write it to `.ocr-runs/<runId>/plans/<safePathKey(currentFilePath)>.json`. Use `encodeURIComponent(currentFilePath)` for `<safePathKey(currentFilePath)>`.
   - If parsing fails, set `planMissing = true` for this file, do not write a plan file, continue review, and mention `OCRP-SKILL-040` in the final report.
3. If this file's changed-line count is lower than `50`, skip generated PLAN for this file.
4. Compute `planGuidance` deterministically. Run:
   ```bash
   ocr-plan-guidance --runId <runId> --path <currentFilePath>
   ```
   Parse stdout JSON and use its `guidance` field. The returned `guidance` may include both this file's generated PLAN output and repository/user custom plans guidance loaded via `--plans`, `.code-review-plans.md`, or `~/.code-review/plans.md`. If the command fails, set `planGuidance = ""` and mention `OCRP-SKILL-040` in the final report. Do not manually re-implement plan filtering in the main conversation.
```

- [ ] **Step 3: Renumber following list items**

In the same section, renumber the existing `2. Compute systemRule` to `5. Compute systemRule`, `3. Dispatch` to `6. Dispatch`, `4. Retry` to `7. Retry`, and `5. If both attempts fail` to `8. If both attempts fail`.

- [ ] **Step 4: Verify command text**

Run:

```bash
grep -n "Generated PLAN is not run once\|currentFilePath\|plans/<safePathKey" commands/review.md
```

Expected: output includes all three phrases.

- [ ] **Step 5: Commit Claude Code command orchestration**

Run:

```bash
git add commands/review.md
git commit -m "docs(review): run plan per file before review

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Update OpenCode Review Command Orchestration

**Files:**
- Modify: `commands/review-opencode.md`

**Interfaces:**
- Consumes:
  - `ocr-plan` skill with `runId` and `currentFilePath`.
  - `ocr-plan-guidance --runId <runId> --path <file>` from Task 2.
- Produces: `/open-code-review:review-opencode` uses the same per-file PLAN threshold while remaining sequential.

- [ ] **Step 1: Replace OpenCode Step 2 wording**

In `commands/review-opencode.md`, replace the existing Step 2 block beginning at `### Step 2 — Plan (only when changedLines >= 50)` through `If parsing fails, continue without plan guidance and mention OCRP-SKILL-040.` with:

```md
### Step 2 — Load context for per-file PLAN/review

Read `.ocr-runs/<runId>/context.json` to load the ReviewContext.

Generated PLAN is not run once for the whole review. It is run per file in Step 3, matching the original OCR behavior: only files whose own changed-line count is at least `PLAN_MODE_LINE_THRESHOLD` (`50`) get generated PLAN guidance before review.
```

- [ ] **Step 2: Insert per-file PLAN before OpenCode planGuidance**

In `commands/review-opencode.md`, within `For **each** file:`, replace the current `1. **planGuidance** — Run:` block with:

```md
1. **per-file PLAN** — Compute this file's changed-line count as the sum of all `hunk.lines` where `kind != " "` for `currentFilePath`. If the count is at least `50`:
   - Invoke `ocr-plan` skill with exactly: `runId` and `currentFilePath`.
   - Parse the fenced ```json PlanOutput.
   - If parsing succeeds, write it to `.ocr-runs/<runId>/plans/<safePathKey(currentFilePath)>.json`. Use `encodeURIComponent(currentFilePath)` for `<safePathKey(currentFilePath)>`.
   - If parsing fails, continue without generated PLAN guidance for this file and mention `OCRP-SKILL-040`.
   If the count is lower than `50`, skip generated PLAN for this file.

2. **planGuidance** — Run:
   ```bash
   ocr-plan-guidance --runId <runId> --path <currentFilePath>
   ```
   Parse stdout and use its `guidance` field. The returned `guidance` may include both this file's generated PLAN output and repository/user custom plans guidance loaded via `--plans`, `.code-review-plans.md`, or `~/.code-review/plans.md`. On failure, set guidance to "" and mention `OCRP-SKILL-040`.
```

- [ ] **Step 3: Renumber later OpenCode steps**

Renumber the existing `2. **systemRule**` to `3. **systemRule**`, and increment the following steps in that per-file section by one so they remain sequential.

- [ ] **Step 4: Verify OpenCode command text**

Run:

```bash
grep -n "Generated PLAN is not run once\|per-file PLAN\|plans/<safePathKey" commands/review-opencode.md
```

Expected: output includes all three phrases.

- [ ] **Step 5: Commit OpenCode command orchestration**

Run:

```bash
git add commands/review-opencode.md
git commit -m "docs(opencode): run plan per file before review

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Final Verification

**Files:**
- No new source files unless earlier tasks require fixes.

**Interfaces:**
- Consumes all prior task outputs.
- Produces a verified main branch with per-file PLAN behavior documented and implemented.

- [ ] **Step 1: Run targeted tests**

Run:

```bash
node --import tsx --test \
  src/core/runs/__tests__/store.test.ts \
  src/cli/__tests__/plan_guidance.test.ts \
  src/core/prompts/__tests__/skill_consistency.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npx tsc --noEmit
```

Expected: no output and exit 0.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: build completes and regenerates `dist/` and `bin/`.

- [ ] **Step 5: Smoke `ocr-plan-guidance` per-file plan**

Run:

```bash
tmp=$(mktemp -d)
old=$(pwd)
cd "$tmp"
mkdir -p .ocr-runs/run-smoke/plans
cat > .ocr-runs/run-smoke/plans/src%2Fa.ts.json <<'JSON'
{
  "change_summary": "per-file smoke summary",
  "issues": [
    { "severity": "high", "description": "Fix src/a.ts smoke issue", "tool_guidance": [] }
  ]
}
JSON
cat > .ocr-runs/run-smoke/context.json <<'JSON'
{
  "plansGuidanceText": "custom smoke guidance"
}
JSON
"$old/bin/ocr-plan-guidance" --runId run-smoke --path src/a.ts
cd "$old"
rm -rf "$tmp"
```

Expected: stdout JSON contains `hasPlan: true`, `hasCustomPlans: true`, `per-file smoke summary`, and `custom smoke guidance`.

- [ ] **Step 6: Verify git status and recent commits**

Run:

```bash
git status --short
git log --oneline --decorate --max-count=10
```

Expected:

- No uncommitted source changes except ignored `dist/`/`bin/` build artifacts if the repository ignores them.
- Recent commits include Tasks 1-5 plus the design spec.

- [ ] **Step 7: Commit any final verification-only fixes if needed**

If Step 1-6 expose a fix, commit it with:

```bash
git add <changed-files>
git commit -m "fix(plans): finalize per-file plan behavior

Co-Authored-By: Claude <noreply@anthropic.com>"
```

If no fixes are needed, do not create an empty commit.

---

## Self-Review Notes

Spec coverage:

- Per-file threshold and original Go behavior: Tasks 4 and 5.
- Per-file plan storage under `.ocr-runs/<runId>/plans/`: Task 1.
- `ocr-plan-guidance` per-file read with legacy fallback and custom plans merge: Task 2.
- `ocr-plan` single-file skill contract: Task 3.
- Command orchestration for Claude Code and OpenCode: Tasks 4 and 5.
- Tests/typecheck/build/smoke: Task 6.

Placeholder scan: no placeholder markers remain.

Type consistency:

- `writeFilePlan(runId, path, plan)` and `readFilePlan<T>(runId, path)` signatures are used consistently across Tasks 1-2.
- Per-file storage uses the existing `safePathKey(path)` helper consistently.
- `PlanOutput` schema is unchanged.
