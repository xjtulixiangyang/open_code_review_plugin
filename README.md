# open-code-review-plugin

> Claude Code plugin that reuses [alibaba/open-code-review](https://github.com/alibaba/open-code-review)
> review semantics, delegates all LLM reasoning to the **host Claude Code agent loop**,
> and ships zero LLM provider configuration.

## 1. Why this plugin?

`open-code-review` (OCR) is a Go CLI that performs AI code review on git diffs.
It does excellent deterministic engineering (diff parsing, rule matching) but
**brings its own LLM client and requires you to configure an API key**.

This plugin keeps the deterministic core (diff parsing, rule matching, report
rendering) and delegates **every model decision** to your Claude Code session.
No API key, no `OCR_LLM_*` env vars, no separate binary — just install and run
`/open-code-review:review`.

## 2. Quickstart

```bash
git clone <this-repo>
cd open-code-review-plugin
npm install
npm run build
claude --plugin-dir "$(pwd)"
```

Inside Claude Code:

```
/open-code-review:review HEAD~3 -b "fixing user signup race"
```

## 3. Commands

`/open-code-review:review [target] [flags]` — argument forms align with OCR CLI:

| Target | Meaning |
|---|---|
| `workspace` (default) | tracked + untracked changes |
| `staged` | only staged (index) |
| `<sha>` or `--commit <sha>` | single commit vs its parent |
| `<from>..<to>` or `--from <a> --to <b>` | range |

| Flag | Equivalent OCR flag | Default | P0 behavior |
|---|---|---|---|---|
| `-b, --background "ctx"` | same | "" | Injected into reviewer prompt |
| `--paths "g1,g2"` | include/path filter | — | Limits changed files before review |
| `--concurrency <n>` | same | 2 | Controls how many file reviewer subagents are dispatched at once. Default is `2` for stability. Values above `8` are capped to `8`. |
| `--format markdown|json|both` | `--format` | both | Controls aggregate artifacts |
| `--preview`, `-p` | same | false | Show review preview without running review. Does not call PLAN, reviewer, filter, relocate, or aggregate. |
| `--dry-run` | same | false | Same as --preview. Sets `dryRun: true` in the review context for future tooling integration. |
`--preview`, `-p`, and `--dry-run` run deterministic prepare only. They show the review range, files that would be reviewed, excluded files, matched rule IDs, rules source, and concurrency. Preview/dry-run mode does not call the PLAN skill, reviewer subagents, filter, relocate, or aggregate, and it does not generate formal `report.md` / `report.json` artifacts.

The `--rules` / `--rule` flag is now fully supported (see Configuration).

## 4. Architecture

See [`docs/superpowers/specs/2026-06-24-opencodereview-plugin-design.md`](docs/superpowers/specs/2026-06-24-opencodereview-plugin-design.md) §1 for the full diagram.

In brief:

1. `commands/review.md` orchestrates.
2. `bin/ocr-prepare` does deterministic prep → `.ocr-runs/<runId>/context.json`.
3. Optional PLAN: `skills/ocr-plan` runs inline in the main session, writes `plan.json`.
4. For each file, a `ocr-reviewer` subagent (defined in `agents/`) runs in parallel.
   Reviewer subagents gather context through the plugin CLIs `file_read`, `file_find`, `code_search`, and `file_read_diff`. These commands load `.ocr-runs/<runId>/context.json`, so commit and range reviews inspect the reviewed git ref rather than whatever happens to be checked out in the workspace. Comments are emitted via Bash `code_comment`.
5. For each file with comments, `skills/ocr-review-filter` can hide false-positive or low-quality comments. `bin/ocr-filter-apply` writes auditable filter results under `.ocr-runs/<runId>/filters/`.
6. For each file with visible comments, `bin/ocr-relocate-apply` normalizes comment line numbers by locating `existing_code` snippets in the diff. Relocation decisions are written under `.ocr-runs/<runId>/relocations/`. This step is deterministic and does not require an LLM call.
7. A PostToolUse hook (`hooks/hooks.json`) mirrors Bash tool calls to
   `.ocr-runs/<runId>/events.jsonl` (durable bus) and prints live progress.
8. `bin/ocr-aggregate` reads `comments.jsonl` + `filters/` + `relocations/` + `done/` → `report.md` + `report.json`.

JSON reports keep OCR-compatible token summary fields, but P0 sets token counters to `0` because this plugin delegates all model calls to the host Claude Code session and does not receive per-call token accounting from a bundled LLM client.

## 5. Comparison with OCR CLI

| Capability | OCR CLI | This plugin |
|---|---|---|
| Diff parsing | Go | TS (algorithm-equivalent) |
| Rule matching | Go + `system_rules.json` | TS, same JSON & rule_docs |
| Plan + Main prompts | Go drives | host Claude Code drives (`/review`) |
| LLM client | bundled | **none** (delegates to host) |
| Per-file concurrency | yes (--concurrency) | yes (subagents) |
| Report formats | text / json | markdown / json / both |
| Review comment filtering | yes | yes (host LLM + `ocr-filter-apply`) |
| Custom rules (.code-review.yaml) | yes | yes |
| GitHub/GitLab PR posting | no | P1 |

If you want a standalone CLI with your own API key → use OCR. If you want to
review inside an existing Claude Code session → use this plugin.

## 6. Configuration

### Custom rules

`/open-code-review:review` supports custom rule files loaded in this priority order:

1. CLI `--rules <path>` / `--rule <path>`
2. Repository `.code-review.yaml`, `.code-review.yml`, or `.code-review.json`
3. User `~/.code-review/rules.yaml`, `~/.code-review/rules.yml`, or `~/.code-review/rules.json`
4. Built-in OCR-compatible system rules under `assets/rule_docs/`

YAML/JSON shape:

```yaml
include:
  - "src/**/*.ts"
exclude:
  - "src/**/*.test.ts"
rules:
  - path: "src/**/*.ts"
    rule: |
      Review TypeScript changes for API compatibility, async error handling,
      and unsafe type assertions.
```

`include` narrows the reviewed file set. `exclude` removes files from the reviewed file set. `rules` are first-match-wins and override the built-in rule text for matching paths.

## 7. Troubleshooting

| Error code | Meaning | Fix |
|---|---|---|
| `OCRP-LOAD-002` | `dist/` missing | `npm run build` |
| `OCRP-RUN-010` | Not in a git repo | `cd` to a repo root |
| `OCRP-RUN-011` | Argument conflict or unsupported flag | Use only one review target |
| `OCRP-RUN-012` | No changes | Stage something or pick a non-trivial range |
| `OCRP-SKILL-040` | PLAN output unparseable | Already downgraded; main review still runs |
| `OCRP-SUB-050/051` | Some subagents did not finish | Report flagged `partial: true` |
| `OCRP-HOOK-060` | Hook failed | Silent; final result unaffected |
| `OCRP-FILTER-070` | Filter stage failed | Review continues without filtering that file |
| `OCRP-FILTER-071` | Filter path outside review context | Check filter input path |
| `OCRP-FILTER-072` | Invalid filter decision JSON | Ensure each hide decision has `comment_id`, `action: "hide"`, and `reason` |
| `OCRP-RELOCATE-080` | Relocation failed for a file | Review continues with original line ranges |
| `OCRP-RELOCATE-081` | Relocation path outside context | Check relocation input path |
| `OCRP-RELOCATE-082` | Malformed relocation decision | Check relocation audit format |

## 8. Development

```bash
npm test          # node --test on all src/**/__tests__/*.test.ts
npm run typecheck # tsc --noEmit
npm run build     # clean + tsc + assets + mjs + bin
npm run smoke     # end-to-end (no Claude Code needed)
```

Directory contract (see spec §2):

- `commands/review.md` — orchestration only
- `agents/ocr-reviewer.md` — subagent definition, locked tool list
- `skills/ocr-plan/SKILL.md`, `skills/ocr-review-file/SKILL.md`, `skills/ocr-relocate/SKILL.md` — prompts only
- `hooks/hooks.json` — declarative hook bindings
- `bin/*` — executables, populated by `npm run build`
- `assets/rule_docs/*.md` — review checklists (copied from OCR; do not edit)
- `src/core/*` — deterministic engine (no host imports)
- `src/host/claude-code/*` — host-specific code
- `src/cli/*` — bin/ entry points

## 9. License

Apache-2.0 (same as OCR upstream). See [LICENSE](LICENSE).

---

### Naming conflict with OCR's own plugin

Both this project and `alibaba/open-code-review` publish a plugin named
`open-code-review` (so the command path `/open-code-review:review` matches).
If you already installed OCR's plugin (`plugins/open-code-review/` in the
`alibaba/open-code-review` repo), uninstall it before installing this one, or
keep only one `--plugin-dir` referencing it. We may rename this plugin to
`open-code-review-cc` in a future marketplace release; for P0 the UX
parity is intentional.
