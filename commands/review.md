---
description: Review the current git diff (workspace / commit / branch range) and produce a structured Markdown report. All LLM reasoning is performed by the host Claude Code session — the plugin only supplies deterministic helpers (diff parsing, rule matching, report rendering).
---

# /open-code-review:review

Run a structured code review over the current git change set. This command is a thin entry point: it instructs the host Claude Code session to follow the workflow defined by the `code-review` skill in this plugin.

## Inputs

The slash command accepts free-form `$ARGUMENTS`. The host session should interpret them as:

- **No args** → workspace mode: review staged + unstaged + untracked changes in the current repo.
- `--commit <sha>` → review a single commit against its parent.
- `--from <ref> --to <ref>` → review the diff between two refs (e.g. PR / branch comparison).
- `--background "..."` → optional business / requirement context to pass into the review.
- `--rule <path>` → optional path to a project-specific rule file.

If `$ARGUMENTS` is ambiguous, ask the user to clarify before running anything.

## Workflow

1. **Gather context** — read the user's request and any `--background` text. If the target is a PR or branch, infer the appropriate `--from` / `--to`.
2. **Parse the diff** — drive the plugin's deterministic helpers (`src/diff/`) via the host Bash / Read tools to enumerate changed files and hunks.
3. **Match rules** — apply per-path rules (CLI flag → repo `.opencodereview/rule.json` → user `~/.opencodereview/rule.json` → built-in defaults) to filter files and attach review guidance.
4. **Review each file** — reason hunk-by-hunk **using the host session's own model**. Do not invoke any external LLM API. Produce line-level `ReviewComment` records (see `src/index.ts` for the schema).
5. **Render report** — call the plugin's Markdown renderer to produce the final report. Group findings by **High / Medium** priority; silently discard **Low**.
6. **Offer fixes** — if the user asked to "review and fix", apply safe, high-confidence fixes via Edit. Otherwise list recommendations and ask before mutating files.

## Output Format

Always end with a Markdown report shaped like:

```markdown
## Code Review Results

**Files reviewed**: N
**Issues found**: X high priority / Y medium priority

### High Priority
- **`path/to/file.ts:42`** — Brief description
  > Recommendation: How to fix

### Medium Priority
- **`path/to/file.ts:88`** — Brief description
  > Recommendation: How to fix (if applicable)
```

If no issues survive filtering, state plainly: `Review complete — no issues found in N files.`

## Constraints

- **Never** call an external LLM HTTP endpoint from this plugin. All reasoning is the host session's responsibility.
- **Never** invent or hardcode API keys, tokens, or model URLs.
- Operate on the current working directory's git repository unless the user supplies an explicit `--repo` override.
- For large diffs, prefer per-file iteration with the host's Bash + Read tools rather than trying to fit everything into one prompt.

See `skills/code-review/SKILL.md` for the full skill specification this command delegates to.
