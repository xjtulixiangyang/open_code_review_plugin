# P1 收尾：文档清理·Windows·PR Posting·OpenCode Adapter 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 v0.1.0 P0 基准之上完成文档清理、Windows 代码路径兼容、PR Posting 行内评论、OpenCode HostAdapter 完整适配四项 P1 任务。

**Architecture:** 四阶段串行执行：先做基础设施（文档清理 + Windows 修复），再做功能增强（PR Posting + OpenCode adapter）。每个阶段独立提交。PR Posting 复用 `../open-code-review` 的行内 review comment 模式（GitHub `pulls.createReview` + GitLab Discussions API + 多级降级）。OpenCode adapter 提取 `HostAdapter` 接口层，新增专用 `commands/review-opencode.md`（单 agent 顺序遍历），安装脚本适配 `~/.config/opencode/`。

**Tech Stack:** TypeScript (ES2022, Node 18+), native `node:test`, `tsx` runner, Bash shell scripts

## Global Constraints

- Node ≥18（`engines.node`）
- 所有 TypeScript 源文件使用 ESM（`import`/`export`，`type: module`）
- 文件名：`*.ts` 源 → `dist/*.mjs` 构建产物
- 测试用 `node:test` + `node:assert/strict`
- commit 约定：`chore(...)` / `feat(...)` / `docs(...)` / `fix(...)`
- 不新增外部 npm 依赖
- 不改动现有 `.claude-plugin/plugin.json`

---

### Task 1: 文档清理

**Files:**
- Modify: `.gitignore`（末尾追加 4 行）
- Stage: `docs/superpowers/plans/2026-07-02-custom-rules-preview-dry-run.md`（untracked → tracked）
- Stage: `docs/superpowers/plans/2026-07-03-review-stability-custom-rules.md`
- Stage: `docs/superpowers/plans/2026-07-07-ocr-context-tools.md`
- Stage: `docs/superpowers/plans/2026-07-07-review-partial-ref-fix.md`

**Interfaces:**
- Consumes: nothing
- Produces: nothing（纯文件操作）

- [ ] **Step 1: 追加 .gitignore 忽略规则**

```bash
cat >> .gitignore << 'EOF'

# Worktrees & intermediate artifacts
.claude/worktrees/
codespec/superpowers/
codespec/design.md
codespec/spec.md
EOF
```

- [ ] **Step 2: 验证 .gitignore 生效**

```bash
git status --short -- .claude/worktrees/ codespec/superpowers/ codespec/design.md codespec/spec.md
```

Expected: 上述路径不再显示在 `git status` 中。

- [ ] **Step 3: 纳入 4 个计划文档**

```bash
git add docs/superpowers/plans/2026-07-02-custom-rules-preview-dry-run.md
git add docs/superpowers/plans/2026-07-03-review-stability-custom-rules.md
git add docs/superpowers/plans/2026-07-07-ocr-context-tools.md
git add docs/superpowers/plans/2026-07-07-review-partial-ref-fix.md
```

- [ ] **Step 4: 验证 — 无意外未跟踪文件**

```bash
git status --short
```

Expected: 只剩 `.claude/`（Claude 自身管理）、之前已忽略的 `.ocr-runs/`/`.superpowers/`，无其他 `?? ` 文件。

- [ ] **Step 5: Commit**

```bash
git add .gitignore
git commit -m "chore: track 4 plan docs, gitignore runtime/intermediate artifacts

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Windows 代码路径兼容

**Files:**
- Create: `src/core/diff/null_path.ts`（NULL_PATH 常量 + normalizePath 工具函数）
- Modify: `src/core/diff/workspace.ts:6`（`/dev/null` → NULL_PATH 常量）
- Modify: `src/core/diff/parser.ts:122,126`（接受 `NUL` 作为 null path）
- Create: `src/core/diff/__tests__/null_path.test.ts`
- Create: `src/core/__tests__/normalize_path.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `NULL_PATH: string` — `process.platform === 'win32' ? 'NUL' : '/dev/null'`
  - `NULL_PATH_ALTS: string[]` — `['/dev/null', 'NUL']`
  - `normalizePath(p: string): string` — 将所有 `\` 替换为 `/`

- [ ] **Step 1: 创建 `src/core/diff/null_path.ts`**

```ts
/**
 * Cross-platform null path for git diff --no-index.
 * POSIX: /dev/null, Windows: NUL.
 */
export const NULL_PATH: string =
  process.platform === 'win32' ? 'NUL' : '/dev/null';

/** All accepted null path spellings (for diff header parsing). */
export const NULL_PATH_ALTS: readonly string[] = ['/dev/null', 'NUL'];

/** Normalize Windows backslash paths to forward slash. Idempotent. */
const SLASH_RE = /\\/g;
export function normalizePath(p: string): string {
  return p.replace(SLASH_RE, '/');
}
```

- [ ] **Step 2: 写 normalize_path 测试（先失败）**

```ts
// src/core/__tests__/normalize_path.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath } from '../diff/null_path.js';

test('normalizePath converts backslash to forward slash', () => {
  assert.equal(normalizePath('a\\b\\c'), 'a/b/c');
});

test('normalizePath is idempotent on forward slashes', () => {
  assert.equal(normalizePath('a/b/c'), 'a/b/c');
});

test('normalizePath handles mixed slashes', () => {
  assert.equal(normalizePath('a\\b/c\\d'), 'a/b/c/d');
});

test('normalizePath handles empty string', () => {
  assert.equal(normalizePath(''), '');
});

test('normalizePath handles no slashes', () => {
  assert.equal(normalizePath('foo.ts'), 'foo.ts');
});
```

Run: `node --import tsx --test src/core/__tests__/normalize_path.test.ts`
Expected: PASS（函数已在 Step 1 中定义，已同时创建）

- [ ] **Step 3: 写 null_path 测试**

```ts
// src/core/diff/__tests__/null_path.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NULL_PATH, NULL_PATH_ALTS } from '../null_path.js';
import { parseUnifiedDiff } from '../parser.js';

test('NULL_PATH is /dev/null on non-win32', () => {
  assert.equal(NULL_PATH, '/dev/null');
});

test('NULL_PATH_ALTS contains both spellings', () => {
  assert.ok(NULL_PATH_ALTS.includes('/dev/null'));
  assert.ok(NULL_PATH_ALTS.includes('NUL'));
});

test('parser recognizes NUL as added file (--- NUL)', () => {
  const diff = [
    'diff --git a/NUL b/new.ts',
    '--- NUL',
    '+++ b/new.ts',
    '@@ -0,0 +1,3 @@',
    '+line 1',
    '+line 2',
    '+line 3',
  ].join('\n');
  const changes = parseUnifiedDiff(diff);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, 'added');
  assert.equal(changes[0].path, 'new.ts');
});

test('parser recognizes NUL as deleted file (+++ NUL)', () => {
  const diff = [
    'diff --git a/old.ts b/NUL',
    '--- a/old.ts',
    '+++ NUL',
    '@@ -1,3 +0,0 @@',
    '-line 1',
    '-line 2',
    '-line 3',
  ].join('\n');
  const changes = parseUnifiedDiff(diff);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, 'deleted');
  assert.equal(changes[0].path, 'old.ts');
});
```

Run: `node --import tsx --test src/core/diff/__tests__/null_path.test.ts`
Expected: PASS（parser 尚未修改，第 3、4 个测试会 FAIL — `added`/`deleted` 未被识别）

- [ ] **Step 4: 修改 parser.ts 接受 NUL 作为 null path**

```ts
// 在 parser.ts 文件顶部 import
import { NULL_PATH_ALTS } from './null_path.js';

// 修改 L122（原来：if (line === '--- /dev/null')）
// 改为：
if (NULL_PATH_ALTS.some(alt => line === `--- ${alt}`)) {
  cur.status = 'added';
  continue;
}

// 修改 L126（原来：if (line === '+++ /dev/null')）
// 改为：
if (NULL_PATH_ALTS.some(alt => line === `+++ ${alt}`)) {
  cur.status = 'deleted';
  continue;
}
```

- [ ] **Step 5: 运行 null_path 测试验证 parser 修复通过**

```bash
node --import tsx --test src/core/diff/__tests__/null_path.test.ts
```

Expected: 4/4 PASS

- [ ] **Step 6: 修改 workspace.ts 使用 NULL_PATH 常量**

```ts
// src/core/diff/workspace.ts 顶部新增 import
import { NULL_PATH } from './null_path.js';

// 修改 L6（原来：'/dev/null' 字面量）
// 改为：
const child = spawn('git', ['diff', '--no-color', '-U3', '--no-index', '--', NULL_PATH, file], {
```

- [ ] **Step 7: 运行现有 diff 测试确保无回归**

```bash
node --import tsx --test src/core/diff/__tests__/*.test.ts
```

Expected: 所有已有测试 PASS

- [ ] **Step 8: 运行全部 normalize_path 测试**

```bash
node --import tsx --test src/core/__tests__/normalize_path.test.ts
```

Expected: 5/5 PASS

- [ ] **Step 9: Commit**

```bash
git add src/core/diff/null_path.ts \
  src/core/diff/__tests__/null_path.test.ts \
  src/core/__tests__/normalize_path.test.ts \
  src/core/diff/parser.ts \
  src/core/diff/workspace.ts
git commit -m "fix(core): add Windows path compatibility (/dev/null→NUL, \\→/ normalization)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: PR Posting 行内评论 (GitHub + GitLab)

**Files:**
- Create: `src/cli/github_post.ts` — GitHub `pulls.createReview` + 降级
- Create: `src/cli/gitlab_post.ts` — GitLab Discussions API + 降级
- Create: `src/cli/__tests__/github_post.test.ts`
- Create: `src/cli/__tests__/gitlab_post.test.ts`
- Modify: `src/cli/post_comments.ts` — 重构为调用 github_post/gitlab_post
- Modify: `src/cli/__tests__/post_comments.test.ts` — 增加 --dry-run 测试
- Modify: `commands/review.md:172-179` — 更新 Step 6 描述

**Interfaces:**
- Consumes: `CommentRecord` from `../core/model/comment.js`, `ReviewContext` from `../core/model/request.js`, `readComments`/`readContext` from `../core/runs/store.js`
- Produces:
  - `githubPostComments(comments: CommentRecord[], ctx: ReviewContext, pr: string, opts?: { dryRun?: boolean; retry?: number }): Promise<PostResult>`
  - `gitlabPostComments(comments: CommentRecord[], ctx: ReviewContext, pr: string, token: string, projectId: string, opts?: { dryRun?: boolean; retry?: number }): Promise<PostResult>`
  - `PostResult = { posted: number; failed: number; skipped: number; details: PostDetail[] }`
  - `PostDetail = { path: string; line: number; ok: boolean; fallbackLevel: number }`

- [ ] **Step 1: 创建 `src/cli/github_post.ts`**

```ts
import type { CommentRecord } from '../core/model/comment.js';
import type { ReviewContext } from '../core/model/request.js';
import { spawn } from 'node:child_process';

export interface PostDetail {
  path: string;
  line: number;
  ok: boolean;
  fallbackLevel: number; // 1=inline batch, 2=inline single, 3=issue comment, 0=failed
}

export interface PostResult {
  posted: number;
  failed: number;
  skipped: number;
  details: PostDetail[];
}

function exec(cmd: string, args: string[], stdin?: string): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    if (stdin) {
      p.stdin.write(stdin);
      p.stdin.end();
    }
    p.on('close', (code) => resolve({ ok: code === 0, stderr }));
    p.on('error', (e) => resolve({ ok: false, stderr: e.message }));
  });
}

async function getRepo(): Promise<{ owner: string; repo: string }> {
  const { ok, stderr } = await exec('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  if (!ok) throw new Error(`gh repo view failed: ${stderr}`);
  const nameWithOwner = stderr.trim() || ''; // gh --jq outputs to stdout
  // re-fetch: gh --jq writes to stdout, not stderr
  return new Promise((resolve, reject) => {
    const p = spawn('gh', ['repo', 'view', '--json', 'nameWithOwner']);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', () => {});
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('gh repo view failed'));
      const json = JSON.parse(out) as { nameWithOwner: string };
      const [owner, repo] = json.nameWithOwner.split('/');
      resolve({ owner, repo });
    });
    p.on('error', reject);
  });
}

async function getHeadSha(pr: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn('gh', ['pr', 'view', pr, '--json', 'headRefOid']);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.stderr.on('data', () => {});
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('gh pr view failed'));
      const json = JSON.parse(out) as { headRefOid: string };
      resolve(json.headRefOid);
    });
    p.on('error', reject);
  });
}

function buildReviewBody(
  ctx: ReviewContext,
  comments: CommentRecord[],
): string {
  const parts = comments.map((c) => {
    let body = `**${ctx.range}** · \`${c.path}:${c.start_line}-${c.end_line}\`\n\n${c.content}`;
    if (c.suggestion_code) {
      body += `\n\n\`\`\`suggestion\n${c.suggestion_code}\n\`\`\``;
    }
    return body;
  });
  return parts.join('\n\n---\n\n');
}

async function postBatchReview(
  owner: string,
  repo: string,
  pr: string,
  headSha: string,
  comments: CommentRecord[],
): Promise<boolean> {
  const reviewComments = comments.map((c) => ({
    path: c.path,
    body: `**${c.start_line}-${c.end_line}** · ${c.content}${c.suggestion_code ? '\n\n```suggestion\n' + c.suggestion_code + '\n```' : ''}`,
    line: c.end_line,
    start_line: c.start_line,
    side: 'RIGHT' as const,
    start_side: 'RIGHT' as const,
  }));

  const payload = JSON.stringify({
    commit_id: headSha,
    event: 'COMMENT',
    comments: reviewComments,
  });

  const r = await exec('gh', [
    'api', `repos/${owner}/${repo}/pulls/${pr}/reviews`,
    '--method', 'POST',
    '--input', '-',
  ], payload);

  return r.ok;
}

async function postSingleReview(
  owner: string,
  repo: string,
  pr: string,
  headSha: string,
  comment: CommentRecord,
): Promise<boolean> {
  const payload = JSON.stringify({
    commit_id: headSha,
    event: 'COMMENT',
    comments: [{
      path: comment.path,
      body: `**${comment.start_line}-${comment.end_line}** · ${comment.content}${comment.suggestion_code ? '\n\n```suggestion\n' + comment.suggestion_code + '\n```' : ''}`,
      line: comment.end_line,
      start_line: comment.start_line,
      side: 'RIGHT' as const,
      start_side: 'RIGHT' as const,
    }],
  });

  const r = await exec('gh', [
    'api', `repos/${owner}/${repo}/pulls/${pr}/reviews`,
    '--method', 'POST',
    '--input', '-',
  ], payload);

  return r.ok;
}

async function postIssueComment(pr: string, body: string): Promise<boolean> {
  const r = await exec('gh', ['pr', 'comment', pr, '--body', body]);
  return r.ok;
}

export async function githubPostComments(
  comments: CommentRecord[],
  ctx: ReviewContext,
  pr: string,
  opts: { dryRun?: boolean; retry?: number } = {},
): Promise<PostResult> {
  if (comments.length === 0) return { posted: 0, failed: 0, skipped: 0, details: [] };

  const retryN = opts.retry ?? 1;

  if (opts.dryRun) {
    return {
      posted: 0,
      failed: 0,
      skipped: comments.length,
      details: comments.map((c) => ({
        path: c.path,
        line: c.end_line,
        ok: false,
        fallbackLevel: 0,
      })),
    };
  }

  const { owner, repo } = await getRepo();
  const headSha = await getHeadSha(pr);

  // Level 1: batch inline review
  const batchOk = await postBatchReview(owner, repo, pr, headSha, comments);
  if (batchOk) {
    return {
      posted: comments.length,
      failed: 0,
      skipped: 0,
      details: comments.map((c) => ({ path: c.path, line: c.end_line, ok: true, fallbackLevel: 1 })),
    };
  }

  // Level 2: individual inline reviews with retry
  const details: PostDetail[] = [];
  let posted = 0;
  let failed = 0;

  for (const c of comments) {
    let ok = false;
    for (let attempt = 0; attempt <= retryN; attempt++) {
      ok = await postSingleReview(owner, repo, pr, headSha, c);
      if (ok) break;
    }
    if (ok) {
      posted++;
      details.push({ path: c.path, line: c.end_line, ok: true, fallbackLevel: 2 });
    } else {
      // Level 3: fallback to issue comment
      const body = `**${ctx.range}** · \`${c.path}:${c.start_line}-${c.end_line}\`\n\n${c.content}`;
      const noteOk = await postIssueComment(pr, body);
      if (noteOk) {
        posted++;
        details.push({ path: c.path, line: c.end_line, ok: true, fallbackLevel: 3 });
      } else {
        failed++;
        details.push({ path: c.path, line: c.end_line, ok: false, fallbackLevel: 0 });
      }
    }
  }

  return { posted, failed, skipped: 0, details };
}
```

- [ ] **Step 2: 创建 `src/cli/gitlab_post.ts`**

```ts
import type { CommentRecord } from '../core/model/comment.js';
import type { ReviewContext } from '../core/model/request.js';
import { spawn } from 'node:child_process';

export interface PostDetail {
  path: string;
  line: number;
  ok: boolean;
  fallbackLevel: number; // 1=inline discussion, 2=MR note, 0=failed
}

export interface PostResult {
  posted: number;
  failed: number;
  skipped: number;
  details: PostDetail[];
}

function exec(cmd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stdout.resume();
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('close', (code) => resolve({ ok: code === 0, stderr }));
    p.on('error', (e) => resolve({ ok: false, stderr: e.message }));
  });
}

interface MrVersion {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

async function getMrVersions(
  projectId: string,
  pr: string,
  token: string,
): Promise<MrVersion> {
  const r = await exec('curl', [
    '--silent', '--show-error',
    '--header', `PRIVATE-TOKEN: ${token}`,
    `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/${pr}/versions`,
  ]);

  if (!r.ok) throw new Error(`Failed to fetch MR versions: ${r.stderr}`);

  const data = JSON.parse(r.stderr) as Array<{
    base_commit_sha: string;
    start_commit_sha: string;
    head_commit_sha: string;
  }>;

  if (data.length === 0) throw new Error('No MR versions found');

  const latest = data[data.length - 1];
  return {
    base_sha: latest.base_commit_sha,
    start_sha: latest.start_commit_sha,
    head_sha: latest.head_commit_sha,
  };
}

async function postDiscussion(
  projectId: string,
  pr: string,
  token: string,
  comment: CommentRecord,
  version: MrVersion,
  ctx: ReviewContext,
): Promise<boolean> {
  let body = `**${ctx.range}** · \`${comment.path}:${comment.start_line}-${comment.end_line}\`\n\n${comment.content}`;
  if (comment.suggestion_code) {
    body += `\n\n\`\`\`suggestion\n${comment.suggestion_code}\n\`\`\``;
  }

  const args: string[] = [
    '--silent', '--show-error',
    '--request', 'POST',
    `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/${pr}/discussions`,
    '--header', `PRIVATE-TOKEN: ${token}`,
  ];

  // use --data-urlencode for each field
  const fields: Array<[string, string]> = [
    ['body', body],
    ['position[position_type]', 'text'],
    ['position[new_path]', comment.path],
    ['position[old_path]', comment.path],
    ['position[new_line]', String(comment.end_line)],
    ['position[base_sha]', version.base_sha],
    ['position[start_sha]', version.start_sha],
    ['position[head_sha]', version.head_sha],
  ];

  for (const [k, v] of fields) {
    args.push('--data-urlencode', `${k}=${v}`);
  }

  const r = await exec('curl', args);
  return r.ok;
}

async function postNote(
  projectId: string,
  pr: string,
  token: string,
  comment: CommentRecord,
  ctx: ReviewContext,
): Promise<boolean> {
  let body = `**${ctx.range}** · \`${comment.path}:${comment.start_line}-${comment.end_line}\`\n\n${comment.content}`;
  if (comment.suggestion_code) {
    body += `\n\n\`\`\`suggestion\n${comment.suggestion_code}\n\`\`\``;
  }

  const r = await exec('curl', [
    '--silent', '--show-error',
    '--request', 'POST',
    `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/${pr}/notes`,
    '--header', `PRIVATE-TOKEN: ${token}`,
    '--data-urlencode', `body=${body}`,
  ]);
  return r.ok;
}

export async function gitlabPostComments(
  comments: CommentRecord[],
  ctx: ReviewContext,
  pr: string,
  token: string,
  projectId: string,
  opts: { dryRun?: boolean; retry?: number } = {},
): Promise<PostResult> {
  if (comments.length === 0) return { posted: 0, failed: 0, skipped: 0, details: [] };

  const retryN = opts.retry ?? 1;

  if (opts.dryRun) {
    return {
      posted: 0,
      failed: 0,
      skipped: comments.length,
      details: comments.map((c) => ({
        path: c.path,
        line: c.end_line,
        ok: false,
        fallbackLevel: 0,
      })),
    };
  }

  // Fetch MR version info for position data
  let version: MrVersion;
  try {
    version = await getMrVersions(projectId, pr, token);
  } catch (err) {
    // If version fetch fails, treat all as failed
    const msg = err instanceof Error ? err.message : String(err);
    return {
      posted: 0,
      failed: comments.length,
      skipped: 0,
      details: comments.map((c) => ({
        path: c.path,
        line: c.end_line,
        ok: false,
        fallbackLevel: 0,
      })),
    };
  }

  const details: PostDetail[] = [];
  let posted = 0;
  let failed = 0;

  for (const c of comments) {
    // Level 1: inline discussion with retry
    let ok = false;
    for (let attempt = 0; attempt <= retryN; attempt++) {
      ok = await postDiscussion(projectId, pr, token, c, version, ctx);
      if (ok) break;
    }
    if (ok) {
      posted++;
      details.push({ path: c.path, line: c.end_line, ok: true, fallbackLevel: 1 });
    } else {
      // Level 2: fallback to MR note
      const noteOk = await postNote(projectId, pr, token, c, ctx);
      if (noteOk) {
        posted++;
        details.push({ path: c.path, line: c.end_line, ok: true, fallbackLevel: 2 });
      } else {
        failed++;
        details.push({ path: c.path, line: c.end_line, ok: false, fallbackLevel: 0 });
      }
    }
  }

  return { posted, failed, skipped: 0, details };
}
```

- [ ] **Step 3: 写 github_post 测试**

```ts
// src/cli/__tests__/github_post.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubPostComments } from '../github_post.js';
import type { CommentRecord } from '../../core/model/comment.js';
import type { ReviewContext } from '../../core/model/request.js';

const ctx: ReviewContext = {
  runId: 'test-1234',
  range: 'workspace',
  files: [],
  excludedFiles: [],
  rulesSource: 'system',
  reviewConfig: { concurrency: 2, maxHunkLines: 500, commentPerFile: 0 },
};

const sampleComments: CommentRecord[] = [
  {
    comment_id: 'c1',
    path: 'src/a.ts',
    start_line: 10,
    end_line: 15,
    content: 'Consider using const.',
  },
  {
    comment_id: 'c2',
    path: 'src/b.ts',
    start_line: 20,
    end_line: 22,
    content: 'Typo in variable name.',
    suggestion_code: 'const fixed = true;',
  },
];

test('githubPostComments dryRun returns all skipped', async () => {
  const r = await githubPostComments(sampleComments, ctx, '42', { dryRun: true });
  assert.equal(r.posted, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.skipped, 2);
  assert.equal(r.details.length, 2);
  assert.ok(r.details.every((d) => d.fallbackLevel === 0));
});

test('githubPostComments empty comments returns zeros', async () => {
  const r = await githubPostComments([], ctx, '42');
  assert.equal(r.posted, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.skipped, 0);
  assert.equal(r.details.length, 0);
});
```

Run: `node --import tsx --test src/cli/__tests__/github_post.test.ts`
Expected: 2/2 PASS

- [ ] **Step 4: 写 gitlab_post 测试**

```ts
// src/cli/__tests__/gitlab_post.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gitlabPostComments } from '../gitlab_post.js';
import type { CommentRecord } from '../../core/model/comment.js';
import type { ReviewContext } from '../../core/model/request.js';

const ctx: ReviewContext = {
  runId: 'test-1234',
  range: 'workspace',
  files: [],
  excludedFiles: [],
  rulesSource: 'system',
  reviewConfig: { concurrency: 2, maxHunkLines: 500, commentPerFile: 0 },
};

const sampleComments: CommentRecord[] = [
  {
    comment_id: 'c1',
    path: 'src/a.ts',
    start_line: 10,
    end_line: 15,
    content: 'Consider using const.',
  },
];

test('gitlabPostComments dryRun returns all skipped', async () => {
  const r = await gitlabPostComments(
    sampleComments, ctx, '42', 'fake-token', '12345',
    { dryRun: true },
  );
  assert.equal(r.posted, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.skipped, 1);
  assert.equal(r.details.length, 1);
  assert.ok(r.details.every((d) => d.fallbackLevel === 0));
});

test('gitlabPostComments empty comments returns zeros', async () => {
  const r = await gitlabPostComments([], ctx, '42', 'fake-token', '12345');
  assert.equal(r.posted, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.skipped, 0);
  assert.equal(r.details.length, 0);
});
```

Run: `node --import tsx --test src/cli/__tests__/gitlab_post.test.ts`
Expected: 2/2 PASS

- [ ] **Step 5: 重构 post_comments.ts 调用新模块**

```ts
#!/usr/bin/env node
import { readComments, readContext } from '../core/runs/store.js';
import type { CommentRecord } from '../core/model/comment.js';
import type { ReviewContext } from '../core/model/request.js';
import { githubPostComments } from './github_post.js';
import { gitlabPostComments } from './gitlab_post.js';

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      // boolean flags (no value)
      if (key === 'dry-run') {
        out[key] = 'true';
        continue;
      }
      out[key] = argv[i + 1] ?? '';
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseFlags(process.argv.slice(2));
  if (!args.runId) {
    process.stderr.write('[ocr-post-comments] missing --runId\n');
    process.exit(2);
  }
  const provider = args.provider || 'github';
  const pr = args.pr;

  if (!pr) {
    process.stderr.write(`[ocr-post-comments] --pr required for ${provider}\n`);
    process.exit(2);
  }

  const comments = await readComments<CommentRecord>(args.runId);
  const ctx = await readContext<ReviewContext>(args.runId);

  const dryRun = args['dry-run'] === 'true';
  const retry = args.retry ? parseInt(args.retry, 10) : 1;

  let result: { posted: number; failed: number; skipped: number };

  if (provider === 'github') {
    const r = await githubPostComments(comments, ctx, pr, { dryRun, retry });
    result = r;
  } else if (provider === 'gitlab') {
    const token = process.env.GITLAB_TOKEN;
    if (!token) {
      process.stderr.write('[ocr-post-comments] GITLAB_TOKEN env var required for gitlab provider\n');
      process.exit(2);
    }
    const projectId = process.env.CI_PROJECT_ID;
    if (!projectId) {
      process.stderr.write('[ocr-post-comments] CI_PROJECT_ID env var required for gitlab provider\n');
      process.exit(2);
    }
    const r = await gitlabPostComments(comments, ctx, pr, token, projectId, { dryRun, retry });
    result = r;
  } else {
    process.stderr.write(`[ocr-post-comments] unknown provider: ${provider}\n`);
    process.exit(2);
  }

  if (dryRun) {
    // dump payload preview
    const preview = comments.map((c) => ({
      path: c.path,
      line: `${c.start_line}-${c.end_line}`,
      content: c.content.slice(0, 200),
      suggestion_code: c.suggestion_code ? c.suggestion_code.slice(0, 200) : undefined,
    }));
    process.stdout.write(JSON.stringify({ dryRun: true, comments: preview, count: comments.length }) + '\n');
  } else {
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}

main().catch((err) => {
  process.stderr.write(`[ocr-post-comments] ${(err as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: 更新 post_comments 测试，新增 --dry-run 测试**

```ts
// src/cli/__tests__/post_comments.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('ocr-post-comments missing --runId exits with error message', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/post_comments.ts'], { encoding: 'utf8' });
  assert.ok(r.stderr.includes('missing --runId'), `stderr: ${r.stderr}`);
  assert.notEqual(r.status, 0);
});

test('ocr-post-comments github without --pr exits with error', () => {
  const r = spawnSync(process.execPath, [
    '--import', 'tsx',
    'src/cli/post_comments.ts',
    '--runId', 'nonexistent',
    '--provider', 'github',
  ], { encoding: 'utf8' });
  assert.ok(r.stderr.includes('--pr required'), `stderr: ${r.stderr}`);
  assert.notEqual(r.status, 0);
});

test('ocr-post-comments unknown provider exits with error', () => {
  const r = spawnSync(process.execPath, [
    '--import', 'tsx',
    'src/cli/post_comments.ts',
    '--runId', 'nonexistent',
    '--provider', 'unknown',
    '--pr', '1',
  ], { encoding: 'utf8' });
  assert.ok(r.stderr.includes('unknown provider'), `stderr: ${r.stderr}`);
  assert.notEqual(r.status, 0);
});
```

Run: `node --import tsx --test src/cli/__tests__/post_comments.test.ts`
Expected: 3/3 PASS

- [ ] **Step 7: 更新 commands/review.md Step 6（L172-179）**

```diff
 ### Step 6 — Post to PR (optional)

 If the user requests posting review comments to a PR:

 1. Run Bash:
    ```bash
    ocr-post-comments --runId <runId> --provider <github|gitlab> --pr <number>
    ```
-2. The stdout JSON contains `posted`, `failed`, and `skipped`. Reply with a summary.
+2. Comments are posted as **inline review comments** on the diff (GitHub
+   `pulls.createReview`, GitLab Discussions API). A three-level fallback
+   strategy is used: batch inline review → individual inline → plain
+   PR/MR comment.
+3. Use `--dry-run` to preview the comments that would be posted without
+   actually calling the platform API.
+4. Use `--retry <n>` to set the per-comment retry count (default: 1).
+5. The stdout JSON contains `posted`, `failed`, `skipped`, and `details`.
+   Reply with a summary.
```

- [ ] **Step 8: 运行全套 cli 测试**

```bash
node --import tsx --test src/cli/__tests__/*.test.ts
```

Expected: 5/5 PASS（2 个原 post_comments + 1 个新增 post_comments + 2 个 github_post + 2 个 gitlab_post = 实际上 3+2+2 = 7 tests）

- [ ] **Step 9: Commit**

```bash
git add src/cli/github_post.ts \
  src/cli/gitlab_post.ts \
  src/cli/__tests__/github_post.test.ts \
  src/cli/__tests__/gitlab_post.test.ts \
  src/cli/post_comments.ts \
  src/cli/__tests__/post_comments.test.ts \
  commands/review.md
git commit -m "feat(post): GitHub/GitLab inline review comments with multi-level fallback

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: OpenCode HostAdapter 完整适配

**Files:**
- Create: `src/host/types.ts` — 提取 HostAdapter 接口 + HostManifest
- Modify: `src/host/claude-code/adapter.ts` — 从 types.ts 导入接口
- Modify: `src/host/opencode/adapter.ts` — 从 types.ts 导入接口
- Create: `commands/review-opencode.md` — OpenCode 专用 review 命令（单 agent 顺序遍历）
- Modify: `scripts/install-opencode.sh` — 适配 `~/.config/opencode/`
- Modify: `src/host/opencode/README.md` — 更新为完整文档
- Create: `src/host/__tests__/types.test.ts`
- Create: `src/host/__tests__/opencode_adapter.test.ts`

**Interfaces:**
- Consumes: Shell `/opencode run`、`opencode debug skill`（集成测试用）
- Produces:
  - `HostAdapter { name; agentTools }` — 从 `src/host/types.ts` 导出
  - `HostManifest { adapter; commandsDir; skillsDir; agentsDir; toolNameMap }`
  - `opencodeAdapter` — 从 `src/host/opencode/adapter.ts` 导出
  - `claudeCodeAdapter` — 从 `src/host/claude-code/adapter.ts` 导出

- [ ] **Step 1: 创建 `src/host/types.ts`**

```ts
/**
 * HostAdapter — allows review tools to adapt to different AI coding hosts.
 */
export interface HostAdapter {
  name: 'claude-code' | 'opencode';
  agentTools: string[];
}

/**
 * HostManifest — static metadata for a host-specific installation.
 */
export interface HostManifest {
  adapter: HostAdapter;
  /** Directory containing command .md files (relative to plugin root). */
  commandsDir: string;
  /** Directory containing skill directories (relative to plugin root). */
  skillsDir: string;
  /** Directory containing agent .md files (relative to plugin root). */
  agentsDir: string;
  /** Tool name mapping: PascalCase (cc) ↔ lowercase (opencode). */
  toolNameMap: Record<string, string>;
}

export const CLAUDE_CODE_MANIFEST: HostManifest = {
  adapter: {
    name: 'claude-code',
    agentTools: ['Read', 'Glob', 'Grep', 'Bash'],
  },
  commandsDir: '.claude-plugin/commands',
  skillsDir: 'skills',
  agentsDir: 'agents',
  toolNameMap: { read: 'Read', glob: 'Glob', grep: 'Grep', bash: 'Bash' },
};

export const OPENCODE_MANIFEST: HostManifest = {
  adapter: {
    name: 'opencode',
    agentTools: ['read', 'glob', 'grep', 'bash'],
  },
  commandsDir: '~/.config/opencode/commands',
  skillsDir: '~/.config/opencode/skills',
  agentsDir: '~/.config/opencode/agents',
  toolNameMap: { Read: 'read', Glob: 'glob', Grep: 'grep', Bash: 'bash' },
};
```

- [ ] **Step 2: 更新 `src/host/claude-code/adapter.ts`**

```ts
import type { HostAdapter } from '../types.js';

export type { HostAdapter };

export const claudeCodeAdapter: HostAdapter = {
  name: 'claude-code',
  agentTools: ['Read', 'Glob', 'Grep', 'Bash'],
};
```

- [ ] **Step 3: 更新 `src/host/opencode/adapter.ts`**

```ts
import type { HostAdapter } from '../types.js';

export type { HostAdapter };

export const opencodeAdapter: HostAdapter = {
  name: 'opencode',
  agentTools: ['read', 'glob', 'grep', 'bash'],
};
```

- [ ] **Step 4: 写 adapter 类型测试**

```ts
// src/host/__tests__/types.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_CODE_MANIFEST, OPENCODE_MANIFEST } from '../types.js';

test('CLAUDE_CODE_MANIFEST adapter uses PascalCase tools', () => {
  assert.equal(CLAUDE_CODE_MANIFEST.adapter.name, 'claude-code');
  assert.deepEqual(CLAUDE_CODE_MANIFEST.adapter.agentTools, ['Read', 'Glob', 'Grep', 'Bash']);
});

test('OPENCODE_MANIFEST adapter uses lowercase tools', () => {
  assert.equal(OPENCODE_MANIFEST.adapter.name, 'opencode');
  assert.deepEqual(OPENCODE_MANIFEST.adapter.agentTools, ['read', 'glob', 'grep', 'bash']);
});

test('toolNameMap mappings are consistent', () => {
  assert.equal(CLAUDE_CODE_MANIFEST.toolNameMap['read'], 'Read');
  assert.equal(OPENCODE_MANIFEST.toolNameMap['Bash'], 'bash');
});
```

Run: `node --import tsx --test src/host/__tests__/types.test.ts`
Expected: 3/3 PASS

- [ ] **Step 5: 写 opencode adapter 对象测试**

```ts
// src/host/__tests__/opencode_adapter.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opencodeAdapter } from '../opencode/adapter.js';
import { claudeCodeAdapter } from '../claude-code/adapter.js';

test('opencodeAdapter name is opencode', () => {
  assert.equal(opencodeAdapter.name, 'opencode');
});

test('opencodeAdapter agentTools are lowercase', () => {
  assert.deepEqual(opencodeAdapter.agentTools, ['read', 'glob', 'grep', 'bash']);
});

test('claudeCodeAdapter name is claude-code', () => {
  assert.equal(claudeCodeAdapter.name, 'claude-code');
});

test('claudeCodeAdapter agentTools are PascalCase', () => {
  assert.deepEqual(claudeCodeAdapter.agentTools, ['Read', 'Glob', 'Grep', 'Bash']);
});
```

Run: `node --import tsx --test src/host/__tests__/opencode_adapter.test.ts`
Expected: 4/4 PASS

- [ ] **Step 6: 创建 `commands/review-opencode.md`**

这是最大的一块。基于 `commands/review.md` 但所有并行 dispatch 改为顺序 for 循环，工具名全部小写：

```markdown
---
description: |
  Run the open-code-review-plugin code review on a git change set. Pass-through
  flags align with alibaba/open-code-review CLI: workspace (default), --staged,
  --commit <sha>, --from <a> --to <b>, --paths, --background, --rules.
argument-hint: "[workspace|staged|<sha>|<from>..<to>] [--background \"...\"]"
allowed-tools: read, glob, grep, bash, write
---

# /review — open-code-review-plugin (OpenCode)

Run a code review on the current git change set.

**⚠️ OpenCode does not support parallel subagent dispatch.** Review runs
sequentially — one file at a time. For large changesets with many files,
consider narrowing scope with `--paths <glob>` or `--rules` include patterns.

## Workflow

You are orchestrating a code review. Follow these steps in order.

### Step 1 — Prepare

Run bash:

```bash
ocr-prepare $ARGUMENTS
```

Capture the stdout JSON. It contains `runId`, `fileCount`, `hunkCount`,
`changedLines`, `contextPath`, `concurrency`, `preview`, `dryRun`, `resumed`,
`remainingFileCount`, `rulesSource`, `excludedFileCount`, and `fileCountWarning`.
If `concurrency` is absent, use `2`.

If `fileCount` is 0 → tell the user "No changes to review." and stop.
This is a successful skipped review, not a hard failure.
If the command exits non-zero → surface the stderr to the user and stop.

If `fileCountWarning == true` → warn the user:
"⚠️ This review spans <fileCount> files. OpenCode reviews files sequentially
(no parallel dispatch). Consider narrowing scope with `--paths <glob>` or
`--rules` include patterns. Proceeding with review of all <fileCount> files."

If `preview == true` or `dryRun == true`:
1. Read `.ocr-runs/<runId>/context.json`.
2. Reply with a preview summary and then stop.
   (same structure as claude-code `commands/review.md` Step 1)
3. See the claude-code review.md for the exact report template.

### Step 2 — Plan (only when changedLines >= 50)

Same as claude-code review.md Step 2.

### Step 3 — Review files sequentially

Process `context.files[]` **one at a time, in order**. There is no batching
or concurrent dispatch in OpenCode.

For **each** file:
0. Skip files where `skipped === true`; mention them at the end.
1. Compute `planGuidance` deterministically (same as cc Step 3.1).
2. Compute `systemRule` (same as cc Step 3.2).
3. Read the diff and apply the **ocr-review-file** skill:
   - Use `read` to load `.ocr-runs/<runId>/context.json`
   - The diff for the current file is in `context.files[].diff`
   - Apply `skills/open-code-review/ocr-review-file` skill focusing on the
     current file
4. For each confirmed issue, run bash:
   ```bash
   code_comment --runId <runId> --args '{"path":"<currentFilePath>","subagent":"reviewer-<index>","comments":[...]}'
   ```
5. After all comments submitted, run bash:
   ```bash
   task_done --runId <runId> --args '{"subagent":"reviewer-<index>","file":"<currentFilePath>"}'
   ```
6. If the skill invocation errors, retry once for the same file.
7. If both attempts fail, continue to the next file — `ocr-aggregate` will
   report it as partial.

### Step 3.5 — Per-file filter (same as cc Step 3.5, but sequential)

After each file review, run filtering:
1. Read `.ocr-runs/<runId>/comments.jsonl`, select this file's comments.
2. If zero comments, skip.
3. Invoke `ocr-review-filter` skill.
4. Run: `ocr-filter-apply --runId <runId> --path <currentFilePath> ...`
5. Soft failure → continue without filtering.

### Step 3.6 — Line relocation (same as cc Step 3.6)

After each file's filter:
```bash
ocr-relocate-apply --runId <runId> --path <currentFilePath>
```
Soft failure → aggregate uses original line ranges.

### Step 4 — Aggregate

Same as claude-code Step 4.

### Step 5 — Present to user

Same as claude-code Step 5.

### Step 6 — Post to PR (optional)

Same as claude-code Step 6 (inline review comments with fallback).

## Error handling

| Error code | What to do |
|---|---|
| OCRP-LOAD-002 | "Plugin not built — run `npm run build`." |
| OCRP-RUN-010 | "Not a git repository. Run `/review` inside a git repo." |
| OCRP-RUN-011 | "Argument conflict or unsupported flag: <message>." |
| OCRP-RUN-012 | "No changes to review." (exit 0) |
| OCRP-SKILL-040 | Continue without plan_guidance. |
| OCRP-SUB-050/051 | Already surfaced by ocr-aggregate as partial. |
| OCRP-HOOK-060 | Silent — events.jsonl not available on OpenCode. |
| OCRP-FILTER-070 | Continue without filtering. |
| OCRP-FILTER-071 | Filter rejected path; soft failure. |
| OCRP-FILTER-072 | Malformed filter decisions; soft failure. |
| OCRP-RELOCATE-080 | Relocation failed; use original line ranges. |
| OCRP-RELOCATE-081 | Relocation input references path outside review context. |
| OCRP-RELOCATE-082 | Relocation decision malformed. |
| OCRP-RULES-090/091/092/093 | Custom rules error; stop. |
| OCRP-RULES-094 | Effective rule text not loaded; continue with empty rule. |
```

```bash
cat > commands/review-opencode.md << 'CMDFILE'
---
description: |
  Run the open-code-review-plugin code review on a git change set. Pass-through
  flags align with alibaba/open-code-review CLI: workspace (default), --staged,
  --commit <sha>, --from <a> --to <b>, --paths, --background, --rules.
argument-hint: "[workspace|staged|<sha>|<from>..<to>] [--background \"...\"]"
allowed-tools: read, glob, grep, bash, write
---

# /review — open-code-review-plugin (OpenCode)

Run a code review on the current git change set.

**⚠️ OpenCode does not support parallel subagent dispatch.** Review runs
sequentially — one file at a time. For large changesets with many files,
consider narrowing scope with `--paths <glob>` or `--rules` include patterns.

## Workflow

You are orchestrating a code review. Follow these steps in order.

### Step 1 — Prepare

Run bash:

```bash
ocr-prepare $ARGUMENTS
```

Capture the stdout JSON. It contains `runId`, `fileCount`, `hunkCount`,
`changedLines`, `contextPath`, `concurrency`, `preview`, `dryRun`, `resumed`,
`remainingFileCount`, `rulesSource`, `excludedFileCount`, and `fileCountWarning`.
If `concurrency` is absent, use `2`.

If `fileCount` is 0 → tell the user "No changes to review." and stop.
This is a successful skipped review, not a hard failure.
If the command exits non-zero → surface the stderr to the user and stop.

If `fileCountWarning == true` → warn the user:
"⚠️  This review spans <fileCount> files. OpenCode reviews files sequentially
(no parallel dispatch). Consider narrowing scope with `--paths <glob>` or
`--rules` include patterns. Proceeding with review of all <fileCount> files."

If `preview == true` or `dryRun == true`:
1. Read `.ocr-runs/<runId>/context.json`.
2. Reply with a preview summary and stop. Do not continue to later steps.

The preview format mirrors the claude-code command: a Markdown table listing
files with their status, hunk count, changed lines, and matching rule.

### Step 2 — Plan (only when changedLines >= 50)

If `changedLines >= 50`:
1. Read `.ocr-runs/<runId>/context.json`.
2. Invoke the `ocr-plan` skill with runId.
3. Parse the fenced ```json PlanOutput.
4. Write to `.ocr-runs/<runId>/plan.json`.

### Step 3 — Review files sequentially

Process `context.files[]` **one at a time, in order**. There is no batching
or concurrent dispatch in OpenCode.

For **each** file:

0. Skip files where `skipped === true`; mention them in the final report
   under "Skipped files" with their path and skipReason. Do not review.

1. **planGuidance** — If `.ocr-runs/<runId>/plan.json` exists, run:
   ```bash
   ocr-plan-guidance --runId <runId> --path <currentFilePath>
   ```
   Parse stdout and use its `guidance` field. On failure, set guidance to ""
   and mention `OCRP-SKILL-040`.

2. **systemRule** — Compute from `context.files[].rulesHit[0]`:
   - If `rulesHit[0].text` is non-empty, use it.
   - Else if `rulesHit[0].message` is non-empty, use it.
   - Else read `assets/rule_docs/<rulesHit[0].docPath>`.
   - Else use empty string and mention `OCRP-RULES-094`.

3. Apply the **ocr-review-file** skill with the current file's diff. Use
   `read` to access `.ocr-runs/<runId>/context.json`. The diff for the
   current file is in `context.files[].diff`.

4. For each confirmed issue, run bash:
   ```bash
   code_comment --runId <runId> --args '{"path":"<currentFilePath>","subagent":"reviewer-<index>","comments":[...]}'
   ```

5. After all comments submitted, run bash:
   ```bash
   task_done --runId <runId> --args '{"subagent":"reviewer-<index>","file":"<currentFilePath>"}'
   ```

6. If the skill invocation errors, retry exactly once for the same file with
   attempt-2 labeling. If both attempts fail, continue to the next file —
   `ocr-aggregate` will report it as partial (`OCRP-SUB-050/051`).

### Step 3.5 — Per-file filter

After each file's review:
1. Read `.ocr-runs/<runId>/comments.jsonl`, select this file's comments.
2. If zero comments, skip filter for this file.
3. Invoke `ocr-review-filter` skill with: runId, subagent `filter-<index>`,
   currentFilePath, currentFileDiff, requirementBackground, systemRule,
   planGuidance, candidateComments.
4. Capture fenced ```json FilterFileResult.
5. Run:
   ```bash
   ocr-filter-apply --runId <runId> --path <currentFilePath> --input '<json>' --subagent filter-<index>
   ```
6. On parse error or apply non-zero → soft failure, mention `OCRP-FILTER-070`.

### Step 3.6 — Line relocation

After filter:
1. If zero visible comments, skip.
2. Run:
   ```bash
   ocr-relocate-apply --runId <runId> --path <currentFilePath>
   ```
3. Non-zero → retry once. Second failure → soft failure (`OCRP-RELOCATE-080`).

### Step 4 — Aggregate

After all files complete:

```bash
ocr-aggregate --runId <runId> --format both
```

Stdout JSON contains `reportMd`, `reportJson`, `partial`, `partialFiles`,
`rawCommentCount`, `commentCount`, `filteredCommentCount`, `filterWarnings`,
`relocationWarnings`.

### Step 5 — Present to user

Read `.ocr-runs/<runId>/report.md` and reply with its full contents inline.
Also tell the user artifact paths.

If `partial == true`, prefix: `⚠️ Some files did not complete review; see Warnings section.`

### Step 6 — Post to PR (optional)

If the user requests posting:
```bash
ocr-post-comments --runId <runId> --provider <github|gitlab> --pr <number>
```
Use `--dry-run` to preview without posting. Use `--retry 1` for single retry.

Comments are posted as inline review comments with three-level fallback.

## Error handling

| Error code | What to do |
|---|---|
| OCRP-LOAD-002 | "Plugin not built — run `npm run build`." |
| OCRP-RUN-010 | "Not a git repository." |
| OCRP-RUN-011 | "Argument conflict or unsupported flag." |
| OCRP-RUN-012 | "No changes to review." (exit 0) |
| OCRP-SKILL-040 | Continue without plan guidance. |
| OCRP-SUB-050/051 | Surfaced by ocr-aggregate as partial. |
| OCRP-HOOK-060 | Silent — events.jsonl not available on OpenCode. |
| OCRP-FILTER-070 | Continue without filtering that file. |
| OCRP-FILTER-071 | Path outside review context; soft failure. |
| OCRP-FILTER-072 | Malformed filter decisions; soft failure. |
| OCRP-RELOCATE-080 | Relocation failed; use original line ranges. |
| OCRP-RELOCATE-081/082 | Relocation path/datum error; soft failure. |
| OCRP-RULES-090/091/092/093 | Custom rules error; stop. |
| OCRP-RULES-094 | Rule text not loaded; continue with empty rule. |
CMDFILE
```

- [ ] **Step 7: 更新 `scripts/install-opencode.sh`**

```bash
#!/bin/bash
set -euo pipefail
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPN_DIR="${HOME}/.config/opencode"

echo "[install-opencode] installing to ${OPN_DIR}"

# commands — /review entry
mkdir -p "${OPN_DIR}/commands"
cp "${PLUGIN_DIR}/commands/review-opencode.md" "${OPN_DIR}/commands/review.md"
echo "  command: ${OPN_DIR}/commands/review.md"

# skills (subdirectory for the review skill group)
mkdir -p "${OPN_DIR}/skills/open-code-review"
for skill in ocr-plan ocr-relocate ocr-review-file ocr-review-filter; do
  cp "${PLUGIN_DIR}/skills/${skill}/SKILL.md" "${OPN_DIR}/skills/open-code-review/${skill}.md"
  echo "  skill: ${OPN_DIR}/skills/open-code-review/${skill}.md"
done

# agent
mkdir -p "${OPN_DIR}/agents"
cp "${PLUGIN_DIR}/agents/ocr-reviewer-opencode.md" "${OPN_DIR}/agents/ocr-reviewer.md"
echo "  agent: ${OPN_DIR}/agents/ocr-reviewer.md"

echo "[install-opencode] done"
```

- [ ] **Step 8: 更新 `src/host/opencode/README.md`**

```markdown
# opencode HostAdapter

Cross-host adapter for OpenCode. Review command, skills, and agents are
installed to `~/.config/opencode/` via `scripts/install-opencode.sh`.

## Installation

```bash
./scripts/install-opencode.sh
```

## Differences from Claude Code

| Feature | Claude Code | OpenCode |
|---|---|---|
| Parallel review | ✅ batches of `reviewConcurrency` | ❌ sequential (single-agent) |
| Event bus | ✅ events.jsonl + hooks | ❌ not available |
| Custom rules | ✅ (same CLI) | ✅ (same CLI) |
| Resume | ✅ (same CLI) | ✅ (same CLI) |
| Preview / dry-run | ✅ | ✅ |

## Tool name convention

OpenCode uses **lowercase** tool names (`allowed-tools` frontmatter).
The adapter and agent definitions export this mapping automatically.

## Testing

After install, verify with:

```bash
opencode debug skill       # should list open-code-review skills
opencode debug agent ocr-reviewer  # should show reviewer agent
```
```

- [ ] **Step 9: 运行 typecheck 确认无编译错误**

```bash
cd /Users/lixiangyang/Desktop/代码/open-code-review-plugin
npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 10: 运行构建确认构建产物正确**

```bash
npm run build
ls -la dist/host/types.mjs dist/host/claude-code/adapter.mjs dist/host/opencode/adapter.mjs
```

Expected: 三个文件均存在

- [ ] **Step 11: 运行安装脚本**

```bash
bash scripts/install-opencode.sh
```

Expected: 输出类似 `[install-opencode] done`，无错误

- [ ] **Step 12: 验证 OpenCode 可发现 skill**

```bash
opencode debug skill 2>&1 | grep -i "ocr\|open-code\|review"
```

Expected: 输出中包含 `ocr-plan`、`ocr-review-file` 等 skill 名

- [ ] **Step 13: 运行全套测试**

```bash
node --import tsx --test src/**/__tests__/*.test.ts
```

Expected: 全部 PASS（含旧测试无回归）

- [ ] **Step 14: Commit**

```bash
git add src/host/types.ts \
  src/host/claude-code/adapter.ts \
  src/host/opencode/adapter.ts \
  src/host/__tests__/types.test.ts \
  src/host/__tests__/opencode_adapter.test.ts \
  commands/review-opencode.md \
  scripts/install-opencode.sh \
  src/host/opencode/README.md
git commit -m "feat(opencode): complete HostAdapter, sequential review command, install to ~/.config/opencode

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: 最终验证

**Files:**
- 无新建 — 运行跨模块回归测试

**Interfaces:**
- Consumes: 任务 1-4 的所有产物
- Produces: 无（纯验证）

- [ ] **Step 1: 运行全量测试**

```bash
node --import tsx --test src/**/__tests__/*.test.ts
```

Expected: 所有测试 PASS

- [ ] **Step 2: 运行 typecheck**

```bash
npx tsc --noEmit
```

Expected: 0 errors

- [ ] **Step 3: 运行构建**

```bash
npm run build
```

Expected: build 成功，`dist/` 和 `bin/` 产物齐全

- [ ] **Step 4: 确认 git status 干净**

```bash
git status
```

Expected: no uncommitted changes（所有变更已通过 4 个 milestone commit 提交）
