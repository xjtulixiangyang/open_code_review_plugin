# TS Tool Protocol Design

Date: 2026-06-30

## Goal

Migrate `file_read_diff`, `code_comment`, and `task_done` to a TypeScript implementation that aligns with `open-code-review` tool semantics instead of maintaining the current one-off CLI flag protocol.

The target behavior is intentionally closer to the upstream Go tools under `/Users/lixiangyang/Desktop/代码/open-code-review/internal/tool/`:

- `file_read_diff` accepts a `path_array` and returns one or more formatted diffs.
- `code_comment` accepts a `comments` array and records parsed comments.
- `task_done` accepts structured completion arguments and marks one subagent/file complete.

The old per-field CLI forms are removed as redundant maintenance surface:

```bash
code_comment --runId R --path a.ts --start 1 --end 1 --content x
file_read_diff --runId R --path a.ts
task_done --runId R --subagent reviewer-a --file a.ts
```

All three tools instead use a common JSON wrapper:

```bash
<tool> --runId <runId> --args '<json>'
```

## Non-goals

- Do not introduce a full registry abstraction mirroring Go's `Tool` / `Provider` / `Registry` types. Three tools do not justify the extra layer yet.
- Do not preserve legacy CLI arguments as compatibility branches.
- Do not implement `file_read`, `file_find`, or `code_search` in this change.
- Do not rewrite historical design or plan documents that mention the old CLI syntax. Only executable prompts, user-facing docs, and tests need updates.
- Do not add `--args-file` in this change. If shell JSON escaping becomes painful later, it can be added as a focused follow-up.

## Architecture

Use a small TypeScript core provider layer plus thin CLI wrappers.

```text
src/core/tools/
  args.ts              # shared --runId / --args JSON parsing and validation helpers
  file_read_diff.ts    # open-code-review-style file_read_diff provider logic
  code_comment.ts      # open-code-review-style code_comment parsing and persistence
  task_done.ts         # task_done provider logic

src/cli/
  file_read_diff.ts    # parse wrapper args, load context, call core provider
  code_comment.ts      # parse wrapper args, call core provider
  task_done.ts         # parse wrapper args, call core provider
```

The CLI files keep the existing executable names and build pipeline. `scripts/shebang.mjs` will still expose:

- `bin/file_read_diff`
- `bin/code_comment`
- `bin/task_done`

The key boundary is that CLI files only parse `--runId` / `--args`, call the core provider, print the returned string, and convert thrown errors into prefixed stderr messages. Tool-specific validation and data shaping live in `src/core/tools/*`.

## Protocols

### Shared CLI wrapper

All three CLIs accept exactly this shape:

```bash
<tool> --runId <runId> --args '<json object>'
```

`src/core/tools/args.ts` should provide a small helper that:

1. scans argv for `--runId` and `--args`;
2. requires both fields;
3. parses `--args` as a JSON object;
4. rejects arrays, primitives, malformed JSON, or missing fields with a clear tool-prefixed error from the CLI.

The parsed args object is intentionally `Record<string, unknown>` so each provider owns its own validation.

### `file_read_diff`

Input:

```json
{
  "path_array": ["src/a.ts", "src/b.ts"]
}
```

Behavior:

- Load `ReviewContext` from `.ocr-runs/<runId>/context.json`.
- Build a read-only diff map keyed by `file.path` from `ctx.files`.
- For each string path in `path_array`, if the diff exists, append:

  ```text
  ==== FILE: src/a.ts ====
  <diff>
  ```

- Ignore non-string entries and paths not found in the diff map.
- If a file has `truncated: true`, retain the current plugin behavior by appending `... (truncated)` after that file's diff.

Output examples:

```text
==== FILE: src/a.ts ====
@@ -1,2 +1,2 @@
...

==== FILE: src/b.ts ====
@@ -4,7 +4,8 @@
...
```

Error-string behavior matches upstream Go semantics:

- Missing or empty `path_array`: `Error: no files found`
- No requested path resolves to a diff: `Error: diff not found for the requested paths`

These are normal provider return strings, not process crashes. Malformed CLI JSON is still a CLI usage error.

### `code_comment`

Input:

```json
{
  "path": "src/a.ts",
  "comments": [
    {
      "content": "这里有问题...",
      "start_line": 10,
      "end_line": 12,
      "suggestion_code": "...",
      "existing_code": "...",
      "thinking": "..."
    }
  ]
}
```

Behavior:

- Parse `comments` in the same spirit as upstream `ParseComments`:
  - `comments` must be a non-empty array.
  - The top-level `path` applies to each comment.
  - Each item must be an object.
  - `content`, `suggestion_code`, `existing_code`, and `thinking` are read from each item when strings.
  - `start_line` and `end_line` are read when numbers or numeric strings. Unlike upstream Go's plain `LlmComment`, this plugin needs line ranges for report rendering, so invalid line values make that specific comment invalid.
- Skip invalid comment objects instead of crashing.
- If every comment is invalid, return an error string and write nothing.
- For each valid comment, create a `CommentRecord` and append it to `.ocr-runs/<runId>/comments.jsonl` using the existing store append behavior.
- Preserve current plugin metadata requirements:
  - generate `comment_id: c-<uuid>` per written comment;
  - set `_meta.subagent` from top-level `subagent` if provided, otherwise `unknown`;
  - set `_meta.ts` at write time.

Successful output:

```json
{"ok":true,"count":2,"comment_ids":["c-...","c-..."]}
```

Error-string behavior:

- Missing or invalid `comments`: `Error: 'comments' array is required. Got args: <json>`
- Missing top-level `path`: `Error: 'path' is required`
- No valid comments after parsing: `Error: no valid comments found`

### `task_done`

Input:

```json
{
  "subagent": "reviewer-a",
  "file": "src/a.ts"
}
```

Behavior:

- Validate `subagent` and `file` as non-empty strings.
- Call the existing store completion behavior to write `.ocr-runs/<runId>/done/<subagent>.json`.

Successful output:

```json
{"ok":true,"subagent":"reviewer-a","file":"src/a.ts"}
```

Validation errors are CLI usage errors because the tool cannot mark completion without these fields.

## Prompt and documentation updates

Because legacy CLI flags are removed, executable prompts must be changed in the same implementation:

- `agents/ocr-reviewer.md`
  - comment submission example becomes `code_comment --runId <runId> --args '{"path":"...","subagent":"...","comments":[...]}'`;
  - completion example becomes `task_done --runId <runId> --args '{"subagent":"...","file":"..."}'`.
- `skills/ocr-review-file/SKILL.md`
  - `file_read_diff` example becomes `file_read_diff --runId <runId> --args '{"path_array":["..."]}'`;
  - `code_comment` example becomes JSON comments array syntax;
  - `task_done` example becomes JSON args syntax.
- `README.md`
  - Architecture can still say subagents emit comments through `code_comment`, but examples or detailed command references must use the new JSON wrapper.

Historical specs and plans under `docs/superpowers/` can remain as records of previous designs unless they are used as live instructions.

## Testing strategy

Update or add focused tests before implementation changes.

### Core/provider tests

Add tests for `src/core/tools/*` where useful:

- `file_read_diff`
  - multiple paths are formatted with `==== FILE: ... ====` headers;
  - empty `path_array` returns `Error: no files found`;
  - missing paths return `Error: diff not found for the requested paths`;
  - partial misses still return found files.
- `code_comment`
  - batch comments parse and persist multiple records;
  - `comment_id` exists for every written comment;
  - invalid `comments` returns the upstream-style error;
  - all-invalid comments write nothing.
- `task_done`
  - valid args write the done marker.

### CLI/roundtrip tests

Update existing CLI roundtrip coverage so it invokes:

```bash
code_comment --runId run1 --args '{"path":"src/a.ts","subagent":"reviewer-0","comments":[{"start_line":1,"end_line":1,"content":"..."}]}'
task_done --runId run1 --args '{"subagent":"reviewer-0","file":"src/a.ts"}'
file_read_diff --runId run1 --args '{"path_array":["src/b.ts"]}'
```

The aggregate test must confirm that reports still consume `comments.jsonl` and `done/` records produced by the new protocol.

Run at minimum:

```bash
npm test
npm run typecheck
npm run build
```

Use `npm run smoke` if the implementation touches end-to-end review orchestration or built bins.

## Risks and mitigations

### Prompt drift

Risk: subagents still call the old CLI syntax and fail during review.

Mitigation: update `agents/ocr-reviewer.md`, `skills/ocr-review-file/SKILL.md`, README examples, and roundtrip tests in the same change as the CLI protocol switch.

### Shell JSON escaping

Risk: JSON in shell commands is more verbose and can be awkward for comments containing quotes.

Mitigation: document single-quoted JSON examples. Keep the first change focused. If real reviews show escaping friction, add `--args-file` later without reintroducing per-field flags.

### Divergence from plugin report needs

Risk: upstream `ParseComments` does not require line numbers, but this plugin's report and relocation pipeline do.

Mitigation: align the high-level protocol while preserving plugin-specific `start_line` / `end_line` validation. This is an intentional compatibility boundary, not accidental drift.

### Partial path misses in `file_read_diff`

Risk: users may expect an error when any requested path is missing.

Mitigation: match upstream behavior: return all found diffs and only return an error when no requested path resolves.

## Acceptance criteria

- `file_read_diff`, `code_comment`, and `task_done` no longer support old per-field CLI flags.
- All three CLIs accept `--runId` and `--args` JSON.
- `file_read_diff` supports `path_array` and formats output like upstream OCR.
- `code_comment` supports a `comments` array and writes one `CommentRecord` per valid item with generated `comment_id`.
- `task_done` marks completion from JSON args.
- Live prompts and docs use the new protocol.
- Tests cover the new protocol and old syntax is not relied on anywhere executable.
- `npm test`, `npm run typecheck`, and `npm run build` pass.
