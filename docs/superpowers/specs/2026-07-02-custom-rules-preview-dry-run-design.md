# Custom Rules, Preview, and Dry Run Design

Date: 2026-07-02
Status: Approved for implementation planning

## Summary

Add local rule customization and no-LLM inspection modes to `open-code-review-plugin` without changing the core architecture: all language-model work remains delegated to the host Claude Code session, and deterministic preparation stays in TypeScript.

This design covers three P1 gaps:

1. Custom review rules from `.code-review.yaml` / `.code-review.yml` / `.code-review.json` or `--rules` / `--rule`.
2. `--preview`, which shows what would be reviewed without invoking Claude Code subagents.
3. `--dry-run`, which writes review-preparation artifacts without invoking Claude Code subagents.

GitHub/GitLab PR posting is intentionally out of scope and will be designed separately.

## Goals

- Support project-local custom rules with a simple YAML/JSON schema.
- Support CLI rule-path override for temporary or CI-specific rule files.
- Allow custom `include` / `exclude` filters to control review scope.
- Keep built-in `system_rules.json` and `rule_docs/` as the fallback behavior.
- Make `--preview` and `--dry-run` safe: they must never invoke plan, reviewer, filter, relocation, or any LLM-backed stage.
- Preserve existing behavior when no custom rule file or new flag is used.

## Non-goals

- GitHub or GitLab PR comment posting.
- OCR global config compatibility via `~/.opencodereview/rule.json`.
- Tool configuration via `--tools`.
- Model or provider selection.
- Preview web UI.
- Full replacement of the upstream Go CLI.

## User-facing behavior

### Custom rule files

The plugin supports these sources, in priority order:

1. CLI path from `--rules <path>` or `--rule <path>`.
2. Repository-local `.code-review.yaml`.
3. Repository-local `.code-review.yml`.
4. Repository-local `.code-review.json`.
5. Built-in rules.

The first existing source wins. Rules, include patterns, and exclude patterns are not merged across sources.

Example YAML:

```yaml
rules:
  - path: "src/**/*.ts"
    rule: "Focus on type safety, async error handling, and boundary conditions."
include:
  - "src/**/*.ts"
exclude:
  - "**/*.test.ts"
```

Equivalent JSON:

```json
{
  "rules": [
    {
      "path": "src/**/*.ts",
      "rule": "Focus on type safety, async error handling, and boundary conditions."
    }
  ],
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts"]
}
```

Rule matching is first-match-wins inside one rule file. If no custom rule matches a reviewed file, the plugin falls back to the existing built-in rule matcher.

### Preview

`/open-code-review:review --preview` and `/open-code-review:review -p` prepare the diff and print a summary of files that would be reviewed. They do not dispatch any Claude Code subagents and do not perform plan, filter, relocation, or aggregate stages.

Preview output includes:

- run ID
- review range
- rules source
- file count
- excluded file count
- hunk count
- changed line count
- included files with status, hunk count, changed line count, rule ID, and rule source
- excluded files with exclusion reason

Preview is intended for quick terminal inspection. It does not need to write the full `context.json` artifact.

### Dry run

`/open-code-review:review --dry-run` performs the same no-LLM preparation as preview, but writes durable artifacts:

- `.ocr-runs/<runId>/context.json`
- `.ocr-runs/<runId>/preview.json`

Dry run is intended for CI, debugging, and scripted inspection. It must not dispatch any Claude Code subagents.

`--preview` and `--dry-run` are mutually exclusive.

## Architecture

### New module: `src/core/rules/custom_rules.ts`

Responsibilities:

- Discover repo-local rule files.
- Load a CLI-specified rule file.
- Parse JSON and YAML.
- Validate the custom rule schema.
- Return normalized custom rule data.

Types:

```ts
export interface CustomRuleEntry {
  path: string;
  rule: string;
}

export interface CustomRuleFile {
  rules?: CustomRuleEntry[];
  include?: string[];
  exclude?: string[];
}

export interface LoadedCustomRules {
  source: string;
  sourceKind: 'cli' | 'repo' | 'none';
  rules: CustomRuleEntry[];
  include: string[];
  exclude: string[];
}
```

### `src/core/rules/matcher.ts`

Extend rule matching from built-in-only to custom-first:

```ts
export interface RuleResolution {
  ruleId: string;
  docPath?: string;
  text: string;
  source: 'custom' | 'system';
}
```

`resolveRule(filePath, customRules)` returns:

- a custom rule when the first matching custom pattern exists;
- otherwise the existing built-in rule document text.

For custom rules, `docPath` is undefined and `text` is the custom rule string. For built-in rules, `docPath` remains the existing rule doc file name.

### `src/core/allowlist/allowed_ext.ts`

Add a scoped file decision function that combines extension allowlist, user include/exclude, and default excludes:

```ts
export type FileScopeReason =
  | 'unsupported-ext'
  | 'user-exclude'
  | 'not-in-include'
  | 'default-exclude'
  | 'ok';

export function isFileInScope(
  filePath: string,
  customRules: LoadedCustomRules | null,
): { allowed: boolean; reason: FileScopeReason };
```

Decision order:

1. Unsupported extension is excluded.
2. User exclude match is excluded.
3. If include exists, only include matches are reviewed.
4. If include matched, default excludes are skipped.
5. Without include, default exclude matches are excluded.
6. Otherwise the file is reviewed.

### `src/core/model/request.ts`

Extend existing types with optional fields only:

```ts
export interface ReviewRequest {
  rulesPath?: string;
  preview?: boolean;
  dryRun?: boolean;
}

export interface ReviewContext {
  rulesSource?: string;
  excludedFiles?: Array<{ path: string; reason: string }>;
  preview?: boolean;
  dryRun?: boolean;
}
```

This is additive and keeps existing consumers compatible.

### `src/core/context/review_context.ts`

Update context building to:

1. Resolve repo root.
2. Load custom rules from CLI path or repo-local config.
3. Collect and parse diff.
4. Filter files through `isFileInScope`.
5. Record excluded files and reasons.
6. Resolve per-file rule using custom-first matching.
7. Store custom rule text in `rulesHit[0].message` when custom rules match.
8. Store built-in rule doc path in `rulesHit[0].docPath` when built-in rules match.

### `src/cli/prepare.ts`

Update argument parsing:

- Accept `--rules <path>`.
- Accept `--rule <path>` as an alias for upstream OCR compatibility.
- Accept `--preview` and `-p`.
- Accept `--dry-run`.
- Reject `--preview` with `--dry-run` using `OCRP-RUN-011`.
- Reject missing values for `--rules` / `--rule` using `OCRP-RUN-011`.

Prepare stdout summary includes:

```ts
{
  runId: string;
  preview?: boolean;
  dryRun?: boolean;
  fileCount: number;
  excludedCount: number;
  hunkCount: number;
  changedLines: number;
  contextPath: string | null;
  previewPath?: string;
  rulesSource?: string;
  files?: Array<{
    path: string;
    status: string;
    hunkCount: number;
    changedLines: number;
    ruleId: string;
    ruleSource: 'custom' | 'system';
  }>;
  excludedFiles?: Array<{ path: string; reason: string }>;
}
```

Normal review continues to write `context.json`. Dry run writes `context.json` and `preview.json`. Preview may skip writing `context.json` but still returns the run ID and summary.

### `commands/review.md`

Add a short-circuit after prepare:

1. Parse stdout JSON.
2. If `preview` or `dryRun` is true:
   - present the included/excluded file summary;
   - show artifact paths for dry run;
   - stop immediately.
3. Otherwise continue with the existing plan, reviewer, filter, relocation, and aggregate workflow.

Update reviewer dispatch instructions:

- If `rulesHit[0].docPath` exists, read the built-in rule doc as today.
- If `docPath` is missing and `rulesHit[0].message` exists, use that message directly as `systemRule`.
- If both are missing, use the default built-in rule doc.

## Error handling

| Code | Scenario | Behavior |
|---|---|---|
| `OCRP-RULES-090` | Rule file does not exist or cannot be read | Hard fail |
| `OCRP-RULES-091` | JSON/YAML parse failure | Hard fail |
| `OCRP-RULES-092` | Rule file root schema is invalid | Hard fail |
| `OCRP-RULES-093` | A rule entry or pattern field is invalid | Hard fail |
| `OCRP-RUN-011` | `--preview` and `--dry-run` are both provided | Hard fail |
| `OCRP-RUN-011` | `--rules` / `--rule` is missing a path | Hard fail |

Explicit user configuration failures do not silently fall back to defaults. This avoids running a review under rules the user did not intend.

## Testing strategy

### Custom rules

Add tests for:

- YAML parsing.
- JSON parsing.
- CLI path priority over repo config.
- repo discovery priority: `.code-review.yaml`, then `.code-review.yml`, then `.code-review.json`.
- invalid root schema.
- invalid rule entries.
- missing path/rule values.

### Rule matching

Add tests for:

- custom first-match-wins.
- custom miss falls back to built-in.
- returned rule source and rule ID.

### File scope

Add tests for:

- user exclude takes priority over include.
- include excludes non-matching files.
- include match skips default excludes.
- unsupported extension is still excluded.

### Review context

Add tests for:

- `.code-review.yaml` changes `rulesHit`.
- include/exclude changes reviewed files.
- excluded files include reasons.
- no config preserves current built-in behavior.

### CLI prepare

Replace P0 rejection tests with tests that verify:

- `--rule` and `--rules` are accepted.
- missing rule path fails with `OCRP-RUN-011`.
- `--preview` and `-p` return `preview: true`.
- `--dry-run` returns `dryRun: true` and writes artifacts.
- `--preview --dry-run` fails with `OCRP-RUN-011`.

### Smoke test

Extend smoke coverage to create a temporary `.code-review.yaml`, run `ocr-prepare --dry-run`, and verify `dryRun: true` plus `previewPath`.

## Compatibility

- Existing reviews without new flags or config behave as before.
- Built-in `rulesHit[0].docPath` continues to work for current command orchestration.
- Custom rule text uses `rulesHit[0].message`, so no temporary rule doc files are needed.
- Report shape only gains optional fields; no existing fields are removed.
- LLM provider behavior remains unchanged: the plugin never calls a provider directly.

## Risks and mitigations

### YAML dependency

Use the `yaml` package rather than writing a custom parser. This adds one runtime dependency but avoids brittle parsing behavior.

### Command orchestration with custom rules

The command file must be updated to read either a built-in docPath or custom message. Tests should verify prompt consistency and prevent regressions.

### Large preview output

Initial implementation outputs all files. If this proves noisy, a future iteration can add truncation. No truncation is introduced now to avoid hiding review scope from CI users.

### Include skipping default excludes

This follows upstream OCR semantics. If a user explicitly includes test files or generated files, they are reviewed unless also excluded.

## Implementation readiness

This design is scoped for one implementation plan. It touches deterministic TypeScript modules, command orchestration, tests, README, and smoke coverage. It does not require external service credentials or PR posting behavior.
