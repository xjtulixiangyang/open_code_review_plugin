---
description: |
  Run the open-code-review-plugin code review on a git change set. Pass-through
  flags align with alibaba/open-code-review CLI: workspace (default), --staged,
  --commit <sha>, --from <a> --to <b>, --paths, --background, --rules, --plans.
argument-hint: "[workspace|staged|<sha>|<from>..<to>] [--background \"...\"]"
---

# /review — open-code-review-plugin

Run a code review on the current git change set using the host's agent loop.

## Workflow

You are orchestrating a code review. Follow these steps in order.

### Step 1 — Prepare

Run Bash:

```bash
ocr-prepare $ARGUMENTS
```

Capture the stdout JSON. It contains `runId`, `fileCount`, `hunkCount`, `changedLines`, `contextPath`, `concurrency`, `preview`, `dryRun`, `resumed`, `remainingFileCount`, `rulesSource`, `plansGuidanceSource`, `excludedFileCount`, and `fileCountWarning`. If `concurrency` is absent because an older build produced the summary, use `2`.

If `fileCount` is 0 → tell the user "No changes to review." and stop. This is a successful skipped review, not a hard failure.
If the command exits non-zero → surface the stderr to the user and stop.

If `fileCountWarning == true` → warn the user: "⚠️ This review spans <fileCount> files, which may exceed the host orchestrator's context limit. Consider narrowing scope with `--paths <glob>` or `--rules` include patterns, or run multiple smaller reviews. Proceeding with review of all <fileCount> files." Do not stop — let the user decide.

If `preview == true` or `dryRun == true`:

1. Read `.ocr-runs/<runId>/context.json`.
2. Reply with a preview summary and then stop. Do not run Step 2, Step 3, Step 3.5, Step 3.6, or Step 4.
3. Use this exact structure:

   ```md
   ## Review Preview

   **Run**: `<runId>`  
   **Range**: `<context.range>`  
   **Mode**: `` `preview` `` when only preview is true, `` `dry-run` `` when only dryRun is true, or `` `preview + dry-run` `` when both are true.  
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

### Step 2 — Plan (only when changedLines >= 50)

If `changedLines >= 50`:

1. Read `.ocr-runs/<runId>/context.json` to load the ReviewContext.
2. Invoke the `ocr-plan` skill with the runId. Its output should be a fenced ```json block containing PlanOutput.
3. Parse the JSON. If parsing fails, set `planMissing = true` and continue (downgrade per OCRP-SKILL-040).
4. If parsing succeeds, run Bash to write the plan:
   ```bash
   node -e "import('node:fs/promises').then(fs=>fs.writeFile('.ocr-runs/<runId>/plan.json', process.argv[1]))" '<the json string>'
   ```
   (Or write it via the Write tool to `.ocr-runs/<runId>/plan.json`.)

Otherwise skip this step.

### Step 3 — Dispatch reviewer subagents in parallel

Process `context.files[]` in bounded batches. Let `reviewConcurrency = prepareSummary.concurrency || 2`. Dispatch at most `reviewConcurrency` reviewer subagents at the same time. Do not start the next batch until every file in the current batch has either completed review or exhausted its retry attempts. The stable default is `2`; when a run hits API 503s, reviewer timeouts, or many partial files, rerun with `--concurrency 1`.

For each file in a batch:

0. Skip files where `skipped === true`; mention them in the final report under a "Skipped files" section with their path and skipReason. Do not dispatch a reviewer for these files.

1. Compute `planGuidance` deterministically. Run:
   ```bash
   ocr-plan-guidance --runId <runId> --path <currentFilePath>
   ```
   Parse stdout JSON and use its `guidance` field. The returned `guidance` may include both file-specific PLAN output and repository/user custom plans guidance loaded via `--plans`, `.code-review-plans.md`, or `~/.code-review/plans.md`. If the command fails, set `planGuidance = ""` and mention `OCRP-SKILL-040` in the final report. Do not manually re-implement plan filtering in the main conversation.
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
4. Retry reviewer dispatch exactly once for the same file when any of these happens:
   - the subagent errors;
   - the subagent times out;
   - the subagent returns but no matching `.ocr-runs/<runId>/done/reviewer-*.json` entry exists for that file.
   Use `reviewer-<index>-attempt-2` for the retry subagent id. Do not retry a file after `task_done` is recorded.
5. If both attempts fail, continue to the next file and let `ocr-aggregate` report the file as partial (`OCRP-SUB-050/051`). A partial file means review did not complete for that file; it must not be described as a clean no-issue result.

### Step 3.5 — Per-file filter (REVIEW_FILTER_TASK)

After each file's reviewer subagent returns, run the filter stage for that file:

1. Read `.ocr-runs/<runId>/comments.jsonl` and select comments where `path == currentFilePath`, keeping `comment_id`.
2. If the file has zero comments, skip filter for this file.
3. Otherwise invoke the `ocr-review-filter` skill with exactly: runId, subagent `filter-<index>`, currentFilePath, currentFileDiff, requirementBackground, systemRule, planGuidance, and candidateComments.
4. Capture the skill's fenced ```json output. It must be a FilterFileResult without `_meta`.
5. Run Bash:
   ```bash
   ocr-filter-apply --runId <runId> --path <currentFilePath> --input '<json string>' --subagent filter-<index>
   ```
6. If the skill output is unparseable, treat it as a soft failure: continue without filtering this file and mention `OCRP-FILTER-070` in the final report.
7. If `ocr-filter-apply` exits non-zero, retry the exact same `ocr-filter-apply` command once. If the second attempt also exits non-zero, continue without filtering this file and mention `OCRP-FILTER-070` in the final report.

### Step 3.6 — Line relocation (RE_LOCATION_TASK)

After each file's filter stage completes, run the line relocation stage for that file:

1. If the file has zero visible comments, skip relocation for this file.
2. Otherwise run:
   ```bash
   ocr-relocate-apply --runId <runId> --path <currentFilePath>
   ```
3. The command reads `context.json` for the file's diff, reads `comments.jsonl` and `filters/`, and writes relocation decisions to `.ocr-runs/<runId>/relocations/<safePathKey>.json`.
4. If `ocr-relocate-apply` exits non-zero, retry the exact same command once. If the second attempt also exits non-zero, treat it as a soft failure: continue without relocating this file and mention `OCRP-RELOCATE-080` in the final report.
5. If deterministic relocation reports fallback comments, optionally invoke the `ocr-relocate` skill for those comments and apply the returned decisions.

Relocation is deterministic and does not require an LLM call. Failures are soft; aggregate will use original line ranges.

### Step 4 — Aggregate

After all reviewer subagents return (each ends with `done: <path>`), run Bash:

```bash
ocr-aggregate --runId <runId> --format <markdown|json|both>
```

The stdout JSON contains `reportMd`, `reportJson`, `partial`, `partialFiles`, `rawCommentCount`, `commentCount`, `filteredCommentCount`, `filterWarnings`, and `relocationWarnings`.

If no format flag was provided to `ocr-prepare`, use `both`.

### Step 5 — Present to user

Read `.ocr-runs/<runId>/report.md` and reply with its full contents inline. Also tell the user where the artifacts live:

- `<repo>/.ocr-runs/<runId>/report.md`
- `<repo>/.ocr-runs/<runId>/report.json`
- `<repo>/.ocr-runs/<runId>/comments.jsonl`
- `<repo>/.ocr-runs/<runId>/filters/` (when any comments were filtered)

If `partial == true`, prefix your message with: `⚠️ Some files did not complete review; see Warnings section.` Do not summarize the run as "no issues found" without also saying the review was incomplete for `partialFiles[]`.

### Step 6 — Post to PR (optional)

If the user requests posting review comments to a PR:

1. Run Bash:
   ```bash
   ocr-post-comments --runId <runId> --provider <github|gitlab> --pr <number>
   ```
2. Comments are posted as **inline review comments** on the diff (GitHub
   `pulls.createReview`, GitLab Discussions API). A multi-level fallback
   strategy is used: batch inline review → individual inline → plain
   PR/MR comment.
3. Use `--dry-run` to preview the comments that would be posted without
   calling the platform API.
4. Use `--retry <n>` to set the per-comment retry count (default: 1).
5. The stdout JSON contains `posted`, `failed`, `skipped`, and `details`.
   Reply with a summary.

## Error handling

| Error code | What to do |
|---|---|
| OCRP-LOAD-002 | "Plugin not built — please run `npm run build` in the plugin directory." |
| OCRP-RUN-010 | "Not a git repository at `<cwd>`. Run `/review` inside a git repo." |
| OCRP-RUN-011 | "Argument conflict or unsupported flag: <message>. Use only one review target." |
| OCRP-RUN-012 | "No changes to review." (exit 0) |
| OCRP-SKILL-040 | Continue without plan_guidance; mention in the final report. |
| OCRP-SUB-050/051 | Already surfaced by `ocr-aggregate` as partial. |
| OCRP-HOOK-060 | Silent; jsonl bus still works. |
| OCRP-FILTER-070 | Continue without filtering that file; mention the downgrade in the final report. |
| OCRP-FILTER-071 | `ocr-filter-apply` rejected a path outside the review context; treat as filter soft failure in orchestration. |
| OCRP-FILTER-072 | `ocr-filter-apply` rejected malformed filter decisions; treat as filter soft failure in orchestration. |
| OCRP-RELOCATE-080 | `ocr-relocate-apply` failed for a file; aggregate uses original line ranges. |
| OCRP-RELOCATE-081 | Relocation input references path outside review context. |
| OCRP-RELOCATE-082 | Relocation decision malformed. |
| OCRP-RULES-090/091/092/093 | Custom rule file cannot be read, parsed, or validated; surface stderr from `ocr-prepare` and stop. |
| OCRP-RULES-094 | Effective rule text could not be loaded for a file; continue with an empty rule and mention in final report. |
