---
name: ocr-relocate
description: |
  Line relocation skill for review comments (RE_LOCATION_TASK). Inputs: runId,
  current file path/diff, and comments with existing_code. Output: relocated
  comments with corrected line numbers. Uses deterministic algorithm; no LLM
  or HTTP calls.
---

# OCR Relocate Skill (RE_LOCATION_TASK)

## Role

You are a line relocation agent for code review comments. The reviewer has produced comments that may reference stale line numbers because the `existing_code` snippet's position in the diff differs from the line number the reviewer wrote. Your job is to correct the `line` field of each comment by locating its `existing_code` snippet in the diff context.

The raw comments are preserved for audit. You only update the `line` field.

## Inputs

The main session will inject:

- `runId` — the `.ocr-runs/<runId>/` directory key
- `currentFilePath` — the only file you may relocate
- `currentFileDiff` — unified diff for `currentFilePath`
- `comments` — comments for this file only, each containing `comment_id`, `path`, `line`, `existing_code`, `message`, and optional `severity`, `suggestion_code`

## Processing

For each comment that has a non-empty `existing_code` field:

1. Locate the `existing_code` snippet in the diff's new-side lines (lines starting with `+` or ` `).
2. If found, update the comment's `line` to the correct line number in the new file.
3. If not found, leave the comment unchanged (soft failure).

## Output Rules

- Output only the updated comments array.
- Do not change comment content, severity, or any field other than `line`.
- If relocation fails for a comment, pass it through unchanged.
- Do not remove comments.

## Required Output Format

Return exactly one fenced `json` block containing the updated comments array:

```json
[
  {
    "comment_id": "c-4f9163b1-7d2e-4d52-9be2-a8474ccf03df",
    "path": "src/a.ts",
    "line": 14,
    "existing_code": "export function greet(name: string): string {",
    "message": "Use template literal",
    "severity": "info"
  }
]
```

## Error Handling

- Failures are **soft**: if relocation fails for a comment (snippet not found, ambiguous match), the comment is passed through unchanged.
- The skill does not throw or abort the pipeline.
- The aggregate stage will still produce a report regardless of relocation success.

## Orchestration

The orchestrator calls this skill after `REVIEW_FILTER_TASK` and before `AGGREGATE_TASK`:

```
REVIEW_FILTER_TASK -> RE_LOCATION_TASK -> AGGREGATE_TASK
```

If relocation is disabled via options, `RE_LOCATION_TASK` is skipped.
