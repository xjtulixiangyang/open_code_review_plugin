---
description: |
  Deterministic code review via the open-code-review orchestrator.
  All scheduling, retry, and completeness decisions are made by the
  TypeScript review engine — this command only executes its instructions.
argument-hint: "[workspace|staged|<sha>|<from>..<to>] [--background \"...\"] [--dry-run] [--preview]"
---

# /review — open-code-review-plugin

This command delegates ALL review scheduling to the TypeScript orchestrator.
You have zero authority over: file selection, retry policy, lease duration,
completeness, or aggregation timing. The engine decides; you execute.

## Step 1 — Run the engine

!`node ${CLAUDE_PLUGIN_ROOT}/dist/commands/review.mjs $ARGUMENTS`

Parse the JSON output. It always contains a `phase` field.

## Step 2 — Follow the phase

### phase = "dispatch"

For each entry in `claims[]`, perform the preparation below, then spawn
exactly one `ocr-review-file` skill task as a subagent. After ALL agents
are spawned, acknowledge each claim. When all reviewers finish, go back to
Step 1 with `reRunArgs`.

**Per-claim reviewer preparation:**

1. Read `context.json` from `.ocr-runs/<effectiveRunId>/context.json`.
   Find the file entry whose `path` equals `claim.filePath`. Read the diff
   from that entry or via `file_read_diff --runId <effectiveRunId>`.

2. Resolve plan guidance: if the file has ≥ 50 changed lines, invoke the
   `ocr-plan` skill first. Then run:
   `ocr-plan-guidance --runId <effectiveRunId> --path <claim.filePath>`
   On soft failure record `OCRP-SKILL-040` and use empty guidance.

3. Resolve system rule: from the file's `rulesHit[0].text`, then `.message`,
   otherwise empty with `OCRP-RULES-094`.

4. Dispatch the reviewer subagent with this task payload:

   > Review file `{claim.filePath}`. Use these exact immutable claim fields
   > for every `code_comment` and `task_done` call:
   > - runId: `{claim.runId}`
   > - taskId: `{claim.taskId}`
   > - attemptId: `{claim.attemptId}`
   > - leaseToken: `{claim.leaseToken}`
   > - leaseDeadline: `{claim.leaseDeadline}`
   > - filePath: `{claim.filePath}`
   > - diffFingerprint: `{claim.diffFingerprint}`
   >
   > Also provide: the current file diff, the changed files list from
   > context, requirement background, resolved system rule, resolved
   > plan guidance, and the current ISO date-time.
   >
   > Use the `ocr-review-file` skill for review. When done, call
   > `task_done` with all credentials and outcome. Never invent or
   > alter claim fields.

**After all agents are spawned**, for each claim:
!`ocr-orchestrator-ack --runId <claim.runId> --taskId <claim.taskId> --attemptId <claim.attemptId>`

**After all reviewers complete**, continue:
!`node ${CLAUDE_PLUGIN_ROOT}/dist/commands/review.mjs <reRunArgs>`

Go back to Step 1 with the output.

### phase = "wait"

Wait until `waitUntil` (ISO timestamp), then:
!`node ${CLAUDE_PLUGIN_ROOT}/dist/commands/review.mjs <reRunArgs>`

Go back to Step 1 with the output.

### phase = "done"

Read the report from `reportMdPath` (if markdown/both) and/or
`reportJsonPath` (if json/both). Present the result to the user:

- If `success` is true: "✓ Review complete. {summary}"
- If `success` is false: "✗ Review failed (partial). {summary}"
  List each file from `failedFiles[]` with its reason.

Optional: post comments via `ocr-post-comments --runId <effectiveRunId>`.

Stop. The review command is finished.
