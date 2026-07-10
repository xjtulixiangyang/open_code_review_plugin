# Cleanup + Custom Plans Guidance Design

> Date: 2026-07-10
> Status: Approved design
> Scope: Local cleanup plus full custom plans guidance support for open-code-review-plugin

## 1. Goals

This change has two goals:

1. Clean local development state after the P1 merge without deleting uncertain work.
2. Add a complete custom plans guidance feature so users can provide repository or user-level review planning instructions that are merged into per-file reviewer guidance.

Non-goals:

- Do not delete locked or dirty worktrees.
- Do not remove `bin/` or `dist/`; local CLI entrypoints should remain usable.
- Do not introduce a YAML DSL for path-specific plan rules in this iteration.
- Do not change the existing LLM PLAN output schema.

## 2. Local Cleanup Design

### 2.1 Worktree Cleanup

Use a conservative cleanup policy for registered worktrees under `.claude/worktrees/`.

A worktree is eligible for removal only when all of these are true:

- It is under the repository's `.claude/worktrees/` directory.
- It is not marked `locked` by `git worktree list --porcelain`.
- Its working tree is clean: `git -C <path> status --short` returns no output.
- Its branch is a known temporary worktree branch (`worktree-agent-*`) or another clearly stale/gone local task branch.

Cleanup steps:

1. Enumerate `git worktree list --porcelain`.
2. Build a candidate list from `.claude/worktrees/*` entries.
3. Skip locked or dirty candidates.
4. Remove eligible worktrees with `git worktree remove <path>`.
5. Run `git worktree prune`.
6. Delete local branches that were associated with removed worktrees and are no longer checked out.

The cleanup must not use force removal unless explicitly requested later.

### 2.2 Remote Cleanup

Current remotes are confusing:

- `github` points to the GitHub repository.
- `target` points to the same GitHub repository.
- `origin` points to a local path.

Normalize to the conventional layout:

- `origin` -> `https://github.com/xjtulixiangyang/open_code_review_plugin.git`
- Remove `github` and `target` remotes.
- Fetch and prune: `git fetch --prune origin`.
- Set `main` to track `origin/main`.

This prevents future `gh pr create` / `git push` operations from using the local path remote by accident.

### 2.3 Runtime Artifact Cleanup

Remove only `.ocr-runs/`.

Keep:

- `bin/`
- `dist/`

Reason: `bin/` and `dist/` are generated but useful for local CLI execution; deleting them would require a rebuild before using the plugin locally.

## 3. Custom Plans Guidance Design

### 3.1 User-Facing Behavior

Users can provide a markdown file with review planning guidance. The text is appended to per-file `planGuidance` and sent to reviewers alongside any existing LLM-generated PLAN guidance.

Supported locations, in priority order:

1. CLI flag: `--plans <path>`
2. Repository default: `.code-review-plans.md`
3. User default: `~/.code-review/plans.md`
4. None: empty guidance, current behavior preserved

Example `.code-review-plans.md`:

```md
# Code Review Plan Guidance

重点关注：
- API 调用失败时是否显式处理非 2xx 响应
- CLI 工具是否先校验参数再读取 run artifacts
- OpenCode 适配文件是否使用 OpenCode frontmatter 语义
```

This iteration treats the file as plain markdown. It does not parse path-specific sections or structured frontmatter.

### 3.2 Data Model

Extend `ReviewRequest`:

```ts
interface ReviewRequest {
  plansPath?: string;
}
```

Extend `ReviewContext`:

```ts
interface ReviewContext {
  plansGuidanceSource?: string;
  plansGuidanceText?: string;
}
```

The context stores the resolved source and raw markdown text. This keeps downstream commands deterministic and avoids re-reading user files during review execution.

### 3.3 Loader

Add a core loader, likely under `src/core/plans/custom_plans.ts`.

Proposed interface:

```ts
interface LoadedPlansGuidance {
  sourceKind: 'cli' | 'repo' | 'user' | 'none';
  source?: string;
  text: string;
}

async function loadPlansGuidance(repoRoot: string, cliPath?: string): Promise<LoadedPlansGuidance>;
```

Behavior:

- CLI path is resolved relative to `repoRoot` unless absolute.
- Missing/unreadable CLI path throws `OCRP-PLANS-100`.
- Repo/user default files are optional and silently skipped when absent.
- Empty files return `text: ''` with their source, but produce no guidance content.

### 3.4 Prepare / Context Flow

`ocr-prepare` changes:

- Parse `--plans <path>`.
- Store `plansPath` in the `ReviewRequest`.
- During context construction, call the plans loader.
- Write `plansGuidanceSource` and `plansGuidanceText` into `context.json`.
- Include `plansGuidanceSource` in prepare summary when present.

### 3.5 Plan Guidance Output

`ocr-plan-guidance --runId --path <file>` should combine two sources:

1. Existing file-specific guidance from `plan.json`.
2. Custom plans markdown from `context.plansGuidanceText`.

Output remains JSON and gains flags:

```json
{
  "path": "src/a.ts",
  "guidance": "...",
  "hasPlan": true,
  "hasCustomPlans": true
}
```

Formatting:

- If both sources exist, separate them with headings:
  - `PLAN guidance:`
  - `Custom plans guidance:`
- If only custom plans exist, output only the custom guidance section.
- If neither exists, output empty `guidance`.

### 3.6 Command and Documentation Updates

Update:

- `commands/review.md`
- `commands/review-opencode.md`
- README or docs usage section

Document:

- `--plans <path>` flag
- `.code-review-plans.md`
- `~/.code-review/plans.md`
- Plain markdown semantics
- That custom plans guidance applies globally to all reviewed files in this iteration

### 3.7 Errors

Add a new prepare-level error:

| Code | Meaning |
|---|---|
| `OCRP-PLANS-100` | CLI `--plans` file cannot be read |

Default repo/user files do not raise errors when missing.

### 3.8 Tests

Add or update tests for:

- `parseArgs` accepts `--plans` and stores `plansPath`.
- Loader priority: CLI > repo > user > none.
- Missing CLI path throws `OCRP-PLANS-100`.
- `ocr-prepare` writes custom plans fields into `context.json`.
- `ocr-plan-guidance` returns custom guidance even when `plan.json` is missing.
- `ocr-plan-guidance` combines LLM PLAN guidance and custom plans guidance.
- Existing tests remain green.

Verification commands:

```bash
npm test
npx tsc --noEmit
npm run build
```

## 4. Implementation Order

1. Run local cleanup first, because it changes no product code.
2. Implement custom plans guidance with TDD:
   - parser tests
   - loader tests
   - context tests
   - plan_guidance tests
3. Update command docs and README.
4. Run final verification.
5. Commit changes.

## 5. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Worktree cleanup deletes useful local work | Conservative policy: skip locked or dirty worktrees, no force removal |
| Remote normalization disrupts local-only workflows | Use conventional GitHub `origin`; this is explicitly requested and reduces PR confusion |
| Custom plans text makes prompts too long | Keep plain markdown for now; rely on existing prompt length constraints; revisit truncation only if observed |
| Confusion with custom rules | Name it `plans` and document that it affects reviewer guidance, not file inclusion or rule text |

## 6. Acceptance Criteria

- Stale eligible worktrees removed; locked/dirty worktrees preserved.
- Remotes normalized to `origin=GitHub` with `main` tracking `origin/main`.
- `.ocr-runs/` removed; `bin/` and `dist/` preserved.
- `--plans <path>` works.
- `.code-review-plans.md` and `~/.code-review/plans.md` fallback works.
- `ocr-plan-guidance` includes custom plans guidance.
- Tests, typecheck, and build pass.
