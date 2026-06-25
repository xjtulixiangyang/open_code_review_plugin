---
description: |
  Run the open-code-review-plugin code review on a git change set. Pass-through
  flags align with alibaba/open-code-review CLI: workspace (default), --staged,
  --commit <sha>, --from <a> --to <b>, --paths, --background, --rules.
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

Capture the stdout JSON. It contains `runId`, `fileCount`, `hunkCount`, `changedLines`, `contextPath`.

If `fileCount` is 0 → tell the user "No changes to review." and stop.
If the command exits non-zero → surface the stderr to the user and stop.

### Step 2 — Plan (only when changedLines > 50)

If `changedLines > 50`:

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

For each file in `context.files[]`:

1. Compute `planGuidance` — if `plan.json` exists, extract the issues whose `description`, `tool_guidance.arguments`, or `tool_guidance.reason` mention this file's path, plus any with `file_hint == path`. Format as a Markdown bullet list sorted high→medium→low. If empty, use "".
2. Dispatch a `ocr-reviewer` subagent (via the Task tool) with a prompt containing exactly:

   ```
   runId: <runId>
   subagent: reviewer-<index>
   currentFilePath: <path>
   currentFileDiff:
   <fenced diff block>
   changeFiles: <comma-joined list>
   requirementBackground: <background or "">
   systemRule:
   <contents of assets/rule_docs/<rulesHit[0].docPath> verbatim>
   planGuidance:
   <planGuidance string or "">
   currentSystemDateTime: <ISO-8601>
   ```

Cap concurrency at 8 (override with the `--concurrency <n>` flag in $ARGUMENTS).

### Step 4 — Aggregate

After all reviewer subagents return (each ends with `done: <path>`), run Bash:

```bash
ocr-aggregate --runId <runId>
```

The stdout JSON contains `reportMd`, `reportJson`, `partial`, `partialFiles`.

### Step 5 — Present to user

Read `.ocr-runs/<runId>/report.md` and reply with its full contents inline. Also tell the user where the artifacts live:

- `<repo>/.ocr-runs/<runId>/report.md`
- `<repo>/.ocr-runs/<runId>/report.json`
- `<repo>/.ocr-runs/<runId>/comments.jsonl`

If `partial == true`, prefix your message with: `⚠️ Some files did not complete review; see Warnings section.`

## Error handling

| Error code | What to do |
|---|---|
| OCRP-LOAD-002 | "Plugin not built — please run `npm run build` in the plugin directory." |
| OCRP-RUN-010 | "Not a git repository at `<cwd>`. Run `/review` inside a git repo." |
| OCRP-RUN-011 | "Argument conflict: <message>. Use only one of --staged / --commit / --from..--to." |
| OCRP-RUN-012 | "No changes to review." (exit 0) |
| OCRP-SKILL-040 | Continue without plan_guidance; mention in the final report. |
| OCRP-SUB-050/051 | Already surfaced by `ocr-aggregate` as partial. |
| OCRP-HOOK-060 | Silent; jsonl bus still works. |
