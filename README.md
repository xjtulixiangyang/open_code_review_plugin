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
| `--concurrency <n>` | same | 8 | Instructs command orchestration to dispatch at most N reviewers |
| `--format markdown|json|both` | `--format` | both | Controls aggregate artifacts |

`--rules <path>` (alias `--rule`), `--preview` / `-p`, and `--dry-run` are supported. See §6 (Custom rules) and §7 (Preview and dry-run).

## 4. Architecture

See [`docs/superpowers/specs/2026-06-24-opencodereview-plugin-design.md`](docs/superpowers/specs/2026-06-24-opencodereview-plugin-design.md) §1 for the full diagram.

In brief:

1. `commands/review.md` orchestrates.
2. `bin/ocr-prepare` does deterministic prep → `.ocr-runs/<runId>/context.json`.
3. Optional PLAN: `skills/ocr-plan` runs inline in the main session, writes `plan.json`.
4. For each file, a `ocr-reviewer` subagent (defined in `agents/`) runs in parallel.
   Each subagent uses Read/Glob/Grep + Bash `code_comment` to emit comments.
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

Place a `.code-review.yaml` (or `.code-review.yml`, or `.code-review.json`) at
your repo root. The first existing file wins; rules, `include`, and `exclude`
are not merged across files.

```yaml
rules:
  - path: "src/**/*.ts"
    rule: "Focus on type safety, async error handling, and boundary conditions."
include:
  - "src/**/*.ts"
exclude:
  - "**/*.test.ts"
```

- `rules[].path` supports `**` / `*` / `?` / `{a,b}` globs; first match wins.
- `include` / `exclude` control which changed files enter the review scope. When `include` is set, only matching files are reviewed and default excludes (test files, etc.) are skipped for them.
- When no custom rule matches a file, the built-in `system_rules.json` + `rule_docs/` apply.

Override or point at a one-off rule file with `--rules <path>` (alias `--rule <path>`):

```
/open-code-review:review --rules ./ci-rules.yaml
```

Rule file errors are hard failures (`OCRP-RULES-090`…`093`) — they do not silently fall back to defaults.

## 7. Preview and dry-run

Inspect what would be reviewed without invoking Claude Code subagents.

- `--preview` (alias `-p`): prints which files would be reviewed, their rule source, and which files are excluded and why. Writes no artifacts.
- `--dry-run`: same no-LLM preparation, but writes `.ocr-runs/<runId>/context.json` and `.ocr-runs/<runId>/preview.json` for CI and scripting.

```
/open-code-review:review --preview
/open-code-review:review --dry-run
```

`--preview` and `--dry-run` are mutually exclusive. Neither runs plan, reviewer, filter, relocation, or aggregate.

## 8. Troubleshooting

| Error code | Meaning | Fix |
|---|---|---|
| `OCRP-LOAD-002` | `dist/` missing | `npm run build` |
| `OCRP-RUN-010` | Not in a git repo | `cd` to a repo root |
| `OCRP-RUN-011` | Argument conflict or unsupported P0 flag | Use only one review target and avoid P1 flags such as --rules/--preview/--dry-run |
| `OCRP-RUN-012` | No changes | Stage something or pick a non-trivial range |
| `OCRP-RULES-090` | Custom rule file missing/unreadable | Fix the `--rules` path or `.code-review.yaml` |
| `OCRP-RULES-091` | Rule file JSON/YAML parse failure | Fix the syntax |
| `OCRP-RULES-092` | Rule file root is not an object | Use a mapping/object root |
| `OCRP-RULES-093` | Invalid rule entry or include/exclude | Ensure rules have string `path`/`rule`, and include/exclude are string arrays |
| `OCRP-SKILL-040` | PLAN output unparseable | Already downgraded; main review still runs |
| `OCRP-SUB-050/051` | Some subagents did not finish | Report flagged `partial: true` |
| `OCRP-HOOK-060` | Hook failed | Silent; final result unaffected |
| `OCRP-FILTER-070` | Filter stage failed | Review continues without filtering that file |
| `OCRP-FILTER-071` | Filter path outside review context | Check filter input path |
| `OCRP-FILTER-072` | Invalid filter decision JSON | Ensure each hide decision has `comment_id`, `action: "hide"`, and `reason` |
| `OCRP-RELOCATE-080` | Relocation failed for a file | Review continues with original line ranges |
| `OCRP-RELOCATE-081` | Relocation path outside context | Check relocation input path |
| `OCRP-RELOCATE-082` | Malformed relocation decision | Check relocation audit format |

## 9. Development

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

## 10. License

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
