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

P1 planned flags are parsed defensively but rejected in P0 with `OCRP-RUN-011`: `--rules`, `--preview` / `-p`, and `--dry-run`. This prevents silent false support until custom rules and preview mode are implemented.

## 4. Architecture

See [`docs/superpowers/specs/2026-06-24-opencodereview-plugin-design.md`](docs/superpowers/specs/2026-06-24-opencodereview-plugin-design.md) §1 for the full diagram.

In brief:

1. `commands/review.md` orchestrates.
2. `bin/ocr-prepare` does deterministic prep → `.ocr-runs/<runId>/context.json`.
3. Optional PLAN: `skills/ocr-plan` runs inline in the main session, writes `plan.json`.
4. For each file, a `ocr-reviewer` subagent (defined in `agents/`) runs in parallel.
   Each subagent uses Read/Glob/Grep + Bash `code_comment` to emit comments.
5. A PostToolUse hook (`hooks/hooks.json`) mirrors Bash tool calls to
   `.ocr-runs/<runId>/events.jsonl` (durable bus) and prints live progress.
6. `bin/ocr-aggregate` reads `comments.jsonl` + `done/` → `report.md` + `report.json`.

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
| Custom rules (.code-review.yaml) | yes | P1 |
| GitHub/GitLab PR posting | no | P1 |

If you want a standalone CLI with your own API key → use OCR. If you want to
review inside an existing Claude Code session → use this plugin.

## 6. Configuration

P0: only built-in rules (copied from OCR `system_rules.json` + `rule_docs/`).

P1 (planned): `.code-review.yaml` at repo root, falling back to
`~/.code-review/rules.yaml`, falling back to built-in.

## 7. Troubleshooting

| Error code | Meaning | Fix |
|---|---|---|
| `OCRP-LOAD-002` | `dist/` missing | `npm run build` |
| `OCRP-RUN-010` | Not in a git repo | `cd` to a repo root |
| `OCRP-RUN-011` | Argument conflict or unsupported P0 flag | Use only one review target and avoid P1 flags such as --rules/--preview/--dry-run |
| `OCRP-RUN-012` | No changes | Stage something or pick a non-trivial range |
| `OCRP-SKILL-040` | PLAN output unparseable | Already downgraded; main review still runs |
| `OCRP-SUB-050/051` | Some subagents did not finish | Report flagged `partial: true` |
| `OCRP-HOOK-060` | Hook failed | Silent; final result unaffected |

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
- `skills/ocr-plan/SKILL.md`, `skills/ocr-review-file/SKILL.md` — prompts only
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
