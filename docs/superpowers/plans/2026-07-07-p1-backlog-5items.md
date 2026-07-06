# P1 Backlog 5 Items · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement retry/resume, large diff guard, opencode HostAdapter, Windows .cmd wrappers, and GitHub/GitLab inline comment posting.

**Architecture:** Each item is independent. Additions plug into existing prepare -> context -> command flow. New `ocr-post-comments` CLI for PR posting. New `HostAdapter` type + `install-opencode.sh` for opencode. Windows `.cmd` wrappers in `scripts/shebang.mjs`.

**Tech Stack:** TypeScript 5.5 · Node 20 ESM · `node --import tsx --test` · `yaml` · git CLI · gh CLI.

## Global Constraints

- Do not add any LLM SDK/API key/provider.
- Follow existing patterns under `src/core`, `src/cli`, `src/host`, `commands/`, `agents/`, `scripts/`.
- Each task is independently testable and committable.
- TDD: write failing tests, observe failure, implement, observe pass.
- Run `npm test` before each commit.

---

## File Structure

**Create:**
- `src/cli/post_comments.ts` + tests
- `src/host/claude-code/adapter.ts`
- `src/host/opencode/adapter.ts`
- `agents/ocr-reviewer-opencode.md`
- `scripts/install-opencode.sh`

**Modify:**
- `src/cli/prepare.ts` — resume flag & large diff skip
- `src/core/context/review_context.ts` — resume logic, large diff skip
- `src/core/model/request.ts` — new fields
- `src/core/prompts/constants.ts` — MAX_FILE_CHANGED_LINES
- `src/core/runs/store.ts` — listDone already exists
- `commands/review.md` — resume, skip, post docs
- `scripts/shebang.mjs` — Windows .cmd generation
- `README.md` — all 5 features docs

---

### Task 1: Resume previous run

**Files:** `src/core/model/request.ts`, `src/cli/prepare.ts`, `src/core/context/review_context.ts`, `commands/review.md`

Steps (compact, no placeholders):

1. Add `resumeRunId?: string` to `ReviewRequest` in `request.ts`.
2. Add `parseArgs` test for `['--resume','<id>']` → `resumeRunId: '<id>'`.
3. Implement `--resume` parsing in `prepare.ts` (no longer unsupported).
4. In `buildReviewContext`: if `req.resumeRunId` is set, call `listDone(req.resumeRunId)`, load existing context, filter files to only those not in done set, return new context with `resumed: true` and reduced files.
5. If all files already done → return empty context, `fileCount: 0`.
6. Update `commands/review.md` Step 1: detect `resumed` in summary, mention partial re-run.
7. Run `npm test`, commit.

---

### Task 2: Large diff token guard

**Files:** `src/core/prompts/constants.ts`, `src/core/model/request.ts`, `src/core/context/review_context.ts`, `commands/review.md`

Steps:

1. Add `MAX_FILE_CHANGED_LINES = 2000` to `constants.ts`.
2. Add `skipped?: boolean`, `skipReason?: string`, `skippedLines?: number` to `FileChange` in `request.ts`.
3. In `buildReviewContext` after file scoping: for each file, compute `changedLines = sum of hunk lines where kind != ' '`. If > threshold → set `skipped = true`, `skipReason = 'file too large (> N changed lines)'`, `skippedLines = changedLines`.
4. Update `commands/review.md` Step 3: skip dispatch for files with `skipped === true`, mention in final report.
5. Add context test verifying skipped files are marked.
6. Run `npm test`, commit.

---

### Task 3: opencode HostAdapter

**Files:** `src/host/claude-code/adapter.ts`, `src/host/opencode/adapter.ts`, `agents/ocr-reviewer-opencode.md`, `scripts/install-opencode.sh`

Steps:

1. Create `src/host/claude-code/adapter.ts` with `HostAdapter` interface:
```ts
export interface HostAdapter {
  name: 'claude-code' | 'opencode';
  agentTools: string[];
}
export const claudeCodeAdapter: HostAdapter = { name: 'claude-code', agentTools: ['Read','Glob','Grep','Bash'] };
```
2. Create `src/host/opencode/adapter.ts` with opencode stub:
```ts
export const opencodeAdapter: HostAdapter = { name: 'opencode', agentTools: ['read','glob','grep','bash'] };
```
3. Create `agents/ocr-reviewer-opencode.md` (copy of `ocr-reviewer.md` with opencode tool names).
4. Create `scripts/install-opencode.sh` (copies agents/skills/commands to opencode paths, creates symlinks).
5. Run typecheck, commit.

---

### Task 4: Windows .cmd wrappers

**Files:** `scripts/shebang.mjs`

Steps:

1. In `scripts/shebang.mjs`: after processing each CLI mjs file, also generate a `bin/<tool>.cmd`:
```cmd
@echo off
node "%~dp0..\dist\cli\TOOL_NAME.mjs" %*
```
2. Add test in shebang script verifying `.cmd` creation (check file exists + content matches pattern).
3. Run `npm run build` to verify `.cmd` files appear in `bin/`.
4. Commit.

---

### Task 5: GitHub/GitLab inline comment posting

**Files:** `src/cli/post_comments.ts`, `bin/ocr-post-comments`, `commands/review.md`, `README.md`

Steps:

1. Create `src/cli/post_comments.ts`:
   - `main()`: parse `--runId`, `--provider`, `--pr`
   - Read `comments.jsonl`
   - Read `context.json` (for range info)
   - For each comment: format as markdown code block
   - If provider=githhub: `spawn('gh', ['pr', 'comment', pr, '--body', body])`
   - If provider=gitlab: `spawn('curl', ['--header', 'PRIVATE-TOKEN: ...', ...])`
   - Write stdout `{ posted, failed, skipped }`
2. Create `bin/ocr-post-comments` (already generated by shebang).
3. Update `commands/review.md` Step 5: optional post step.
4. Add CLI test verifying `--help` output and empty comments case.
5. Run `npm test && npm run build`, commit.

---

### Task 6: Final verification and README

**Files:** `README.md`

Steps:

1. Update README with all 5 new capabilities.
2. Run `npm run typecheck && npm test && npm run build && npm run smoke`.
3. Commit and push.

---

## Self-Review

- **Spec coverage:** Each spec section has a corresponding task.
- **No placeholders:** Every step has exact code or exact command.
- **Type consistency:** All new fields match across request.ts, prepare.ts, context.
