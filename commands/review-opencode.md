---
description: |
  Run the open-code-review-plugin code review on a git change set. Pass-through
  flags align with alibaba/open-code-review CLI: workspace (default), --staged,
  --commit <sha>, --from <a> --to <b>, --paths, --background, --rules.
argument-hint: "[workspace|staged|<sha>|<from>..<to>] [--background \"...\"]"
allowed-tools: read, glob, grep, bash, write
---

# /review — open-code-review-plugin (OpenCode)

Run a code review on the current git change set.

**⚠️ OpenCode does not support parallel subagent dispatch.** Review runs
sequentially — one file at a time. For large changesets with many files,
consider narrowing scope with `--paths <glob>` or `--rules` include patterns.

## Workflow

You are orchestrating a code review. Follow these steps in order.

### Step 1 — Prepare

Run bash:

```bash
ocr-prepare $ARGUMENTS
```

Capture the stdout JSON. It contains `runId`, `fileCount`, `hunkCount`,
`changedLines`, `contextPath`, `concurrency`, `preview`, `dryRun`, `resumed`,
`remainingFileCount`, `rulesSource`, `excludedFileCount`, and `fileCountWarning`.
If `concurrency` is absent, use `2`.

If `fileCount` is 0 → tell the user "No changes to review." and stop.
This is a successful skipped review, not a hard failure.
If the command exits non-zero → surface the stderr to the user and stop.

If `fileCountWarning == true` → warn the user:
"⚠️ This review spans <fileCount> files. OpenCode reviews files sequentially
(no parallel dispatch). Consider narrowing scope with `--paths <glob>` or
`--rules` include patterns. Proceeding with review of all <fileCount> files."

If `preview == true` or `dryRun == true`:
1. Read `.ocr-runs/<runId>/context.json`.
2. Reply with a preview summary and stop. Do not continue to later steps.

The preview format mirrors the Claude Code command: a Markdown table listing
files with their status, hunk count, changed lines, and matching rule.

### Step 2 — Plan (only when changedLines >= 50)

If `changedLines >= 50`:
1. Read `.ocr-runs/<runId>/context.json`.
2. Invoke the `ocr-plan` skill with runId.
3. Parse the fenced ```json PlanOutput.
4. Write to `.ocr-runs/<runId>/plan.json`.

If parsing fails, continue without plan guidance and mention `OCRP-SKILL-040`.

### Step 3 — Review files sequentially

Process `context.files[]` **one at a time, in order**. There is no batching
or concurrent dispatch in OpenCode.

For **each** file:

0. Skip files where `skipped === true`; mention them in the final report
   under "Skipped files" with their path and skipReason. Do not review.

1. **planGuidance** — If `.ocr-runs/<runId>/plan.json` exists, run:
   ```bash
   ocr-plan-guidance --runId <runId> --path <currentFilePath>
   ```
   Parse stdout and use its `guidance` field. On failure, set guidance to ""
   and mention `OCRP-SKILL-040`.

2. **systemRule** — Compute from `context.files[].rulesHit[0]`:
   - If `rulesHit[0].text` is non-empty, use it.
   - Else if `rulesHit[0].message` is non-empty, use it.
   - Else read `assets/rule_docs/<rulesHit[0].docPath>`.
   - Else use empty string and mention `OCRP-RULES-094`.

3. Apply the **ocr-review-file** skill with the current file's diff. Use
   `read` to access `.ocr-runs/<runId>/context.json`. The diff for the
   current file is in `context.files[].diff`.

4. For each confirmed issue, run bash:
   ```bash
   code_comment --runId <runId> --args '{"path":"<currentFilePath>","subagent":"reviewer-<index>","comments":[...]}'
   ```

5. After all comments submitted, run bash:
   ```bash
   task_done --runId <runId> --args '{"subagent":"reviewer-<index>","file":"<currentFilePath>"}'
   ```

6. If the skill invocation errors, retry exactly once for the same file with
   attempt-2 labeling. If both attempts fail, continue to the next file —
   `ocr-aggregate` will report it as partial (`OCRP-SUB-050/051`).

### Step 3.5 — Per-file filter

After each file's review:
1. Read `.ocr-runs/<runId>/comments.jsonl`, select this file's comments.
2. If zero comments, skip filter for this file.
3. Invoke `ocr-review-filter` skill with: runId, subagent `filter-<index>`,
   currentFilePath, currentFileDiff, requirementBackground, systemRule,
   planGuidance, candidateComments.
4. Capture fenced ```json FilterFileResult.
5. Run:
   ```bash
   ocr-filter-apply --runId <runId> --path <currentFilePath> --input '<json>' --subagent filter-<index>
   ```
6. On parse error or apply non-zero → soft failure, mention `OCRP-FILTER-070`.

### Step 3.6 — Line relocation

After filter:
1. If zero visible comments, skip.
2. Run:
   ```bash
   ocr-relocate-apply --runId <runId> --path <currentFilePath>
   ```
3. Non-zero → retry once. Second failure → soft failure (`OCRP-RELOCATE-080`).

### Step 4 — Aggregate

After all files complete:

```bash
ocr-aggregate --runId <runId> --format both
```

Stdout JSON contains `reportMd`, `reportJson`, `partial`, `partialFiles`,
`rawCommentCount`, `commentCount`, `filteredCommentCount`, `filterWarnings`,
`relocationWarnings`.

### Step 5 — Present to user

Read `.ocr-runs/<runId>/report.md` and reply with its full contents inline.
Also tell the user artifact paths.

If `partial == true`, prefix: `⚠️ Some files did not complete review; see Warnings section.`

### Step 6 — Post to PR (optional)

If the user requests posting:
```bash
ocr-post-comments --runId <runId> --provider <github|gitlab> --pr <number>
```
Use `--dry-run` to preview without posting. Use `--retry 1` for single retry.

Comments are posted as inline review comments with multi-level fallback.

## Error handling

| Error code | What to do |
|---|---|
| OCRP-LOAD-002 | "Plugin not built — run `npm run build`." |
| OCRP-RUN-010 | "Not a git repository." |
| OCRP-RUN-011 | "Argument conflict or unsupported flag." |
| OCRP-RUN-012 | "No changes to review." (exit 0) |
| OCRP-SKILL-040 | Continue without plan guidance. |
| OCRP-SUB-050/051 | Surfaced by ocr-aggregate as partial. |
| OCRP-HOOK-060 | Silent — events.jsonl not available on OpenCode. |
| OCRP-FILTER-070 | Continue without filtering that file. |
| OCRP-FILTER-071 | Path outside review context; soft failure. |
| OCRP-FILTER-072 | Malformed filter decisions; soft failure. |
| OCRP-RELOCATE-080 | Relocation failed; use original line ranges. |
| OCRP-RELOCATE-081/082 | Relocation path/datum error; soft failure. |
| OCRP-RULES-090/091/092/093 | Custom rules error; stop. |
| OCRP-RULES-094 | Rule text not loaded; continue with empty rule. |
