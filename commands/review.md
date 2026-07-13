---
description: |
  Run the open-code-review-plugin code review on a git change set. Pass-through
  flags align with alibaba/open-code-review CLI: workspace (default), --staged,
  --commit <sha>, --from <a> --to <b>, --paths, --background, --rules, --plans.
argument-hint: "[workspace|staged|<sha>|<from>..<to>] [--background \"...\"]"
---

# /review — open-code-review-plugin

Run a code review through the deterministic pull orchestrator. The TypeScript
orchestrator, not this command, owns the file set, attempts, retries, leases,
and completeness decision.

## Prepare and preview

1. Run `ocr-prepare $ARGUMENTS` and parse its JSON as `prepareSummary`.
2. If it fails, surface stderr and stop. If `fileCount == 0`, report "No changes to review." and stop successfully.
3. If `preview` or `dryRun` is true, read the candidate `context.json`, present the existing preview table (file, status, hunks, changed lines, rule, exclusions), and stop.
4. Run `ocr-orchestrator-start --runId <prepareSummary.runId>` and parse its JSON. Replace the working `runId` with `effectiveRunId` for every later command and artifact read. Read `.ocr-runs/<effectiveRunId>/context.json`.

`reviewConcurrency = prepareSummary.concurrency || 2`. Claude Code may dispatch
at most this many claimed reviewers concurrently. Keep the existing 5-second
batch cooldown, extended to 10 seconds after 503/timeouts.

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

For each claim, find `context.files[]` by exact `filePath` and verify its computed
fingerprint is represented by the claim; do not substitute another file.

1. If changed lines for this file are at least 50, invoke `ocr-plan` with
   `runId: <effectiveRunId>` and `currentFilePath: <filePath>`, and write valid
   output to `.ocr-runs/<effectiveRunId>/plans/<safePathKey>.json`.
2. Run `ocr-plan-guidance --runId <effectiveRunId> --path <filePath>`; use empty
   guidance and record `OCRP-SKILL-040` on soft failure.
3. Resolve `systemRule` from `rulesHit[0].text`, then `.message`, then
   `assets/rule_docs/<docPath>`, otherwise empty with `OCRP-RULES-094`.
4. Dispatch `ocr-reviewer` with: `runId`, `taskId`, `attemptId`, `leaseToken`,
   `leaseDeadline`, `filePath`, `diffFingerprint`, `currentFileDiff`,
   `changeFiles`, `requirementBackground`, `systemRule`, `planGuidance`, and
   current ISO time. Do not include a host-selected attempt number.

## Filter and relocation

After a task succeeds, process only comments from its accepted attempt. Invoke
`ocr-review-filter` for visible candidate comments, then apply decisions with
`ocr-filter-apply`. Run `ocr-relocate-apply` for visible comments. These are soft
failures (`OCRP-FILTER-070`, `OCRP-RELOCATE-080`) and cannot change task success.
Never read stale/failed-attempt comments from legacy `comments.jsonl` for a
schema-1 run.

## Present result

Use format from the prepare arguments, defaulting to `both`. Read requested
artifacts under `.ocr-runs/<effectiveRunId>/`. On complete success, present the
Markdown report. On failed strict aggregation, clearly label it partial and
list failed files/reasons; do not say "no issues found". Optional PR posting
continues to use `ocr-post-comments --runId <effectiveRunId> ...`.
