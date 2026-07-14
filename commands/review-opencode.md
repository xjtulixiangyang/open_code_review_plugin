---
description: |
  Run the open-code-review-plugin code review on a git change set. Pass-through
  flags align with alibaba/open-code-review CLI: workspace (default), --staged,
  --commit <sha>, --from <a> --to <b>, --paths, --background, --rules, --plans.
argument-hint: "[workspace|staged|<sha>|<from>..<to>] [--background \"...\"]"
allowed-tools: read, glob, grep, bash, write
---

# /review — open-code-review-plugin (OpenCode)

Run a code review through the deterministic pull orchestrator. OpenCode is
sequential: its claim capacity is always 1. The TypeScript orchestrator owns the
file set, attempts, retries, leases, and completeness decision.

## Prepare and preview

1. Run `ocr-prepare $ARGUMENTS` and parse its JSON as `prepareSummary`.
2. If it fails, surface stderr and stop. If `fileCount == 0`, report "No changes to review." and stop successfully.
3. If `preview` or `dryRun` is true, read the candidate `context.json`, present the existing preview table (file, status, hunks, changed lines, rule, exclusions), and stop.
4. Run `ocr-orchestrator-start --runId <prepareSummary.runId>` and parse its JSON. Replace the working `runId` with `effectiveRunId` for every later command and artifact read. Read `.ocr-runs/<effectiveRunId>/context.json`.

OpenCode uses `capacity = 1`, with a 3-second inter-file cooldown, extended to
8 seconds after a 503/timeout.

<!-- ORCHESTRATOR-PROTOCOL:START -->
## Deterministic Orchestration Protocol

The orchestrator is the sole source of review work. Never enumerate a separate
file queue, invent a path, retry outside the orchestrator, or aggregate early.
Before entering this loop, run `ocr-orchestrator-start --runId <candidateRunId>`
and replace the working run ID with its `effectiveRunId`.

1. Run `ocr-orchestrator-reconcile --runId <effectiveRunId>` and parse the status.
2. If `state` is `completed` or `failed`, leave the loop.
3. Run `ocr-orchestrator-claim --runId <effectiveRunId> --capacity <capacity>`.
4. For every returned claim, use exactly its `runId`, `taskId`, `attemptId`,
   `leaseToken`, `leaseDeadline`, `filePath`, and `diffFingerprint`. Build that
   file's PLAN/rule guidance from the effective run context, then dispatch one
   reviewer carrying all claim fields.
5. After the host accepts a reviewer dispatch, run
   `ocr-orchestrator-ack --runId <effectiveRunId> --taskId <taskId> --attemptId <attemptId>`.
   If dispatch itself fails before acknowledgement, run
   `ocr-orchestrator-dispatch-fail --runId <effectiveRunId> --taskId <taskId> --attemptId <attemptId>`.
6. Wait for the dispatched reviewers to finish, then reconcile again. A reviewer
   message is not completion authority; only a validated structured `task_done`
   transition changes the task to `succeeded`.
7. If claim returns an empty array while leases are live, do not exit or invent
   work. Wait until the returned `nextLeaseDeadline` (without busy polling), then
   reconcile. Repeat until the run is terminal.
8. After terminal state and post-processing, run
   `ocr-aggregate --runId <effectiveRunId> --format <format> --strict true`.
   Exit 0 means complete review. Exit 1 means a partial diagnostic report was
   written because at least one file failed. Exit 2 means aggregation was not
   allowed. Any non-zero strict aggregate is the final command failure and must
   not be described as a clean review.
<!-- ORCHESTRATOR-PROTOCOL:END -->

## Per-claim reviewer preparation

For each claim, find `context.files[]` by exact `filePath`; never substitute
another file.

1. If changed lines are at least 50, invoke `ocr-plan` with effective run ID and
   file path, then store valid output under `plans/<safePathKey>.json`.
2. Run `ocr-plan-guidance --runId <effectiveRunId> --path <filePath>`.
3. Resolve `systemRule` from `rulesHit[0].text`, `.message`, then rule docs.
4. Apply `ocr-review-file` with `runId`, `taskId`, `attemptId`, `leaseToken`,
   `leaseDeadline`, `filePath`, `diffFingerprint`, current diff, changed files,
   background, system rule, plan guidance, and ISO time.

## Filter and relocation

After success, filter and relocate only accepted-attempt comments. Filter and
relocation failures are soft and cannot change task status. Do not use legacy
`comments.jsonl` as the schema-1 comment source.

## Present result

Use format from prepare arguments, default `both`. Read artifacts under the
effective run ID. A failed strict aggregate is partial and non-successful.
Optional posting uses `ocr-post-comments --runId <effectiveRunId> ...`.
