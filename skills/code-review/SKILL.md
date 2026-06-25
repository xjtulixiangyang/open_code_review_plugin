---
name: code-review
description: >
  Perform a structured code review over the current git change set
  (workspace / single commit / branch range) and produce a Markdown
  report. Use when the user asks to "review code", "review this PR",
  "review my changes", "review commit <sha>", or "compare branches for
  issues". All language-model reasoning is performed by the host
  Claude Code session — this skill provides deterministic helpers
  (diff parsing, rule matching, report rendering) and a fixed workflow.
license: Apache-2.0
metadata:
  author: open-code-review-plugin contributors
  homepage: https://github.com/alibaba/open-code-review
  version: "0.1.0"
---

# Code Review Skill

This skill re-implements the spirit of [alibaba/open-code-review](https://github.com/alibaba/open-code-review) as a Claude Code plugin. Unlike the original `ocr` CLI, **this plugin does not call any external LLM**. The host Claude Code session is the model.

## Prerequisites

- The current working directory is a git repository (or `--repo <path>` is supplied).
- The host session has `Bash`, `Read`, `Grep`, and `Edit` tools available.
- The plugin has been built (`npm run build` produced `dist/index.mjs`). If `dist/` is missing, instruct the user to run `npm run build` in the plugin directory.

Do **not** check for an `ocr` binary or any LLM environment variable — this plugin replaces both.

## Inputs

The skill accepts these argument shapes (parsed from `$ARGUMENTS` or the user's natural-language request):

| Shape | Meaning |
|---|---|
| _(empty)_ | Workspace mode: review staged + unstaged + untracked changes |
| `--commit <sha>` | Review a single commit vs. its parent |
| `--from <ref> --to <ref>` | Review the diff between two refs |
| `--background "<text>"` | Optional business / requirement context |
| `--rule <path>` | Optional override for the rule file |
| `--repo <path>` | Override the repo root (default: cwd) |

Free-form requests like "review the last commit" or "review my feature branch against main" should be mapped to these shapes before proceeding.

## Workflow

### Step 1 — Discover the change set

Use Bash to run the appropriate `git` commands inside the target repo:

- **Workspace mode**: `git diff HEAD --name-status` + `git ls-files --others --exclude-standard`
- **Commit mode**: `git show --name-status <sha>` and `git diff <sha>^..<sha>`
- **Range mode**: `git diff --name-status <from>..<to>` and `git diff <from>..<to>`

Then read raw diff text for each changed file.

### Step 2 — Parse hunks

Import the plugin's deterministic helpers from `dist/index.mjs` (or call them indirectly through the slash command). The exported `DiffEntry` / `ReviewComment` / `ReviewReport` shapes in `src/index.ts` define the schema the report renderer expects.

### Step 3 — Match rules

Resolve rules in this priority order (highest first):

1. `--rule <path>`
2. `<repo>/.opencodereview/rule.json`
3. `~/.opencodereview/rule.json`
4. Built-in defaults bundled with the plugin

The rule file format is identical to the upstream project:

```json
{
  "rules": [
    { "path": "**/*.ts", "rule": "All new exports must have JSDoc." },
    { "path": "**/*sql*", "rule": "Check for injection risk and missing closing tags." }
  ]
}
```

Files that match no rule and are not source code (lock files, generated artefacts, vendored bundles) should be skipped.

### Step 4 — Review each file

For every surviving `DiffEntry`:

1. Read the current file content if it still exists (`Read` tool).
2. Reason about the hunks **in this session** — use the rule text + the optional `--background` as the prompt. The host model is the reviewer; do not delegate to any external API.
3. Emit zero or more `ReviewComment` records with:
   - `path`, `startLine`, `endLine` (1-based, inclusive; both `0` means "position not found")
   - `severity` ∈ `'high' | 'medium' | 'low'`
   - `summary` (one short sentence), `detail` (multi-line analysis)
   - `suggestion` (optional fix snippet), `existingCode` (optional original snippet)

Severity rubric:

- **High** — obvious bugs, security flaws, breakages, mis-implementations with a precise fix.
- **Medium** — defensible concerns, style/perf issues, or fixes that need human judgement.
- **Low** — nitpicks, low-confidence guesses, items lacking enough context. **Drop silently.**

### Step 5 — Render the report

Aggregate the kept comments into a `ReviewReport` and produce Markdown shaped like:

```markdown
## Code Review Results

**Files reviewed**: N
**Issues found**: X high priority / Y medium priority

### High Priority
- **`path/to/file.ts:42`** — One-line summary
  > Recommendation: How to fix

### Medium Priority
- **`path/to/file.ts:88`** — One-line summary
  > Recommendation: How to fix (if applicable)
```

If nothing survives filtering, output: `Review complete — no issues found in N files.`

### Step 6 — Offer fixes

- If the user said "review and fix" (or similar), apply safe, well-defined fixes via `Edit`. Verify each edit shows up cleanly.
- If the user only asked to review, **list** recommendations and ask before mutating files.
- For mis-located comments (`startLine == endLine == 0`), Read the target file, locate the relevant section, and apply the fix there.

## Output Schema

The plugin's TypeScript surface (`src/index.ts`) commits to these types. Subsequent SDD stages may refine them but the public shape is stable:

```ts
interface DiffEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  diff: string;
  newContent?: string;
  insertions: number;
  deletions: number;
}

interface ReviewComment {
  path: string;
  startLine: number;
  endLine: number;
  severity: 'high' | 'medium' | 'low';
  summary: string;
  detail: string;
  suggestion?: string;
  existingCode?: string;
}

interface ReviewReport {
  summary: {
    filesReviewed: number;
    issuesFound: number;
    highPriority: number;
    mediumPriority: number;
    lowPriority: number;
  };
  comments: ReviewComment[];
  rawMarkdown: string;
}
```

## Constraints

- **No external LLM calls.** Ever. The whole point of the plugin form is that the host session is the model.
- **No invented credentials.** If a user asks to "configure the LLM", explain that the plugin uses the host session and no setup is required.
- **No silent truncation.** If a file's diff is too large to reason about in one pass, iterate hunk-by-hunk.
- **Don't review generated files** unless the user explicitly asks (lockfiles, `dist/`, vendored libs).

## References

- Plugin manifest: `.claude-plugin/plugin.json`
- Slash command: `commands/review.md`
- TypeScript entry: `src/index.ts` → built to `dist/index.mjs`
- Upstream project: https://github.com/alibaba/open-code-review
