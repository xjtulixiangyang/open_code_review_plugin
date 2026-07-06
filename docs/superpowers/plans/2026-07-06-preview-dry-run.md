# Preview Dry-Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/open-code-review:review --preview|-p|--dry-run` as a deterministic prepare-only mode that shows what would be reviewed without invoking LLM review stages.

**Architecture:** `ocr-prepare` parses preview/dry-run flags, writes them into `ReviewRequest`, `ReviewContext`, and stdout summary. `commands/review.md` short-circuits after Step 1 when preview/dryRun is true and renders a text table from `context.json`; no new CLI and no aggregate changes. README and smoke tests document and verify the supported flags.

**Tech Stack:** TypeScript 5.5 strict mode · Node >=18 ESM · `node --import tsx --test` · git CLI · Claude Code plugin command markdown.

## Global Constraints

- Preview/dry-run only executes deterministic prepare; it must not call PLAN skill, reviewer subagents, filter, relocate, or aggregate.
- Do not generate formal `report.md` / `report.json` for preview/dry-run in this increment.
- Do not add an `ocr-preview` CLI in this increment.
- Do not change `ocr-aggregate` partial/done semantics.
- `--preview`, `-p`, and `--dry-run` are supported flags and must not trigger `OCRP-RUN-011`.
- `preview` and `dryRun` in stdout summary are always booleans.
- `rulesSource` in stdout summary is `context.rulesSource || 'system'`.
- `excludedFileCount` in stdout summary is `context.excludedFiles?.length ?? 0`.
- All changes must preserve existing `--rules` / `--rule` support and default concurrency `2` with cap `8`.
- Every task must follow TDD: write failing tests, observe failure, implement, observe pass.

---

## File Structure

**Modify:**

- `src/cli/prepare.ts` — parse preview/dry-run flags, pass them into `ReviewRequest`, and include preview metadata in stdout summary.
- `src/cli/__tests__/prepare_args.test.ts` — parser tests for `--preview`, `-p`, `--dry-run`, and combined flags.
- `src/cli/__tests__/prepare.test.ts` — integration tests that `ocr-prepare --preview/--dry-run` succeeds and writes context flags/summary fields.
- `src/core/context/review_context.ts` — persist `preview` and `dryRun` into `ReviewContext`.
- `src/core/context/__tests__/review_context.test.ts` — context tests for preview/dryRun persistence.
- `commands/review.md` — document summary fields and preview/dry-run short-circuit output.
- `README.md` — document preview/dry-run as supported.
- `scripts/smoke.sh` — add a minimal preview prepare check.

---

### Task 1: Parse preview/dry-run flags and persist them in context

**Files:**
- Modify: `src/cli/prepare.ts`
- Modify: `src/cli/__tests__/prepare_args.test.ts`
- Modify: `src/core/context/review_context.ts`
- Modify: `src/core/context/__tests__/review_context.test.ts`

**Interfaces:**
- Consumes existing `ReviewRequest.preview?: boolean` and `ReviewRequest.dryRun?: boolean`.
- Produces `ParsedArgs.preview?: boolean`, `ParsedArgs.dryRun?: boolean`.
- Produces `ReviewContext.preview === true` when request preview is true.
- Produces `ReviewContext.dryRun === true` when request dryRun is true.

- [ ] **Step 1: Add failing parser tests**

Edit `src/cli/__tests__/prepare_args.test.ts`. Replace the existing unsupported preview/dry-run test:

```ts
test('parseArgs keeps --preview and --dry-run unsupported in this increment', () => {
  const args = parseArgs(['--preview', '--dry-run']);
  assert.ok(args.unsupported.some((x) => x.includes('--preview')));
  assert.ok(args.unsupported.some((x) => x.includes('--dry-run')));
});
```

with these tests:

```ts
test('parseArgs accepts --preview and stores preview flag', () => {
  const args = parseArgs(['--preview']);
  assert.equal(args.preview, true);
  assert.equal(args.dryRun, undefined);
  assert.deepEqual(args.unsupported, []);
});

test('parseArgs accepts -p as preview alias', () => {
  const args = parseArgs(['-p']);
  assert.equal(args.preview, true);
  assert.deepEqual(args.unsupported, []);
});

test('parseArgs accepts --dry-run and stores dryRun flag', () => {
  const args = parseArgs(['--dry-run']);
  assert.equal(args.dryRun, true);
  assert.equal(args.preview, undefined);
  assert.deepEqual(args.unsupported, []);
});

test('parseArgs accepts preview and dry-run together', () => {
  const args = parseArgs(['--preview', '--dry-run']);
  assert.equal(args.preview, true);
  assert.equal(args.dryRun, true);
  assert.deepEqual(args.unsupported, []);
});
```

- [ ] **Step 2: Run parser tests and verify RED**

Run:

```bash
node --import tsx --test src/cli/__tests__/prepare_args.test.ts
```

Expected: tests fail because `ParsedArgs` does not expose `preview`/`dryRun` and parser still puts these flags in `unsupported`.

- [ ] **Step 3: Add failing context tests**

Append to `src/core/context/__tests__/review_context.test.ts`:

```ts
test('buildReviewContext persists preview flag', async () => {
  const repo = await mkGitRepo();
  try {
    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace', preview: true });
    assert.equal(ctx.preview, true);
    assert.equal(ctx.dryRun, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('buildReviewContext persists dryRun flag', async () => {
  const repo = await mkGitRepo();
  try {
    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace', dryRun: true });
    assert.equal(ctx.preview, false);
    assert.equal(ctx.dryRun, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
```

- [ ] **Step 4: Run context tests and verify RED**

Run:

```bash
node --import tsx --test src/core/context/__tests__/review_context.test.ts
```

Expected: the new tests fail because `buildReviewContext()` does not set `preview` or `dryRun`.

- [ ] **Step 5: Implement minimal parser changes**

Edit `src/cli/prepare.ts`.

Add fields to `ParsedArgs`:

```ts
  preview?: boolean;
  dryRun?: boolean;
```

Replace the current preview/dry-run parsing block:

```ts
    else if (a === '--dry-run') {
      out.unsupported.push('--dry-run is planned for P1 preview mode');
    } else if (a === '--preview' || a === '-p') {
      out.unsupported.push(`${a} is planned for P1 preview mode`);
```

with:

```ts
    else if (a === '--dry-run') {
      out.dryRun = true;
    } else if (a === '--preview' || a === '-p') {
      out.preview = true;
```

In the `ReviewRequest` object inside `main()`, add:

```ts
    preview: args.preview,
    dryRun: args.dryRun,
```

- [ ] **Step 6: Persist flags in ReviewContext**

Edit `src/core/context/review_context.ts`. In the return object, add these fields after `excludedFiles`:

```ts
    preview: req.preview === true,
    dryRun: req.dryRun === true,
```

- [ ] **Step 7: Run parser and context tests and verify GREEN**

Run:

```bash
node --import tsx --test src/cli/__tests__/prepare_args.test.ts src/core/context/__tests__/review_context.test.ts
```

Expected: all tests in both files pass.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/cli/prepare.ts src/cli/__tests__/prepare_args.test.ts src/core/context/review_context.ts src/core/context/__tests__/review_context.test.ts
git commit -m "feat(review): parse preview and dry-run flags

- accept --preview/-p and --dry-run in ocr-prepare
- pass preview and dryRun through ReviewRequest
- persist preview and dryRun in ReviewContext
- cover parser and context flag behavior

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Add preview metadata to prepare summary

**Files:**
- Modify: `src/cli/prepare.ts`
- Modify: `src/cli/__tests__/prepare.test.ts`

**Interfaces:**
- Consumes Task 1 parser/context behavior.
- Produces prepare stdout fields:
  ```ts
  preview: boolean;
  dryRun: boolean;
  rulesSource: string;
  excludedFileCount: number;
  ```

- [ ] **Step 1: Add failing prepare integration tests**

Open `src/cli/__tests__/prepare.test.ts`. Add these tests after the existing `ocr-prepare accepts --rules and stores rulesPath` test, or after the first prepare integration test:

```ts
test('ocr-prepare --preview succeeds and writes preview summary/context', async () => {
  const repo = await mkGitRepo();
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', PREPARE, '--preview'], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.preview, true);
    assert.equal(summary.dryRun, false);
    assert.equal(summary.rulesSource, 'system');
    assert.equal(typeof summary.excludedFileCount, 'number');
    const contextPath = join(repo, summary.contextPath);
    const ctx = JSON.parse(await readFile(contextPath, 'utf8'));
    assert.equal(ctx.preview, true);
    assert.equal(ctx.dryRun, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare --dry-run succeeds and writes dryRun summary/context', async () => {
  const repo = await mkGitRepo();
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', PREPARE, '--dry-run'], {
      cwd: repo,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.preview, false);
    assert.equal(summary.dryRun, true);
    assert.equal(summary.rulesSource, 'system');
    assert.equal(typeof summary.excludedFileCount, 'number');
    const contextPath = join(repo, summary.contextPath);
    const ctx = JSON.parse(await readFile(contextPath, 'utf8'));
    assert.equal(ctx.preview, false);
    assert.equal(ctx.dryRun, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
```

If `readFile` is not imported in this test file, add it to the existing `node:fs/promises` import.

- [ ] **Step 2: Run prepare integration tests and verify RED**

Run:

```bash
node --import tsx --test src/cli/__tests__/prepare.test.ts
```

Expected: tests fail because stdout summary does not include `preview`, `dryRun`, `rulesSource`, or `excludedFileCount`.

- [ ] **Step 3: Implement prepare summary fields**

Edit `src/cli/prepare.ts`. In the `summary` object inside `main()`, after `concurrency,` add:

```ts
    preview: ctx.preview === true,
    dryRun: ctx.dryRun === true,
    rulesSource: ctx.rulesSource ?? 'system',
    excludedFileCount: ctx.excludedFiles?.length ?? 0,
```

- [ ] **Step 4: Run prepare integration tests and verify GREEN**

Run:

```bash
node --import tsx --test src/cli/__tests__/prepare.test.ts
```

Expected: all prepare integration tests pass.

- [ ] **Step 5: Run all CLI tests**

Run:

```bash
node --import tsx --test src/cli/__tests__/*.test.ts
```

Expected: all CLI tests pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add src/cli/prepare.ts src/cli/__tests__/prepare.test.ts
git commit -m "feat(prepare): include preview metadata in summary

- expose preview and dryRun booleans in ocr-prepare stdout
- include rulesSource and excludedFileCount in prepare summary
- cover preview and dry-run prepare integration behavior

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: Short-circuit `/review` preview mode and update docs

**Files:**
- Modify: `commands/review.md`
- Modify: `README.md`

**Interfaces:**
- Consumes prepare stdout `preview`, `dryRun`, `rulesSource`, `excludedFileCount`, `concurrency`, `contextPath`.
- Consumes `ReviewContext.files[]`, `ReviewContext.excludedFiles[]`, and `ReviewContext.rulesSource`.
- Produces documented preview output and supported user-facing flags.

- [ ] **Step 1: Update `commands/review.md` Step 1 summary fields**

Replace the Step 1 sentence listing prepare stdout fields with:

```md
Capture the stdout JSON. It contains `runId`, `fileCount`, `hunkCount`, `changedLines`, `contextPath`, `concurrency`, `preview`, `dryRun`, `rulesSource`, and `excludedFileCount`. If `concurrency` is absent because an older build produced the summary, use `2`.
```

- [ ] **Step 2: Add preview short-circuit after no-changes handling**

In `commands/review.md`, after the `fileCount is 0` rule and before Step 2, add:

```md
If `preview == true` or `dryRun == true`:

1. Read `.ocr-runs/<runId>/context.json`.
2. Reply with a preview summary and then stop. Do not run Step 2, Step 3, Step 3.5, Step 3.6, or Step 4.
3. Use this exact structure:

   ```md
   ## Review Preview

   **Run**: `<runId>`  
   **Range**: `<context.range>`  
   **Mode**: `<preview|dry-run|preview+dry-run>`  
   **Rules source**: `<context.rulesSource || summary.rulesSource || "system">`  
   **Concurrency**: `<summary.concurrency || 2>`

   ### Files to review (<context.files.length>)

   | File | Status | Hunks | Changed lines | Rule |
   |---|---:|---:|---:|---|
   | `<file.path>` | `<file.status>` | `<file.hunks.length>` | `<sum of hunk lines where kind != " ">` | `<file.rulesHit[0].ruleId || "">` |

   ### Excluded files (<context.excludedFiles.length>)

   | File | Reason |
   |---|---|
   | `<excluded.path>` | `<excluded.reason>` |
   ```

4. If there are no excluded files, write `None` below the `Excluded files` heading instead of a table.
```

- [ ] **Step 3: Update command error table**

In `commands/review.md`, replace the `OCRP-RUN-011` row with:

```md
| OCRP-RUN-011 | "Argument conflict or unsupported flag: <message>. Use only one review target." |
```

- [ ] **Step 4: Update README command flag docs**

In `README.md`, update command/flags documentation so `--preview`, `-p`, and `--dry-run` are described as supported. Add this paragraph near the command options section:

```md
`--preview`, `-p`, and `--dry-run` run deterministic prepare only. They show the review range, files that would be reviewed, excluded files, matched rule IDs, rules source, and concurrency. Preview/dry-run mode does not call the PLAN skill, reviewer subagents, filter, relocate, or aggregate, and it does not generate formal `report.md` / `report.json` artifacts.
```

- [ ] **Step 5: Remove stale unsupported wording**

Run:

```bash
grep -n "planned for P1 preview mode\|preview.*unsupported\|dry-run.*unsupported\|avoid P1 flags such as --preview" commands/review.md README.md src/cli/prepare.ts
```

Expected before edits may show matches; after edits it must show no output.

- [ ] **Step 6: Commit Task 3**

```bash
git add commands/review.md README.md
git commit -m "docs(review): document preview dry-run short circuit

- describe prepare-only preview and dry-run flow
- add review preview output structure to command orchestration
- document supported preview flags in README
- remove stale unsupported preview wording

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Add smoke coverage and run final verification

**Files:**
- Modify: `scripts/smoke.sh`

**Interfaces:**
- Consumes `ocr-prepare --preview` supported behavior from Tasks 1-2.
- Produces smoke verification that preview prepare exits 0 and emits `preview: true`.

- [ ] **Step 1: Inspect current smoke script**

Run:

```bash
grep -n "ocr-prepare\|aggregate\|PASS\|rules-check" scripts/smoke.sh
```

Expected: shows the current prepare/aggregate/rules-check smoke stages.

- [ ] **Step 2: Add preview smoke check**

Edit `scripts/smoke.sh`. After the existing prepare summary is captured and before aggregate, add this shell block:

```bash
echo "\n=== Test preview mode ==="
preview_summary="$($PLUGIN_ROOT/bin/ocr-prepare --preview)"
echo "[smoke] preview summary: $preview_summary"
node -e '
const summary = JSON.parse(process.argv[1]);
if (summary.preview !== true) {
  console.error("FAIL: preview summary did not set preview=true");
  process.exit(1);
}
if (summary.dryRun !== false) {
  console.error("FAIL: preview summary did not set dryRun=false");
  process.exit(1);
}
if (typeof summary.rulesSource !== "string") {
  console.error("FAIL: preview summary missing rulesSource");
  process.exit(1);
}
if (typeof summary.excludedFileCount !== "number") {
  console.error("FAIL: preview summary missing excludedFileCount");
  process.exit(1);
}
console.log("PASS: preview summary contains preview metadata");
' "$preview_summary"
```

Use the script's existing variable names. If it uses a different plugin root variable than `PLUGIN_ROOT`, use the existing variable exactly.

- [ ] **Step 3: Run smoke and verify GREEN**

Run:

```bash
npm run smoke
```

Expected: smoke exits 0 and prints `PASS: preview summary contains preview metadata`.

- [ ] **Step 4: Run full final verification**

Run:

```bash
npm run typecheck && npm test && npm run build && npm run smoke
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit Task 4**

```bash
git add scripts/smoke.sh
git commit -m "test(smoke): cover preview prepare mode

- run ocr-prepare --preview in smoke
- assert preview metadata appears in prepare summary

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

- Supported `--preview`, `-p`, `--dry-run`: Task 1 parser tests and implementation.
- Persist `preview` / `dryRun` into context: Task 1 context tests and implementation.
- Prepare summary `preview`, `dryRun`, `rulesSource`, `excludedFileCount`: Task 2.
- `/review` short-circuits after Step 1 and does not run plan/reviewer/filter/relocate/aggregate: Task 3 command markdown.
- README supported behavior docs: Task 3.
- Smoke coverage: Task 4.
- No new CLI / no aggregate changes / no formal report: enforced by file structure and Task 3 wording.

**Placeholder scan:** The plan contains no TBD/TODO/fill-in placeholders. Every code/test step includes exact content or exact replacement text.

**Type consistency:** `ParsedArgs.preview` / `dryRun`, `ReviewRequest.preview` / `dryRun`, `ReviewContext.preview` / `dryRun`, and summary field names match the approved spec.
