# Per-File PLAN Phase Design

> Date: 2026-07-11
> Status: Approved design
> Scope: Make `/open-code-review:review` PLAN behavior match the original Go `open-code-review` per-file PLAN semantics.

## 1. Goal

Change the plugin from one global PLAN per review run to one generated PLAN per sufficiently large file. This matches the original Go implementation in `../open-code-review/internal/agent/agent.go`: each file subtask checks its own changed-line count, runs PLAN only when that file meets the threshold, then runs the main review task for that same file.

The existing custom plans guidance feature remains global markdown guidance and is still appended to each file's reviewer guidance.

## 2. Current Behavior

Current plugin flow:

1. `ocr-prepare` builds one `ReviewContext`.
2. If total review `changedLines >= 50`, `/open-code-review:review` invokes `ocr-plan` once for the whole run.
3. The global result is written to `.ocr-runs/<runId>/plan.json`.
4. `ocr-plan-guidance --runId <runId> --path <file>` filters that global plan to the current file and appends custom plans markdown.

This differs from the original Go CLI because a small file can receive plan guidance when only the total review crosses the threshold, and a large multi-file review gets only one broad plan.

## 3. Target Behavior

Target plugin flow:

1. `ocr-prepare` remains deterministic and builds one `ReviewContext`.
2. There is no generated global PLAN step.
3. For each reviewed file, before dispatching the reviewer subagent:
   - Compute that file's changed-line count as the number of hunk lines where `kind != ' '`.
   - If the count is lower than `PLAN_MODE_LINE_THRESHOLD` (`50`), skip generated PLAN for that file.
   - If the count is at least `50`, invoke `ocr-plan` for that file only.
   - Write the result to `.ocr-runs/<runId>/plans/<safePathKey(currentFilePath)>.json`.
4. `ocr-plan-guidance --runId <runId> --path <file>` reads the per-file plan, converts it to guidance, and appends custom plans markdown from `context.plansGuidanceText`.
5. If per-file PLAN fails or returns unparseable JSON, continue the file review without generated PLAN guidance and mention `OCRP-SKILL-040` in the final report.

## 4. Storage Layout

Add per-file plan storage under the run directory:

```text
.ocr-runs/<runId>/plans/<safePathKey(path)>.json
```

Example:

```text
.ocr-runs/20260711-abc1/plans/src%2Fcli%2Fprepare.ts.json
```

Use the existing `safePathKey(path)` helper from `src/core/runs/store.ts` for file names.

Keep legacy `.ocr-runs/<runId>/plan.json` read support in `ocr-plan-guidance` as a backward-compatible fallback for older runs. New orchestration should not write global `plan.json`.

## 5. Skill Contract

Update `skills/ocr-plan/SKILL.md` from run-wide planning to single-file planning.

The `/open-code-review:review` command will pass:

- `runId`
- `currentFilePath`

The skill must:

1. Read `.ocr-runs/<runId>/context.json`.
2. Find the matching file in `context.files[]`.
3. Produce one `PlanOutput` for that file only.
4. Return exactly one fenced `json` block.

The output schema stays unchanged:

```json
{
  "change_summary": "...",
  "issues": [
    {
      "severity": "high|medium|low",
      "description": "...",
      "tool_guidance": []
    }
  ]
}
```

## 6. Command Orchestration

### Claude Code command

Update `commands/review.md`:

- Change Step 2 to load context and explain that generated PLAN is per-file.
- In Step 3, for each file before `ocr-plan-guidance`:
  1. Compute file changed lines.
  2. If changed lines are at least `50`, invoke `ocr-plan` with `runId` and `currentFilePath`.
  3. Parse the fenced JSON.
  4. Write it to `.ocr-runs/<runId>/plans/<safePathKey>.json`.
  5. If parsing fails, continue without generated plan for that file and record `OCRP-SKILL-040` for final reporting.
  6. Run `ocr-plan-guidance` and dispatch the reviewer.

Batch waiting, retry, and cooldown behavior remain unchanged.

### OpenCode command

Update `commands/review-opencode.md` with the same per-file threshold and per-file plan storage semantics. OpenCode remains sequential and keeps its inter-file cooldown.

## 7. CLI and Core Changes

Add run-store helpers:

- `writeFilePlan(runId: string, path: string, plan: unknown): Promise<void>`
- `readFilePlan<T>(runId: string, path: string): Promise<T | null>`

Update `src/cli/plan_guidance.ts`:

1. Read per-file plan first using `readFilePlan(runId, path)`.
2. If absent, fall back to legacy `readPlan(runId)`.
3. Convert the loaded plan with `planOutputToGuidance(plan, path)`.
4. Combine generated guidance with custom plans markdown.
5. Keep the JSON output shape:

```json
{
  "path": "src/a.ts",
  "guidance": "...",
  "hasPlan": true,
  "hasCustomPlans": true
}
```

## 8. Tests

Add or update tests for:

- `writeFilePlan` / `readFilePlan` safe-path storage.
- `ocr-plan-guidance` reads per-file plan.
- Per-file plan takes precedence over legacy global `plan.json`.
- Legacy `plan.json` still works when no per-file plan exists.
- Custom plans-only guidance still works.
- Command/skill text no longer says one global PlanOutput covers all files.

## 9. Non-Goals

- Do not add a standalone `ocr-plan-file` CLI in this iteration.
- Do not remove legacy `.ocr-runs/<runId>/plan.json` reading.
- Do not change the `PlanOutput` schema.
- Do not change the custom plans markdown priority or storage.
- Do not implement Go-style memory compression in this change.

## 10. Acceptance Criteria

- Files with changed lines below 50 skip generated PLAN.
- Files with changed lines at or above 50 run generated PLAN before review.
- Generated per-file plans are stored under `.ocr-runs/<runId>/plans/`.
- `ocr-plan-guidance` combines per-file generated PLAN with custom plans guidance.
- Legacy global `plan.json` remains readable for old runs.
- `npm test`, `npx tsc --noEmit`, and `npm run build` pass.
