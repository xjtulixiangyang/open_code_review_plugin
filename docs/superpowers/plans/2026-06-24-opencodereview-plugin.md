# open-code-review-plugin 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 alibaba/open-code-review (OCR) 的代码审查能力以 Claude Code 插件形态交付：保留 OCR 的 diff 解析、规则匹配、Prompt 模板和 LlmComment 数据契约，但全部 LLM 推理委托给宿主 Claude Code 自身的 agent loop（主会话编排 + reviewer subagent 并行评审）。

**Architecture:** TS 单一源 → tsc → `dist/**/*.mjs` + `bin/*` 可执行入口；编排骨架 (`commands/review.md`) + Prompt (`skills/*/SKILL.md`) + 工具 CLI (`bin/`) + 事件 hook (`hooks/hooks.json`) 四件套；运行时通过 `.ocr-runs/<runId>/` jsonl 总线 + PostToolUse hook 双通道传递评审结果。

**Tech Stack:** TypeScript 5.5 strict mode · Node 20 ESM (`.mjs`) · 零运行期 npm 依赖 · Claude Code Plugin 规范 · git CLI 子进程 · node --test (Node 内置测试)

## Global Constraints

- 设计文档：`docs/superpowers/specs/2026-06-24-opencodereview-plugin-design.md`（所有 §x 引用均指该文档）
- 运行时：Node ≥ 18（实际目标 Node 20，使用 `node --test`）；ESM only
- 产物：`dist/**/*.mjs` + `bin/*`（可执行），零运行期 npm 依赖（仅 git CLI）
- TypeScript 严格模式（`strict: true`），现有 tsconfig.json 不变
- 不引入任何 LLM SDK / HTTP 客户端 / API Key 字段
- `.claude-plugin/plugin.json` 的 `name` 字段固定为 `open-code-review`（与 OCR plugin 同名，详见 §2.2）
- LlmComment / PlanOutput 字段名与 OCR 原版**完全一致**（含 snake_case），不擅自改名
- PLAN_TASK / MAIN_TASK system prompt 文字逐字保留 OCR `task_template.json` 原文，仅替换 6 行工具说明
- 常量同步 OCR：`PLAN_MODE_LINE_THRESHOLD = 50`、`MAX_TOKENS = 58888`
- OCR 参考源码：`/Users/lixiangyang/Desktop/代码/open-code-review/`（只读，不修改）
- 项目根：`/Users/lixiangyang/Desktop/代码/open-code-review-plugin/`
- `node --test` 是默认测试运行器；测试文件命名 `*.test.ts`，放在 `src/**/__tests__/` 下；构建产物 `dist/**/__tests__/*.test.mjs` 直接由 node 执行
- 项目尚未初始化为 git repo；T1 包含 `git init`
- 所有 git 提交消息使用中文短句，结尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`

---

## File Structure（实施总览）

**新建（按 task 顺序）：**

```
.gitignore                                  # T1
.claude-plugin/plugin.json                  # T1（覆盖现有）
src/core/types.ts                           # T2
src/core/model/comment.ts                   # T2
src/core/model/plan.ts                      # T2
src/core/model/request.ts                   # T2
src/core/runs/store.ts                      # T3 (+ __tests__/store.test.ts)
src/core/allowlist/supported_file_types.json   # T4（OCR 复制）
src/core/allowlist/default_exclude_patterns.json  # T4（OCR 复制）
src/core/allowlist/allowed_ext.ts           # T4 (+ __tests__/allowed_ext.test.ts)
src/core/diff/git.ts                        # T5
src/core/diff/parser.ts                     # T5 (+ __tests__/parser.test.ts)
src/core/diff/hunk.ts                       # T5
src/core/diff/workspace.ts                  # T5
src/core/rules/system_rules.json            # T6（OCR 复制）
src/core/rules/matcher.ts                   # T6 (+ __tests__/matcher.test.ts)
src/core/rules/system_rules.ts              # T6
assets/rule_docs/*.md                       # T6（OCR 16 个 .md 直接复制）
src/core/prompts/constants.ts               # T7
src/core/prompts/render.ts                  # T7 (+ __tests__/render.test.ts)
src/core/prompts/main_task.ts               # T7
src/core/prompts/plan_task.ts               # T7
src/core/prompts/plan_guidance.ts           # T7 (+ __tests__/plan_guidance.test.ts)
src/core/context/review_context.ts          # T8
src/cli/prepare.ts                          # T8
bin/ocr-prepare                             # T8（构建产物，软链）
src/cli/code_comment.ts                     # T9
src/cli/task_done.ts                        # T9
src/cli/file_read_diff.ts                   # T9
bin/code_comment, bin/task_done, bin/file_read_diff  # T9
scripts/shebang.mjs                         # T10
src/host/claude-code/hook_handler.ts        # T11 (+ __tests__/hook_handler.test.ts)
hooks/hooks.json                            # T11
src/core/report/markdown.ts                 # T12 (+ __tests__/markdown.test.ts)
src/core/report/json.ts                     # T12
src/cli/aggregate.ts                        # T12
src/cli/rules_check.ts                      # T12
bin/ocr-aggregate, bin/ocr-rules-check      # T12
skills/ocr-plan/SKILL.md                    # T13
skills/ocr-review-file/SKILL.md             # T13
agents/ocr-reviewer.md                      # T13
commands/review.md                          # T13（覆盖现有）
src/host/opencode/README.md                 # T13（占位）
scripts/smoke.sh                            # T14
README.md                                   # T15
LICENSE                                     # T15
```

**修改：**

```
src/index.ts                                # T2（删除占位实现，re-export 类型）
package.json                                # T1, T10, T14（scripts 增量）
```

**保留不动：**

```
tsconfig.json
scripts/build-mjs.mjs
```

---

### Task 1: 项目初始化 - git + .gitignore + plugin.json + npm test 脚本

**Files:**
- Create: `.gitignore`
- Create/Overwrite: `.claude-plugin/plugin.json`
- Modify: `package.json`（增加 `test` / `test:tsc` 脚本，新增 `tsx` devDep）

**Interfaces:**
- Consumes: —
- Produces: 一个 git repo + 可执行的 `npm test` 命令（即便没有测试也输出 "no tests yet"）

- [ ] **Step 1: 初始化 git 仓库**

Run:
```bash
cd /Users/lixiangyang/Desktop/代码/open-code-review-plugin
git init -b main
```

Expected output: `Initialized empty Git repository in …/.git/`

- [ ] **Step 2: 写 .gitignore**

Create `/Users/lixiangyang/Desktop/代码/open-code-review-plugin/.gitignore`:
```gitignore
# Build artifacts
dist/
bin/*
!bin/.gitkeep

# Node
node_modules/
npm-debug.log*

# Runtime
.ocr-runs/
.superpowers/

# OS
.DS_Store

# Editor
.vscode/
.idea/

# Legacy debug logs
.claude-sdk-debug.log
latest
```

并创建空文件 `bin/.gitkeep`：
```bash
mkdir -p bin && touch bin/.gitkeep
```

- [ ] **Step 3: 覆盖 .claude-plugin/plugin.json**

Overwrite `/Users/lixiangyang/Desktop/代码/open-code-review-plugin/.claude-plugin/plugin.json`:
```json
{
  "name": "open-code-review",
  "version": "0.1.0",
  "description": "AI-powered code review plugin for Claude Code. Reuses alibaba/open-code-review review semantics; delegates all LLM reasoning to the host Claude Code agent loop.",
  "author": {
    "name": "open-code-review-plugin contributors"
  },
  "commands": "./commands",
  "skills": "./skills",
  "agents": "./agents",
  "hooks": "./hooks/hooks.json"
}
```

注意：`name` 字段固定为 `open-code-review`（详见 spec §2.2，与 OCR plugin 同名以保持 UX 一致；README 中显式提示冲突解决）。

- [ ] **Step 4: 修改 package.json 增加测试脚本与 tsx 依赖**

`tsx` 用来让 `node --test` 直接执行 `.ts` 文件，避免每次都跑完整构建。修改 `package.json` 的 `scripts` 和 `devDependencies` 字段（保留其他字段不变）：

```json
{
  "scripts": {
    "clean": "rm -rf dist",
    "build:tsc": "tsc -p tsconfig.json",
    "build:mjs": "node scripts/build-mjs.mjs",
    "build": "npm run clean && npm run build:tsc && npm run build:mjs",
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test src/**/__tests__/*.test.ts",
    "preview": "ls -la dist/"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0"
  }
}
```

注意：保留 `name`/`version`/`description`/`type`/`main`/`exports`/`files`/`keywords`/`engines`/`license` 等其他字段不变。

- [ ] **Step 5: 安装 tsx**

Run:
```bash
cd /Users/lixiangyang/Desktop/代码/open-code-review-plugin
npm install
```

Expected: 安装成功，`node_modules/tsx/` 出现。

- [ ] **Step 6: 验证 npm test 可运行（即便无测试）**

Run:
```bash
npm test 2>&1 | head -10
```

Expected: 退出码 0 或 1 均可，但不应为 "command not found"；可能输出类似 "ℹ tests 0" 或 glob 无匹配的提示。这里只验证脚本本身可拉起。

- [ ] **Step 7: 首次提交**

Run:
```bash
git add .
git commit -m "chore: 初始化 plugin 项目与 git

- git init + .gitignore
- 覆盖 .claude-plugin/plugin.json (name=open-code-review, version=0.1.0)
- package.json 增加 test 脚本与 tsx devDep
- 占位 bin/.gitkeep

Co-Authored-By: Claude <noreply@anthropic.com>"
```

Expected: 成功创建首个 commit。

---

### Task 2: 核心数据模型 - types + LlmComment + PlanOutput + ReviewRequest

**Files:**
- Create: `src/core/types.ts`
- Create: `src/core/model/comment.ts`
- Create: `src/core/model/plan.ts`
- Create: `src/core/model/request.ts`
- Modify: `src/index.ts`（删占位 review()，re-export 类型）

**Interfaces:**
- Consumes: —
- Produces:
  - `LlmComment` 类型（snake_case 字段，对齐 OCR）：`{path, start_line, end_line, content, suggestion_code?, existing_code?, thinking?}`
  - `PlanOutput` 类型：`{change_summary, issues: PlanIssue[]}`
  - `ReviewRequest` 类型：`{repoRoot, mode, commit?, from?, to?, paths?, background?, rulesPath?, dryRun?, format?, concurrency?}`
  - `Hunk`、`DiffLine`、`FileChange`、`RuleHit`、`ReviewContext` 类型（spec §3.1）

- [ ] **Step 1: 写 src/core/types.ts**

Create:
```typescript
/**
 * 共享类型 - 全文件唯一不依赖任何外部模块，可被 core/host/cli 任意 import。
 * 字段命名规则：
 *   - 与 OCR Go 原版对齐的 JSON 持久化结构使用 snake_case
 *     (例：LlmComment.start_line, PlanOutput.change_summary)
 *   - 仅在 TS 内部流转、不写入 jsonl 的中间结构使用 camelCase
 *     (例：ReviewContext.repoRoot, FileChange.oldPath)
 */

export type Severity = 'high' | 'medium' | 'low';

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'binary';

export type ReviewMode = 'workspace' | 'staged' | 'commit' | 'range';
```

- [ ] **Step 2: 写 src/core/model/comment.ts (LlmComment)**

Create:
```typescript
/**
 * LlmComment - 字段与 alibaba/open-code-review internal/model/review.go 完全对齐 (snake_case)。
 * 这是写入 .ocr-runs/<runId>/comments.jsonl 的每行 schema，也是
 * report.json 中 comments[] 的元素 schema (OCR 兼容性保证)。
 */
export interface LlmComment {
  path: string;
  start_line: number;
  end_line: number;
  content: string;
  suggestion_code?: string;
  existing_code?: string;
  thinking?: string;
}

/** jsonl 一行的完整内容 (LlmComment + 元数据)。 */
export interface CommentRecord extends LlmComment {
  _meta?: {
    subagent?: string;
    ts?: string;
  };
}
```

- [ ] **Step 3: 写 src/core/model/plan.ts (PlanOutput)**

Create:
```typescript
import type { Severity } from '../types.js';

/**
 * PlanOutput - 与 OCR task_template.json::PLAN_TASK 的 Output Format 一致。
 */
export interface PlanIssue {
  severity: Severity;
  description: string;
  tool_guidance: Array<{
    name: string;
    reason: string;
    arguments: string;
  }>;
  /** 可选扩展：插件层为定位文件而新增的提示字段；OCR 原版无此字段，仅向后兼容追加。 */
  file_hint?: string;
}

export interface PlanOutput {
  change_summary: string;
  issues: PlanIssue[];
}
```

- [ ] **Step 4: 写 src/core/model/request.ts (ReviewRequest, FileChange, Hunk, RuleHit, ReviewContext)**

Create:
```typescript
import type { FileStatus, ReviewMode } from '../types.js';

export interface DiffLine {
  kind: '+' | '-' | ' ';
  oldLineNo: number;
  newLineNo: number;
  text: string;
}

export interface Hunk {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface RuleHit {
  ruleId: string;
  message: string;
  docPath?: string;
}

export interface FileChange {
  path: string;
  oldPath?: string;
  status: FileStatus;
  diff: string;
  truncated: boolean;
  hunks: Hunk[];
  rulesHit: RuleHit[];
}

export interface ReviewRequest {
  repoRoot: string;
  mode: ReviewMode;
  commit?: string;
  from?: string;
  to?: string;
  paths?: string[];
  background?: string;
  rulesPath?: string;
  dryRun?: boolean;
  format?: 'markdown' | 'json' | 'both';
  concurrency?: number;
  maxHunkLines?: number;
}

export interface ReviewContext {
  runId: string;
  repoRoot: string;
  range: string;
  background: string;
  files: FileChange[];
  changeFiles: string[];
  meta: {
    generatedAt: string;
    pluginVersion: string;
  };
}
```

- [ ] **Step 5: 改 src/index.ts (re-export 类型，删占位 review())**

Overwrite `src/index.ts`:
```typescript
/**
 * open-code-review-plugin - Claude Code plugin entry.
 *
 * Design invariant: this module and every module reachable from it MUST NOT
 * perform any HTTP call to an LLM provider. All language-model decisions are
 * delegated to the host Claude Code session via:
 *   - commands/review.md  (the /review slash command)
 *   - agents/ocr-reviewer.md  (reviewer subagent)
 *   - skills/ocr-plan/SKILL.md, skills/ocr-review-file/SKILL.md  (prompts)
 *
 * Public surface: type re-exports for downstream tooling / tests.
 */

export const PLUGIN_NAME = 'open-code-review' as const;
export const VERSION = '0.1.0' as const;

export type { LlmComment, CommentRecord } from './core/model/comment.js';
export type { PlanOutput, PlanIssue } from './core/model/plan.js';
export type {
  ReviewRequest,
  ReviewContext,
  FileChange,
  Hunk,
  DiffLine,
  RuleHit,
} from './core/model/request.js';
export type { Severity, FileStatus, ReviewMode } from './core/types.js';
```

- [ ] **Step 6: 运行 typecheck 验证**

Run:
```bash
npm run typecheck
```

Expected: 退出码 0，无错误。

- [ ] **Step 7: 提交**

```bash
git add src/
git commit -m "feat: 核心数据模型 (LlmComment / PlanOutput / ReviewRequest / ReviewContext)

- 字段与 OCR Go 原版对齐 (snake_case for jsonl schemas)
- src/index.ts 改为类型 re-export，移除占位 review()

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 运行时 store - .ocr-runs/<runId>/ 路径与 jsonl 读写

**Files:**
- Create: `src/core/runs/store.ts`
- Create: `src/core/runs/__tests__/store.test.ts`

**Interfaces:**
- Consumes: T2 的 `CommentRecord`、`ReviewContext`、`PlanOutput`
- Produces:
  - `newRunId(): string` — 形如 `20260624-153012-a1b2`（时间戳 + 4 字符随机）
  - `runDir(runId, repoRoot?): string` — 返回 `<cwd>/.ocr-runs/<runId>/` 绝对路径
  - `writeContext(runId, ctx: ReviewContext): Promise<void>`
  - `readContext(runId): Promise<ReviewContext>`
  - `appendComment(runId, c: CommentRecord): Promise<void>` — 原子 append (`O_APPEND`)
  - `readComments(runId): Promise<CommentRecord[]>`
  - `writePlan(runId, p: PlanOutput): Promise<void>`
  - `readPlan(runId): Promise<PlanOutput | null>`
  - `appendEvent(runId, e: object): Promise<void>`
  - `markDone(runId, subagent, file): Promise<void>` — 写 `done/<subagent>.json`
  - `listDone(runId): Promise<Array<{subagent, file}>>`
  - `writeReport(runId, name: 'report.md' | 'report.json', body: string): Promise<void>`

- [ ] **Step 1: 写失败测试 src/core/runs/__tests__/store.test.ts**

Create:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newRunId,
  runDir,
  writeContext,
  readContext,
  appendComment,
  readComments,
  writePlan,
  readPlan,
  appendEvent,
  markDone,
  listDone,
  writeReport,
} from '../store.js';
import type { ReviewContext } from '../../model/request.js';
import type { CommentRecord } from '../../model/comment.js';
import type { PlanOutput } from '../../model/plan.js';

const tempRoots: string[] = [];

async function setupTempRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-store-'));
  tempRoots.push(dir);
  const cwdBefore = process.cwd();
  process.chdir(dir);
  return { dir, restore: () => process.chdir(cwdBefore) };
}

test.after(async () => {
  for (const d of tempRoots) await rm(d, { recursive: true, force: true });
});

test('newRunId 格式正确', () => {
  const id = newRunId();
  assert.match(id, /^\d{8}-\d{6}-[a-z0-9]{4}$/);
});

test('newRunId 互不相同', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newRunId()));
  assert.equal(ids.size, 50);
});

test('runDir 返回 .ocr-runs/<runId> 绝对路径', async () => {
  const { dir, restore } = await setupTempRepo();
  try {
    const id = 'fake-id';
    const p = runDir(id);
    assert.equal(p, join(dir, '.ocr-runs', id));
  } finally {
    restore();
  }
});

test('writeContext + readContext 往返一致', async () => {
  const { restore } = await setupTempRepo();
  try {
    const id = newRunId();
    const ctx: ReviewContext = {
      runId: id,
      repoRoot: '/abs',
      range: 'workspace',
      background: '',
      files: [],
      changeFiles: [],
      meta: { generatedAt: new Date().toISOString(), pluginVersion: '0.1.0' },
    };
    await writeContext(id, ctx);
    const back = await readContext(id);
    assert.deepEqual(back, ctx);
  } finally {
    restore();
  }
});

test('appendComment 串行 N 次 + readComments 顺序保留', async () => {
  const { restore } = await setupTempRepo();
  try {
    const id = newRunId();
    const N = 5;
    for (let i = 0; i < N; i++) {
      const c: CommentRecord = {
        path: `f${i}.ts`,
        start_line: i,
        end_line: i,
        content: `c${i}`,
      };
      await appendComment(id, c);
    }
    const all = await readComments(id);
    assert.equal(all.length, N);
    for (let i = 0; i < N; i++) assert.equal(all[i].content, `c${i}`);
  } finally {
    restore();
  }
});

test('writePlan + readPlan 往返', async () => {
  const { restore } = await setupTempRepo();
  try {
    const id = newRunId();
    const p: PlanOutput = { change_summary: 's', issues: [] };
    assert.equal(await readPlan(id), null);
    await writePlan(id, p);
    assert.deepEqual(await readPlan(id), p);
  } finally {
    restore();
  }
});

test('markDone + listDone', async () => {
  const { restore } = await setupTempRepo();
  try {
    const id = newRunId();
    await markDone(id, 'reviewer-a', 'src/a.ts');
    await markDone(id, 'reviewer-b', 'src/b.ts');
    const dones = await listDone(id);
    assert.equal(dones.length, 2);
    const files = dones.map((d) => d.file).sort();
    assert.deepEqual(files, ['src/a.ts', 'src/b.ts']);
  } finally {
    restore();
  }
});

test('appendEvent 写入 events.jsonl', async () => {
  const { dir, restore } = await setupTempRepo();
  try {
    const id = newRunId();
    await appendEvent(id, { type: 'tool_call', tool: 'code_comment' });
    const body = await readFile(join(dir, '.ocr-runs', id, 'events.jsonl'), 'utf8');
    assert.match(body, /"type":"tool_call"/);
  } finally {
    restore();
  }
});

test('writeReport 写入指定文件', async () => {
  const { dir, restore } = await setupTempRepo();
  try {
    const id = newRunId();
    await writeReport(id, 'report.md', '# hi');
    const body = await readFile(join(dir, '.ocr-runs', id, 'report.md'), 'utf8');
    assert.equal(body, '# hi');
  } finally {
    restore();
  }
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:
```bash
npm test 2>&1 | tail -20
```

Expected: 失败，提示 `Cannot find module '../store.js'`。

- [ ] **Step 3: 实现 src/core/runs/store.ts**

Create:
```typescript
import { mkdir, writeFile, readFile, readdir, open } from 'node:fs/promises';
import { join } from 'node:path';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function rand4(): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return s;
}

function ts(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

export function newRunId(): string {
  return `${ts()}-${rand4()}`;
}

/** 返回 `<cwd>/.ocr-runs/<runId>/` 的绝对路径。若需要不同 root，由调用方在调用前 chdir 即可。 */
export function runDir(runId: string): string {
  return join(process.cwd(), '.ocr-runs', runId);
}

async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

async function appendJsonl(file: string, obj: unknown): Promise<void> {
  await ensureDir(join(file, '..'));
  // O_APPEND 原子追加 (spec §9 风险表 / §5.1 容错点)
  const fh = await open(file, 'a');
  try {
    await fh.appendFile(JSON.stringify(obj) + '\n', 'utf8');
  } finally {
    await fh.close();
  }
}

export async function writeContext(runId: string, ctx: unknown): Promise<void> {
  const dir = runDir(runId);
  await ensureDir(dir);
  await writeFile(join(dir, 'context.json'), JSON.stringify(ctx, null, 2), 'utf8');
}

export async function readContext<T = unknown>(runId: string): Promise<T> {
  const body = await readFile(join(runDir(runId), 'context.json'), 'utf8');
  return JSON.parse(body) as T;
}

export async function appendComment(runId: string, c: unknown): Promise<void> {
  await appendJsonl(join(runDir(runId), 'comments.jsonl'), c);
}

export async function readComments<T = unknown>(runId: string): Promise<T[]> {
  const file = join(runDir(runId), 'comments.jsonl');
  let body: string;
  try {
    body = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return body
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

export async function writePlan(runId: string, p: unknown): Promise<void> {
  const dir = runDir(runId);
  await ensureDir(dir);
  await writeFile(join(dir, 'plan.json'), JSON.stringify(p, null, 2), 'utf8');
}

export async function readPlan<T = unknown>(runId: string): Promise<T | null> {
  try {
    const body = await readFile(join(runDir(runId), 'plan.json'), 'utf8');
    return JSON.parse(body) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function appendEvent(runId: string, e: object): Promise<void> {
  await appendJsonl(join(runDir(runId), 'events.jsonl'), {
    ts: new Date().toISOString(),
    ...e,
  });
}

export async function markDone(
  runId: string,
  subagent: string,
  file: string,
): Promise<void> {
  const dir = join(runDir(runId), 'done');
  await ensureDir(dir);
  await writeFile(
    join(dir, `${subagent}.json`),
    JSON.stringify({ subagent, file, ts: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

export async function listDone(
  runId: string,
): Promise<Array<{ subagent: string; file: string }>> {
  const dir = join(runDir(runId), 'done');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Array<{ subagent: string; file: string }> = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const body = await readFile(join(dir, n), 'utf8');
    const j = JSON.parse(body) as { subagent: string; file: string };
    out.push({ subagent: j.subagent, file: j.file });
  }
  return out;
}

export async function writeReport(
  runId: string,
  name: 'report.md' | 'report.json',
  body: string,
): Promise<void> {
  const dir = runDir(runId);
  await ensureDir(dir);
  await writeFile(join(dir, name), body, 'utf8');
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run:
```bash
npm test 2>&1 | tail -20
```

Expected: 8 个测试全部通过。

- [ ] **Step 5: 提交**

```bash
git add src/core/runs/
git commit -m "feat: runs store - .ocr-runs/<runId>/ 路径与 jsonl 读写

- newRunId / runDir / context / plan / comments / events / done / report
- appendComment 使用 O_APPEND 原子追加
- 8 个单元测试覆盖

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: Allowlist - 扩展名白名单 + 默认排除 glob

**Files:**
- Create: `src/core/allowlist/supported_file_types.json`（从 OCR 复制）
- Create: `src/core/allowlist/default_exclude_patterns.json`（从 OCR 复制）
- Create: `src/core/allowlist/allowed_ext.ts`
- Create: `src/core/allowlist/__tests__/allowed_ext.test.ts`

**Interfaces:**
- Consumes: —
- Produces:
  - `isAllowed(path: string, extraExclude?: string[]): boolean`
  - `loadSupportedExtensions(): string[]`
  - `loadDefaultExcludes(): string[]`

- [ ] **Step 1: 复制 OCR 两份 JSON 资产**

Run:
```bash
mkdir -p /Users/lixiangyang/Desktop/代码/open-code-review-plugin/src/core/allowlist
cp /Users/lixiangyang/Desktop/代码/open-code-review/internal/config/allowlist/supported_file_types.json \
   /Users/lixiangyang/Desktop/代码/open-code-review-plugin/src/core/allowlist/supported_file_types.json
cp /Users/lixiangyang/Desktop/代码/open-code-review/internal/config/allowlist/default_exclude_patterns.json \
   /Users/lixiangyang/Desktop/代码/open-code-review-plugin/src/core/allowlist/default_exclude_patterns.json
```

Expected: 两个文件出现在目标目录。

- [ ] **Step 2: 写失败测试 src/core/allowlist/__tests__/allowed_ext.test.ts**

Create:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, loadSupportedExtensions, loadDefaultExcludes } from '../allowed_ext.js';

test('loadSupportedExtensions 至少含常见后缀', () => {
  const exts = loadSupportedExtensions();
  for (const e of ['.ts', '.tsx', '.js', '.java', '.go', '.py']) {
    assert.ok(exts.includes(e), `missing ${e}`);
  }
});

test('loadDefaultExcludes 至少含测试文件 glob', () => {
  const ex = loadDefaultExcludes();
  assert.ok(ex.some((p) => p.includes('_test.go')));
  assert.ok(ex.some((p) => p.includes('test')));
});

test('isAllowed: 已知支持的 .ts 文件返回 true', () => {
  assert.equal(isAllowed('src/foo.ts'), true);
});

test('isAllowed: 不支持的后缀返回 false', () => {
  assert.equal(isAllowed('foo.unknownext'), false);
});

test('isAllowed: 命中默认排除返回 false', () => {
  assert.equal(isAllowed('src/foo.test.ts'), false);
});

test('isAllowed: extraExclude 生效', () => {
  assert.equal(isAllowed('src/foo.ts', ['src/**']), false);
});

test('isAllowed: 目录形式排除', () => {
  assert.equal(isAllowed('dist/foo.js', ['dist/**']), false);
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run:
```bash
npm test 2>&1 | tail -10
```

Expected: 模块找不到，失败。

- [ ] **Step 4: 实现 src/core/allowlist/allowed_ext.ts**

Create:
```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _exts: string[] | null = null;
let _excludes: string[] | null = null;

export function loadSupportedExtensions(): string[] {
  if (_exts) return _exts;
  const p = join(__dirname, 'supported_file_types.json');
  _exts = JSON.parse(readFileSync(p, 'utf8')) as string[];
  return _exts;
}

export function loadDefaultExcludes(): string[] {
  if (_excludes) return _excludes;
  const p = join(__dirname, 'default_exclude_patterns.json');
  _excludes = JSON.parse(readFileSync(p, 'utf8')) as string[];
  return _excludes;
}

/**
 * 简化版 glob → RegExp，支持 ** / * / ? / { , }。
 * 仅用于 path-pattern 匹配，不是完整 minimatch。
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` 匹配任意层级 (含 0)；`**` 匹配 .*
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close === -1) {
        re += '\\{';
        i += 1;
      } else {
        const inner = glob.slice(i + 1, close);
        const opts = inner.split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&'));
        re += '(?:' + opts.join('|') + ')';
        i = close + 1;
      }
    } else if ('.+^$()|[]\\'.includes(c)) {
      re += '\\' + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

function matchAny(path: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (globToRegExp(p).test(path)) return true;
  }
  return false;
}

export function isAllowed(path: string, extraExclude: string[] = []): boolean {
  const ext = extname(path);
  const exts = loadSupportedExtensions();
  if (!exts.includes(ext)) return false;
  if (matchAny(path, loadDefaultExcludes())) return false;
  if (extraExclude.length > 0 && matchAny(path, extraExclude)) return false;
  return true;
}
```

注意：`tsconfig.json` 启用了 `resolveJsonModule`，但这里用 `readFileSync` 而非 `import … json` 是为了让 `build-mjs.mjs` 简单（json 不需要后缀改写）；运行期 `dist/core/allowlist/*.json` 仍然存在，因为构建脚本只处理 `.js` → `.mjs`。**额外需要**：构建前确保 json 文件被复制到 dist。

- [ ] **Step 5: 修改 tsconfig.json 让 json 资产被打包**

Actually `tsc` 不会复制非 `.ts` 文件。我们需要在 `package.json` 的 `build` 脚本里增加 json 复制。修改 `package.json`:

```json
{
  "scripts": {
    "build:assets": "node -e \"import('node:fs/promises').then(async fs=>{for(const f of ['src/core/allowlist/supported_file_types.json','src/core/allowlist/default_exclude_patterns.json']){await fs.mkdir('dist/'+f.replace(/^src\\//,'').split('/').slice(0,-1).join('/'),{recursive:true}).catch(()=>{});await fs.copyFile(f,'dist/'+f.replace(/^src\\//,''));}})\"",
    "build": "npm run clean && npm run build:tsc && npm run build:assets && npm run build:mjs"
  }
}
```

（保留其他 scripts 不变。Json 资产复制脚本之后会被 T6/T13 扩展，但 inline node 一行先用着。）

但这样写太脆。更简洁：新建 `scripts/copy-assets.mjs`。修改 `package.json` 的 `build:assets` 为 `node scripts/copy-assets.mjs`，并 Create `scripts/copy-assets.mjs`:

```javascript
#!/usr/bin/env node
import { mkdir, copyFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

for await (const file of walk(srcDir)) {
  if (!file.endsWith('.json') && !file.endsWith('.md')) continue;
  const rel = relative(srcDir, file);
  const target = join(distDir, rel);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(file, target);
  console.log(`[copy-assets] ${rel}`);
}
```

修改 `package.json` 的 `scripts` 字段：

```json
{
  "scripts": {
    "clean": "rm -rf dist",
    "build:tsc": "tsc -p tsconfig.json",
    "build:assets": "node scripts/copy-assets.mjs",
    "build:mjs": "node scripts/build-mjs.mjs",
    "build": "npm run clean && npm run build:tsc && npm run build:assets && npm run build:mjs",
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test src/**/__tests__/*.test.ts",
    "preview": "ls -la dist/"
  }
}
```

- [ ] **Step 6: 运行测试，确认通过**

Run:
```bash
npm test 2>&1 | tail -10
```

Expected: 7 个 allowlist 测试 + T3 的 8 个测试，全部通过。

- [ ] **Step 7: 构建一次验证 dist 中含 json**

Run:
```bash
npm run build && ls dist/core/allowlist/
```

Expected: `dist/core/allowlist/` 含 `allowed_ext.mjs` + `supported_file_types.json` + `default_exclude_patterns.json`。

- [ ] **Step 8: 提交**

```bash
git add src/core/allowlist/ scripts/copy-assets.mjs package.json
git commit -m "feat: allowlist - 扩展名白名单与默认排除 glob

- 直接复用 OCR supported_file_types.json + default_exclude_patterns.json
- isAllowed(path, extraExclude?) 三段筛选：扩展名 → 默认排除 → 额外排除
- 自研 globToRegExp 支持 ** / * / ? / { , }
- 新增 scripts/copy-assets.mjs 把 .json/.md 资产同步到 dist
- 7 个单元测试

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Diff 解析 - git 子进程 + unified diff 状态机 + workspace 模式

**Files:**
- Create: `src/core/diff/git.ts`
- Create: `src/core/diff/parser.ts`
- Create: `src/core/diff/hunk.ts`
- Create: `src/core/diff/workspace.ts`
- Create: `src/core/diff/__tests__/parser.test.ts`

**Interfaces:**
- Consumes: T2 `FileChange`、`Hunk`、`DiffLine`
- Produces:
  - `gitRevParseToplevel(): Promise<string>`
  - `gitDiff(opts: {repoRoot, range, paths?}): Promise<string>` — 拉 unified diff（带 `--no-color -U3`）
  - `parseUnifiedDiff(diffText: string, opts?: {maxHunkLines?: number}): FileChange[]`
  - `hashHunk(filePath, oldStart, oldLines, newStart, newLines): string` — 稳定 hash 作为 `Hunk.id`
  - `collectWorkspaceDiff(repoRoot: string): Promise<string>` — 拼接 staged + unstaged + untracked

- [ ] **Step 1: 写失败测试 src/core/diff/__tests__/parser.test.ts**

Create:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../parser.js';

const SAMPLE = `diff --git a/src/foo.ts b/src/foo.ts
index e69de29..b48beac 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -0,0 +1,3 @@
+export function hello() {
+  return 'world';
+}
diff --git a/src/bar.ts b/src/bar.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/bar.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const X = 1;
-export const Y = 2;
diff --git a/img.png b/img.png
new file mode 100644
index 0000000..abc
Binary files /dev/null and b/img.png differ
diff --git a/src/old.ts b/src/new.ts
similarity index 60%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,3 +1,3 @@
 line1
-line2
+line2-changed
 line3
`;

test('parseUnifiedDiff 识别 4 类状态', () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.equal(files.length, 4);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));

  assert.equal(byPath['src/foo.ts'].status, 'added');
  assert.equal(byPath['src/bar.ts'].status, 'deleted');
  assert.equal(byPath['img.png'].status, 'binary');
  assert.equal(byPath['src/new.ts'].status, 'renamed');
  assert.equal(byPath['src/new.ts'].oldPath, 'src/old.ts');
});

test('parseUnifiedDiff added 文件 hunk 行号正确', () => {
  const files = parseUnifiedDiff(SAMPLE);
  const foo = files.find((f) => f.path === 'src/foo.ts')!;
  assert.equal(foo.hunks.length, 1);
  const h = foo.hunks[0];
  assert.equal(h.newStart, 1);
  assert.equal(h.newLines, 3);
  assert.equal(h.lines.length, 3);
  for (const ln of h.lines) assert.equal(ln.kind, '+');
});

test('parseUnifiedDiff renamed 文件 hunk 含 +/-/ 三类', () => {
  const files = parseUnifiedDiff(SAMPLE);
  const r = files.find((f) => f.path === 'src/new.ts')!;
  const kinds = r.hunks[0].lines.map((l) => l.kind).sort();
  assert.deepEqual(kinds, [' ', ' ', '+', '-']);
});

test('parseUnifiedDiff 行号映射正确', () => {
  const files = parseUnifiedDiff(SAMPLE);
  const r = files.find((f) => f.path === 'src/new.ts')!;
  const lines = r.hunks[0].lines;
  // line1 是 context，oldLineNo=1, newLineNo=1
  assert.equal(lines[0].text, 'line1');
  assert.equal(lines[0].oldLineNo, 1);
  assert.equal(lines[0].newLineNo, 1);
  // line2 删除
  const del = lines.find((l) => l.kind === '-')!;
  assert.equal(del.oldLineNo, 2);
  // line2-changed 新增
  const add = lines.find((l) => l.kind === '+')!;
  assert.equal(add.newLineNo, 2);
});

test('parseUnifiedDiff Hunk.id 稳定 + 唯一', () => {
  const a = parseUnifiedDiff(SAMPLE);
  const b = parseUnifiedDiff(SAMPLE);
  const ids = a.flatMap((f) => f.hunks.map((h) => h.id));
  assert.equal(new Set(ids).size, ids.length, 'ids unique');
  const idsB = b.flatMap((f) => f.hunks.map((h) => h.id));
  assert.deepEqual(ids, idsB, 'ids stable');
});

test('parseUnifiedDiff maxHunkLines 截断标记', () => {
  const big = 'diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1,100 +1,100 @@\n' +
    Array.from({ length: 100 }, (_, i) => `+line${i}`).join('\n') + '\n';
  const files = parseUnifiedDiff(big, { maxHunkLines: 10 });
  assert.equal(files[0].truncated, true);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:
```bash
npm test 2>&1 | tail -10
```

Expected: 模块找不到。

- [ ] **Step 3: 实现 src/core/diff/hunk.ts**

Create:
```typescript
import { createHash } from 'node:crypto';

export function hashHunk(
  filePath: string,
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
): string {
  return createHash('sha1')
    .update(`${filePath}:${oldStart}-${oldLines}:${newStart}-${newLines}`)
    .digest('hex')
    .slice(0, 12);
}
```

- [ ] **Step 4: 实现 src/core/diff/parser.ts**

参考 OCR `internal/diff/parser.go` 的状态机思路，TS 重写。Create:
```typescript
import type { FileChange, Hunk, DiffLine, FileStatus } from '../model/request.js';
import { hashHunk } from './hunk.js';

const DIFF_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const BINARY = /^Binary files /;

interface InFlight {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  diff: string[];
  hunks: Hunk[];
  current?: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    oldCursor: number;
    newCursor: number;
    lines: DiffLine[];
  };
}

function freshFile(oldPath: string, newPath: string): InFlight {
  return {
    oldPath,
    newPath,
    status: 'modified',
    diff: [],
    hunks: [],
  };
}

function finalize(f: InFlight, opts: { maxHunkLines: number }): FileChange {
  // 截断检测：任一 hunk lines.length > maxHunkLines 视为 truncated
  let truncated = false;
  for (const h of f.hunks) {
    if (h.lines.length > opts.maxHunkLines) {
      truncated = true;
      h.lines.length = opts.maxHunkLines;
    }
  }
  const path = f.status === 'deleted' ? f.oldPath : f.newPath;
  const out: FileChange = {
    path,
    status: f.status,
    diff: f.diff.join('\n'),
    truncated,
    hunks: f.hunks,
    rulesHit: [],
  };
  if (f.status === 'renamed') out.oldPath = f.oldPath;
  return out;
}

export function parseUnifiedDiff(
  diffText: string,
  opts: { maxHunkLines?: number } = {},
): FileChange[] {
  const maxHunkLines = opts.maxHunkLines ?? 10000;
  const lines = diffText.split('\n');
  const results: FileChange[] = [];
  let cur: InFlight | null = null;

  const flushHunk = () => {
    if (!cur || !cur.current) return;
    const { oldStart, oldLines, newStart, newLines, lines: lns } = cur.current;
    cur.hunks.push({
      id: hashHunk(cur.newPath || cur.oldPath, oldStart, oldLines, newStart, newLines),
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: lns,
    });
    cur.current = undefined;
  };

  const flushFile = () => {
    flushHunk();
    if (cur) {
      results.push(finalize(cur, { maxHunkLines }));
      cur = null;
    }
  };

  for (const line of lines) {
    const m = DIFF_HEADER.exec(line);
    if (m) {
      flushFile();
      cur = freshFile(m[1], m[2]);
      cur.diff.push(line);
      continue;
    }
    if (!cur) continue;
    cur.diff.push(line);

    if (BINARY.test(line)) {
      cur.status = 'binary';
      continue;
    }
    if (line.startsWith('new file mode ')) {
      cur.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      cur.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      cur.oldPath = line.slice('rename from '.length);
      cur.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      cur.newPath = line.slice('rename to '.length);
      cur.status = 'renamed';
      continue;
    }
    if (line === '--- /dev/null') {
      cur.status = 'added';
      continue;
    }
    if (line === '+++ /dev/null') {
      cur.status = 'deleted';
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++')) continue;

    const h = HUNK_HEADER.exec(line);
    if (h) {
      flushHunk();
      cur.current = {
        oldStart: Number(h[1]),
        oldLines: h[2] ? Number(h[2]) : 1,
        newStart: Number(h[3]),
        newLines: h[4] ? Number(h[4]) : 1,
        oldCursor: Number(h[1]),
        newCursor: Number(h[3]),
        lines: [],
      };
      continue;
    }

    if (cur.current) {
      const c = cur.current;
      if (line.startsWith('+')) {
        c.lines.push({ kind: '+', oldLineNo: 0, newLineNo: c.newCursor++, text: line.slice(1) });
      } else if (line.startsWith('-')) {
        c.lines.push({ kind: '-', oldLineNo: c.oldCursor++, newLineNo: 0, text: line.slice(1) });
      } else if (line.startsWith(' ')) {
        c.lines.push({
          kind: ' ',
          oldLineNo: c.oldCursor++,
          newLineNo: c.newCursor++,
          text: line.slice(1),
        });
      }
      // 其他 (例如 `\ No newline at end of file`) 忽略
    }
  }

  flushFile();
  return results;
}
```

- [ ] **Step 5: 实现 src/core/diff/git.ts**

Create:
```typescript
import { spawn } from 'node:child_process';

export interface GitRunOpts {
  cwd: string;
  timeoutMs?: number;
}

export async function runGit(args: string[], opts: GitRunOpts): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`git ${args.join(' ')} exit ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function gitRevParseToplevel(cwd: string): Promise<string> {
  const out = await runGit(['rev-parse', '--show-toplevel'], { cwd });
  return out.trim();
}

export interface DiffOpts {
  repoRoot: string;
  /** 'workspace' | 'staged' | 'commit:<sha>' | '<from>..<to>' */
  range: string;
  paths?: string[];
}

export async function gitDiff(opts: DiffOpts): Promise<string> {
  const args: string[] = ['diff', '--no-color', '-U3', '--no-ext-diff'];
  if (opts.range === 'workspace') {
    // tracked changes vs HEAD; untracked 单独处理
    args.push('HEAD');
  } else if (opts.range === 'staged') {
    args.push('--cached');
  } else if (opts.range.startsWith('commit:')) {
    const sha = opts.range.slice('commit:'.length);
    args.splice(0, 1, 'diff-tree', '-p', '-r', '--no-color', '-U3');
    // diff-tree 不支持 --no-ext-diff，调整 args 为 ['diff-tree', '-p', '-r', '--no-color', '-U3', sha]
    args.length = 0;
    args.push('diff-tree', '-p', '-r', '--no-color', '-U3', sha);
  } else if (opts.range.includes('..')) {
    args.push(opts.range);
  } else {
    args.push(opts.range);
  }
  if (opts.paths && opts.paths.length > 0) {
    args.push('--', ...opts.paths);
  }
  return runGit(args, { cwd: opts.repoRoot });
}
```

- [ ] **Step 6: 实现 src/core/diff/workspace.ts**

Create:
```typescript
import { runGit, gitDiff } from './git.js';

/**
 * 等价于 OCR `workspace` 模式：tracked 改动 + untracked 文件（作为"新增"）拼成一份 unified diff。
 * untracked 文件通过 `git diff --no-index /dev/null <file>` 生成 diff。
 */
export async function collectWorkspaceDiff(repoRoot: string): Promise<string> {
  const tracked = await gitDiff({ repoRoot, range: 'workspace' });

  // 列 untracked 文件
  const lsOut = await runGit(['ls-files', '--others', '--exclude-standard'], { cwd: repoRoot });
  const untracked = lsOut.split('\n').map((s) => s.trim()).filter(Boolean);

  let extra = '';
  for (const f of untracked) {
    try {
      const d = await runGit(
        ['diff', '--no-color', '-U3', '--no-index', '--', '/dev/null', f],
        { cwd: repoRoot },
      );
      extra += d;
    } catch {
      // `git diff --no-index` 在有差异时退出码非 0，但 stdout 仍是有效 diff。
      // 我们的 runGit 把非 0 当作 error。这里改用 spawn 直读：
      // 为保持简单，跳过 untracked 中无法拉取 diff 的文件。
    }
  }
  return tracked + extra;
}
```

注意：`git diff --no-index` 在有差异时退出码 = 1，与"正常出错"歧义。**修复方案**：给 `runGit` 增加 `allowExitCodes?: number[]` 选项。回到 `src/core/diff/git.ts` 添加：

```typescript
export interface GitRunOpts {
  cwd: string;
  timeoutMs?: number;
  allowExitCodes?: number[];
}
```

并把 close handler 改为：

```typescript
child.on('close', (code) => {
  clearTimeout(timer);
  const allow = opts.allowExitCodes ?? [0];
  if (!allow.includes(code ?? -1)) {
    reject(new Error(`git ${args.join(' ')} exit ${code}: ${stderr.trim()}`));
    return;
  }
  resolve(stdout);
});
```

回到 `workspace.ts`，把 untracked 的 diff 调用改为：

```typescript
import { spawn } from 'node:child_process';

async function rawGitDiffNoIndex(repoRoot: string, file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['diff', '--no-color', '-U3', '--no-index', '--', '/dev/null', file], {
      cwd: repoRoot,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      // 0 = 无差异, 1 = 有差异（正常），其他视为错误
      if (code === 0 || code === 1) resolve(stdout);
      else reject(new Error(`git diff --no-index exit ${code}: ${stderr.trim()}`));
    });
  });
}
```

并在 `collectWorkspaceDiff` 中使用 `rawGitDiffNoIndex`：

```typescript
for (const f of untracked) {
  extra += await rawGitDiffNoIndex(repoRoot, f);
}
```

- [ ] **Step 7: 运行测试，确认通过**

Run:
```bash
npm test 2>&1 | tail -10
```

Expected: parser 6 个测试通过；T3/T4 测试也仍通过。

- [ ] **Step 8: 提交**

```bash
git add src/core/diff/
git commit -m "feat: diff - git 子进程 + unified diff 解析 + workspace 模式

- runGit / gitDiff / gitRevParseToplevel
- parseUnifiedDiff 状态机移植自 OCR internal/diff/parser.go
  支持 added/modified/deleted/renamed/binary 5 种状态
  正确维护 +/-/ 三类行的 oldLineNo / newLineNo 游标
- hashHunk 用 SHA1 12 字符前缀作稳定 id
- collectWorkspaceDiff: tracked + untracked (via --no-index)
- 6 个 parser 单元测试

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Rules - system_rules + rule_docs 复制 + path matcher

**Files:**
- Create: `src/core/rules/system_rules.json`（从 OCR 复制）
- Create: `assets/rule_docs/*.md`（OCR 16 个文件直接复制）
- Create: `src/core/rules/matcher.ts`
- Create: `src/core/rules/system_rules.ts`
- Create: `src/core/rules/__tests__/matcher.test.ts`

**Interfaces:**
- Consumes: T2 `RuleHit`、T4 `globToRegExp`
- Produces:
  - `loadSystemRules(): { default_rule: string; path_rule_map: Record<string, string> }`
  - `matchRule(filePath: string): { ruleId: string; docPath: string } | null` — 按 OCR 的 path_rule_map 顺序匹配，未命中返回 `default.md`
  - `loadRuleDocText(docFileName: string): string` — 读 `assets/rule_docs/<name>`，缓存
  - `buildSystemRulePrompt(filePath: string): { ruleId: string; docPath: string; text: string }` — 一站式给 prompt 用

- [ ] **Step 1: 复制 OCR 资产**

Run:
```bash
mkdir -p /Users/lixiangyang/Desktop/代码/open-code-review-plugin/src/core/rules
mkdir -p /Users/lixiangyang/Desktop/代码/open-code-review-plugin/assets/rule_docs
cp /Users/lixiangyang/Desktop/代码/open-code-review/internal/config/rules/system_rules.json \
   /Users/lixiangyang/Desktop/代码/open-code-review-plugin/src/core/rules/system_rules.json
cp /Users/lixiangyang/Desktop/代码/open-code-review/internal/config/rules/rule_docs/*.md \
   /Users/lixiangyang/Desktop/代码/open-code-review-plugin/assets/rule_docs/
ls /Users/lixiangyang/Desktop/代码/open-code-review-plugin/assets/rule_docs/ | wc -l
```

Expected: 输出 16（OCR 当前 rule_docs 数量；以 `ls` 实际结果为准，不强校验数字，但应 ≥ 10）。

- [ ] **Step 2: 写失败测试 src/core/rules/__tests__/matcher.test.ts**

Create:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRule, buildSystemRulePrompt, loadSystemRules } from '../matcher.js';

test('loadSystemRules 至少有 default + 若干 path rule', () => {
  const r = loadSystemRules();
  assert.equal(r.default_rule, 'default.md');
  assert.ok(Object.keys(r.path_rule_map).length > 0);
});

test('matchRule: .ts 文件命中 ts_js_tsx_jsx.md', () => {
  const m = matchRule('src/foo.ts');
  assert.ok(m);
  assert.equal(m!.docPath, 'ts_js_tsx_jsx.md');
});

test('matchRule: pom.xml 命中 pom_xml.md', () => {
  const m = matchRule('module/pom.xml');
  assert.equal(m!.docPath, 'pom_xml.md');
});

test('matchRule: 未知后缀命中 default.md', () => {
  const m = matchRule('foo.unknown');
  assert.equal(m!.docPath, 'default.md');
});

test('buildSystemRulePrompt 返回 ruleId + docPath + text', () => {
  const p = buildSystemRulePrompt('src/foo.ts');
  assert.equal(p.docPath, 'ts_js_tsx_jsx.md');
  assert.ok(p.text.length > 50, 'rule doc 应有内容');
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run:
```bash
npm test 2>&1 | tail -10
```

Expected: 模块找不到。

- [ ] **Step 4: 实现 src/core/rules/matcher.ts**

Create:
```typescript
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { globToRegExp } from '../allowlist/allowed_ext.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SystemRulesFile {
  default_rule: string;
  path_rule_map: Record<string, string>;
}

let _rules: SystemRulesFile | null = null;

export function loadSystemRules(): SystemRulesFile {
  if (_rules) return _rules;
  const p = join(__dirname, 'system_rules.json');
  _rules = JSON.parse(readFileSync(p, 'utf8')) as SystemRulesFile;
  return _rules;
}

/**
 * 按 path_rule_map 中的**插入顺序**逐条匹配，命中即返回；
 * 未命中返回 default_rule。docPath 是 rule_docs/ 下的文件名 (含 .md)。
 */
export function matchRule(filePath: string): { ruleId: string; docPath: string } {
  const r = loadSystemRules();
  for (const [pattern, doc] of Object.entries(r.path_rule_map)) {
    if (globToRegExp(pattern).test(filePath)) {
      return { ruleId: doc.replace(/\.md$/, ''), docPath: doc };
    }
  }
  return { ruleId: r.default_rule.replace(/\.md$/, ''), docPath: r.default_rule };
}

const docCache = new Map<string, string>();

export function loadRuleDocText(docFileName: string): string {
  const cached = docCache.get(docFileName);
  if (cached !== undefined) return cached;
  // assets/rule_docs/ 在仓库根，从 __dirname (= dist/core/rules/ 运行时 / src/core/rules/ 测试时) 回到根
  const candidates = [
    join(__dirname, '..', '..', '..', 'assets', 'rule_docs', docFileName), // dist 运行时
    join(__dirname, '..', '..', '..', '..', 'assets', 'rule_docs', docFileName), // 兜底
    join(process.cwd(), 'assets', 'rule_docs', docFileName), // CLI 入口运行时兜底
  ];
  let text = '';
  for (const p of candidates) {
    try {
      text = readFileSync(p, 'utf8');
      break;
    } catch {
      /* try next */
    }
  }
  if (!text) {
    throw new Error(`rule doc not found: ${docFileName}`);
  }
  docCache.set(docFileName, text);
  return text;
}

export function buildSystemRulePrompt(filePath: string): {
  ruleId: string;
  docPath: string;
  text: string;
} {
  const m = matchRule(filePath);
  return { ...m, text: loadRuleDocText(m.docPath) };
}
```

注意：`assets/rule_docs/` 在仓库根而非 src/ 下，所以 `tsc` 不会处理它，也不会被 `scripts/copy-assets.mjs`（只扫 src/）复制到 dist。这是故意的——它和 `commands/`/`skills/` 一样属于"插件资产"，直接被插件加载，不进 dist。运行时通过 `process.cwd()` 或相对 dist 的路径寻址。

- [ ] **Step 5: 实现 src/core/rules/system_rules.ts (简单 re-export，便于将来切换数据源)**

Create:
```typescript
export { loadSystemRules, matchRule, loadRuleDocText, buildSystemRulePrompt } from './matcher.js';
```

- [ ] **Step 6: 运行测试，确认通过**

Run:
```bash
npm test 2>&1 | tail -10
```

Expected: 5 个 matcher 测试通过；前面任务的测试也仍通过。

- [ ] **Step 7: 提交**

```bash
git add src/core/rules/ assets/
git commit -m "feat: rules - system_rules.json + rule_docs 复制 + path matcher

- 从 OCR internal/config/rules/ 直接复制 system_rules.json 与 16 个 rule_docs/*.md
- matchRule 按 path_rule_map 插入顺序匹配，未命中走 default
- loadRuleDocText 三段路径查找 (dist/src/cwd)
- buildSystemRulePrompt 一站式输出 ruleId + docPath + text
- 5 个单元测试

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Prompts - constants + render + main_task + plan_task + plan_guidance 文本化

**Files:**
- Create: `src/core/prompts/constants.ts`
- Create: `src/core/prompts/render.ts`
- Create: `src/core/prompts/main_task.ts`
- Create: `src/core/prompts/plan_task.ts`
- Create: `src/core/prompts/plan_guidance.ts`
- Create: `src/core/prompts/__tests__/render.test.ts`
- Create: `src/core/prompts/__tests__/plan_guidance.test.ts`

**Interfaces:**
- Consumes: T2 `PlanOutput`、`PlanIssue`
- Produces:
  - 常量：`PLAN_MODE_LINE_THRESHOLD = 50`、`MAX_TOKENS = 58888`、`MAX_HUNK_LINES = 800`、`PLUGIN_VERSION = '0.1.0'`
  - `renderTemplate(tpl: string, vars: Record<string, string>): string` — 替换所有 `{{key}}` 与 `{key}` 占位符（OCR 两种语法都有）
  - `MAIN_TASK_SYSTEM` / `MAIN_TASK_USER`、`PLAN_TASK_SYSTEM` / `PLAN_TASK_USER` 字符串常量（逐字移植 OCR task_template.json，仅替换 6 行工具说明）
  - `planOutputToGuidance(plan: PlanOutput, currentFilePath: string): string` — 把 PlanOutput.issues[] 过滤+排序+格式化为 Markdown 列表

- [ ] **Step 1: 写失败测试 src/core/prompts/__tests__/render.test.ts**

Create:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate } from '../render.js';

test('renderTemplate 替换 {{key}}', () => {
  const out = renderTemplate('hello {{name}}!', { name: 'world' });
  assert.equal(out, 'hello world!');
});

test('renderTemplate 替换 {key}', () => {
  const out = renderTemplate('hi {n}', { n: 'a' });
  assert.equal(out, 'hi a');
});

test('renderTemplate 未提供的 key 替换为空串', () => {
  const out = renderTemplate('a={{a}} b={{b}}', { a: '1' });
  assert.equal(out, 'a=1 b=');
});

test('renderTemplate 同名多次替换', () => {
  const out = renderTemplate('{{x}} {{x}} {{x}}', { x: '7' });
  assert.equal(out, '7 7 7');
});

test('renderTemplate 不替换字面 { } 单字符', () => {
  const out = renderTemplate('keep { } as is', {});
  assert.equal(out, 'keep { } as is');
});
```

- [ ] **Step 2: 写失败测试 src/core/prompts/__tests__/plan_guidance.test.ts**

Create:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOutputToGuidance } from '../plan_guidance.js';
import type { PlanOutput } from '../../model/plan.js';

const SAMPLE: PlanOutput = {
  change_summary: 'overall',
  issues: [
    { severity: 'low', description: 'low issue in src/other.ts', tool_guidance: [] },
    { severity: 'high', description: 'high issue in src/foo.ts:42', tool_guidance: [] },
    { severity: 'medium', description: 'global concurrency concern', tool_guidance: [], file_hint: 'src/foo.ts' },
  ],
};

test('planOutputToGuidance 过滤含路径或 file_hint 的条目', () => {
  const g = planOutputToGuidance(SAMPLE, 'src/foo.ts');
  assert.ok(g.includes('high issue'));
  assert.ok(g.includes('global concurrency'));
  assert.ok(!g.includes('low issue in src/other.ts'));
});

test('planOutputToGuidance 按 severity 降序', () => {
  const g = planOutputToGuidance(SAMPLE, 'src/foo.ts');
  assert.ok(g.indexOf('high') < g.indexOf('medium'));
});

test('planOutputToGuidance 无相关条目返回空串', () => {
  const g = planOutputToGuidance({ change_summary: '', issues: [] }, 'src/foo.ts');
  assert.equal(g, '');
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run:
```bash
npm test 2>&1 | tail -10
```

Expected: 模块找不到。

- [ ] **Step 4: 实现 src/core/prompts/constants.ts**

Create:
```typescript
/** 同步自 OCR internal/config/template/task_template.json。 */
export const PLAN_MODE_LINE_THRESHOLD = 50;
export const MAX_TOKENS = 58888;
export const MAX_HUNK_LINES = 800;
export const PLUGIN_VERSION = '0.1.0' as const;
export const PLUGIN_NAME = 'open-code-review' as const;
```

- [ ] **Step 5: 实现 src/core/prompts/render.ts**

Create:
```typescript
export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  // 先替换 {{key}}（贪婪匹配），再替换 {key}（仅 word chars，避免吞 { }）
  let out = tpl.replace(/\{\{(\w+)\}\}/g, (_m, k) => (vars[k] ?? ''));
  out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  // 未提供的 {{x}} 已替换为空，未提供的 {x} 原样保留
  // 但测试要求未提供的 {{x}} 替换为空 - 已实现
  // 测试 "keep { } as is" - 单字符 { } 不被替换 - 已实现
  return out;
}
```

- [ ] **Step 6: 实现 src/core/prompts/main_task.ts**

完整文本来自 OCR `internal/config/template/task_template.json::MAIN_TASK`。逐字保留 system+user prompt，仅在 system 末尾的 "Reply limit" 段替换工具说明。Create:
```typescript
/**
 * MAIN_TASK system + user prompt - 逐字移植自 OCR task_template.json，
 * 仅替换 system prompt 末尾"Reply limit"段的工具说明，使其指向插件 bin/ CLI。
 */

export const MAIN_TASK_SYSTEM = `## Role
You are a code review assistant developed by Alibaba. You are skilled at code review in the software development process and are responsible for providing professional review feedback for code changes that are about to be submitted. Your feedback perfectly combines detailed analysis with contextual explanations.
You are working in an IDE with editor concepts for open files and an integrated terminal. The user's developed code is stored in the IDE's staging area.
Before users commit staged code to remote repositories, they will send you tasks to help them complete the process successfully. Each time a user sends a task, it will be placed in <user_task>, and you will use <tool> to interact with the real world when executing tasks.
Please keep your responses concise and objective.

## Capabilities
- Think step by step progressively.
- First understand the code changes to be reviewed. Code changes are provided in Unified Diff format, where lines starting with \`-\` indicate deleted code, lines starting with \`+\` indicate added code, consecutive \`-\` and \`+\` lines represent modified code, and other lines represent unchanged code.
- Be objective and neutral, make judgments based on facts and logic, avoid subjective assumptions. When the context is unclear, use tools to obtain contextual information rather than judging based on assumptions.
- For the current code changes, provide feedback opinions, pointing out areas for improvement or potential issues. Focus on issues in newly added code.
- Avoid commenting on correct code or unchanged code.
- Avoid commenting on deleted code; deleted code serves only as reference context.
- Focus on clarity, practicality, and comprehensiveness.
- Use developer-friendly terminology and analogies in explanations.
- Focus primarily on the actual code logic and functionality. Avoid commenting on or providing feedback about non-functional elements such as code comments, tool-generated indicators (like @Generated annotations), or other metadata, unless the user explicitly requests you to review these elements.

## Strict Focus Rules
- Context tools are for understanding purposes only. Findings from other files must NOT become the subject of your comments.
- If you discover a potential issue in another file while gathering context, ignore it — your task is limited to the current diffs.

## Tool Mapping (host: Claude Code)
- To read a file: use the **Read** tool.
- To find files by pattern: use the **Glob** tool.
- To search code text: use the **Grep** tool.
- To read another changed file's diff: run \`Bash\` with \`file_read_diff --runId <runId> --path <path>\`.
- To submit a confirmed review comment: run \`Bash\` with \`code_comment --runId <runId> --path <p> --start <n> --end <m> --content <text> [--suggestion-code <code>] [--existing-code <code>] [--thinking <text>]\`.
- When your review is complete, run \`Bash\` with \`task_done --runId <runId> --subagent <id> --file <path>\` to signal completion.

## Reply limit
- If the current code review task is complete, run the \`task_done\` Bash command to end the task.
- If a code issue has been identified and confirmed, run the \`code_comment\` Bash command to provide feedback.
- If additional context is needed to confirm the issue, use Read / Glob / Grep / file_read_diff.`;

export const MAIN_TASK_USER = `// The following is the list of other files changed in this update.
<other_changed_files>
{{change_files}}
</other_changed_files>

<current_file_path>{{current_file_path}}</current_file_path>

<current_file_diff>
{{diff}}
</current_file_diff>

Current time in the real world: {{current_system_date_time}}

<user_task>
### Requirement Background (Optional)
{{requirement_background}}

### Review Checklist
{{system_rule}}

### Review Plan (Optional)
{{plan_guidance}}

### Run Identifier
runId = {{runId}}; subagent = {{subagent}}

Now please review the code changes in <current_file_diff>
</user_task>`;
```

- [ ] **Step 7: 实现 src/core/prompts/plan_task.ts**

Create:
```typescript
/**
 * PLAN_TASK system + user prompt - 逐字移植自 OCR task_template.json，
 * 仅替换工具说明段。
 */

export const PLAN_TASK_SYSTEM = `You are an expert in code review task planning. You have access to a set of tools for retrieving relevant context about code changes, and your responsibility is to analyze those changes and produce a structured review plan.

## Core Responsibilities
Analyze code change content, identify potential risk points, and plan appropriate tool-calling strategies for each risk point.

## Tool Descriptions
{{plan_tools}}

## Output Format
Strictly follow the JSON format below. Do not include any additional explanatory text:

{
  "change_summary": "A brief description of the purpose and scope of this code change",
  "issues": [
    {
      "severity": "high|medium|low",
      "description": "A clear description of the specific problem and its potential impact for this risk point",
      "tool_guidance": [
        {
          "name": "Tool name",
          "reason": "Explain the purpose of calling this tool and its relevance to the current issue",
          "arguments": "Invocation arguments"
        }
      ]
    }
  ]
}

## Analysis Rules
1. **Scope**: Only analyze newly added and modified code; ignore deleted code
2. **Ordering**: The issues list must be sorted by severity in descending order (high → medium → low)
3. **Severity Definitions**:
   - \`high\`: May cause security vulnerabilities, data loss, system crashes, or critical functional failures
   - \`medium\`: May affect performance, maintainability, or involve potential edge-case problems
   - \`low\`: Code style, readability, or non-critical best practice suggestions
4. **Tool Usage**: Tools are for reference purposes only and must not be actually invoked; describe the calling intent within tool_guidance
5. **Description Requirements**: Each description must cover three dimensions — problem location, nature of the problem, and potential impact`;

export const PLAN_TASK_USER = `// The following is the list of other files changed in this update.
<other_changed_files>
{{change_files}}
</other_changed_files>

<current_file_path>{{current_file_path}}</current_file_path>

<current_file_diff>
{{diff}}
</current_file_diff>

Current time in the real world: {{current_system_date_time}}

### Requirement Background (Optional)
{{requirement_background}}

### Review Checklist
{{system_rule}}

### Task
Please analyze the code changes above and output a structured review plan. Start with \`\`\`json`;

export const PLAN_TOOLS_DESCRIPTION = `- Read: read a file's content by absolute or repo-relative path.
- Glob: find files by glob pattern (e.g. "src/**/*.ts").
- Grep: search code by regex/text across the repository.
- file_read_diff: read the unified diff of another changed file in the current review.`;
```

- [ ] **Step 8: 实现 src/core/prompts/plan_guidance.ts**

Create:
```typescript
import type { PlanOutput, PlanIssue } from '../model/plan.js';

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function isRelevant(issue: PlanIssue, currentFilePath: string): boolean {
  if (issue.file_hint && issue.file_hint === currentFilePath) return true;
  if (issue.description.includes(currentFilePath)) return true;
  // tool_guidance 中 arguments / reason 含 path
  for (const tg of issue.tool_guidance ?? []) {
    if ((tg.arguments || '').includes(currentFilePath)) return true;
    if ((tg.reason || '').includes(currentFilePath)) return true;
  }
  return false;
}

/**
 * 把 PlanOutput 文本化为 MAIN_TASK 模板的 {{plan_guidance}} 占位字符串。
 * 规则：
 *   - 仅保留 file_hint == currentFilePath、或 description/tool_guidance 提及该 path 的 issue
 *   - 按 severity 降序 (high > medium > low)
 *   - 渲染为 Markdown 列表
 *   - 无相关条目 → 返回空串
 */
export function planOutputToGuidance(plan: PlanOutput, currentFilePath: string): string {
  const filtered = (plan.issues ?? []).filter((i) => isRelevant(i, currentFilePath));
  if (filtered.length === 0) return '';
  filtered.sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99),
  );
  const lines: string[] = [];
  if (plan.change_summary) lines.push(`**Summary**: ${plan.change_summary}`, '');
  for (const i of filtered) {
    lines.push(`- [${i.severity.toUpperCase()}] ${i.description}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 9: 运行测试，确认通过**

Run:
```bash
npm test 2>&1 | tail -10
```

Expected: render 5 个 + plan_guidance 3 个测试通过。

- [ ] **Step 10: 提交**

```bash
git add src/core/prompts/
git commit -m "feat: prompts - constants + render + main_task + plan_task + plan_guidance

- 常量同步 OCR task_template.json (PLAN_MODE_LINE_THRESHOLD=50, MAX_TOKENS=58888)
- renderTemplate 支持 {{key}} 与 {key} 两种占位语法
- MAIN_TASK / PLAN_TASK system+user 逐字移植 OCR，仅改 6 行工具说明
- planOutputToGuidance 把 PlanOutput 过滤+排序+文本化为 plan_guidance 字符串
- 8 个单元测试

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 8: ReviewContext 构造 + bin/ocr-prepare CLI

**Files:**
- Create: `src/core/context/review_context.ts`
- Create: `src/cli/prepare.ts`

**Interfaces:**
- Consumes: T2-T7 全部
- Produces:
  - `buildReviewContext(req: ReviewRequest): Promise<ReviewContext>` — 编排 git diff → 解析 → allowlist 过滤 → 规则匹配
  - CLI 入口 `prepare`：解析 argv（OCR 风格 flag）→ 调 buildReviewContext → 写 context.json → stdout JSON `{runId, fileCount}`

- [ ] **Step 1: 写 src/core/context/review_context.ts**

Create:
```typescript
import { gitRevParseToplevel, gitDiff } from '../diff/git.js';
import { collectWorkspaceDiff } from '../diff/workspace.js';
import { parseUnifiedDiff } from '../diff/parser.js';
import { isAllowed } from '../allowlist/allowed_ext.js';
import { buildSystemRulePrompt } from '../rules/matcher.js';
import { MAX_HUNK_LINES, PLUGIN_VERSION } from '../prompts/constants.js';
import { newRunId } from '../runs/store.js';
import type { ReviewRequest, ReviewContext, FileChange } from '../model/request.js';

export async function buildReviewContext(req: ReviewRequest): Promise<ReviewContext> {
  const repoRoot = await gitRevParseToplevel(req.repoRoot);

  let diffText: string;
  let rangeLabel: string;
  if (req.mode === 'workspace') {
    diffText = await collectWorkspaceDiff(repoRoot);
    rangeLabel = 'workspace';
  } else if (req.mode === 'staged') {
    diffText = await gitDiff({ repoRoot, range: 'staged', paths: req.paths });
    rangeLabel = 'staged';
  } else if (req.mode === 'commit') {
    if (!req.commit) throw new Error('OCRP-RUN-011: --commit required when mode=commit');
    diffText = await gitDiff({ repoRoot, range: `commit:${req.commit}`, paths: req.paths });
    rangeLabel = `commit:${req.commit}`;
  } else {
    // range
    if (!req.from || !req.to) throw new Error('OCRP-RUN-011: --from and --to required when mode=range');
    diffText = await gitDiff({ repoRoot, range: `${req.from}..${req.to}`, paths: req.paths });
    rangeLabel = `${req.from}..${req.to}`;
  }

  const maxHunkLines = req.maxHunkLines ?? MAX_HUNK_LINES;
  let files: FileChange[] = parseUnifiedDiff(diffText, { maxHunkLines });

  // allowlist 过滤
  files = files.filter((f) => isAllowed(f.path));

  // 规则匹配
  for (const f of files) {
    const rule = buildSystemRulePrompt(f.path);
    f.rulesHit = [{ ruleId: rule.ruleId, message: '', docPath: rule.docPath }];
  }

  const runId = newRunId();
  return {
    runId,
    repoRoot,
    range: rangeLabel,
    background: req.background ?? '',
    files,
    changeFiles: files.map((f) => f.path),
    meta: { generatedAt: new Date().toISOString(), pluginVersion: PLUGIN_VERSION },
  };
}
```

- [ ] **Step 2: 写 src/cli/prepare.ts**

Create:
```typescript
#!/usr/bin/env node
import { buildReviewContext } from '../core/context/review_context.js';
import { writeContext } from '../core/runs/store.js';
import type { ReviewRequest, ReviewMode } from '../core/model/request.js';

interface ParsedArgs {
  mode: ReviewMode;
  commit?: string;
  from?: string;
  to?: string;
  paths?: string[];
  background?: string;
  rules?: string;
  format?: 'markdown' | 'json' | 'both';
  concurrency?: number;
  dryRun?: boolean;
  preview?: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  // 形式参考 OCR ocr review：
  //   --staged | --commit <sha> | --from <a> --to <b> | (default: workspace)
  //   --paths <glob1,glob2> | --background "..." | --rules <path>
  //   --format text|json|both | --concurrency <n> | --dry-run | --preview
  // 位置参数：第一个非 flag 视为 "staged" / "HEAD~3" 等便捷形式
  const out: ParsedArgs = { mode: 'workspace' };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--staged') out.mode = 'staged';
    else if (a === '--commit' || a === '-c') {
      out.mode = 'commit';
      out.commit = next();
    } else if (a === '--from') {
      out.mode = 'range';
      out.from = next();
    } else if (a === '--to') {
      out.mode = 'range';
      out.to = next();
    } else if (a === '--paths') out.paths = next().split(',');
    else if (a === '--background' || a === '-b') out.background = next();
    else if (a === '--rules') out.rules = next();
    else if (a === '--format' || a === '-f') out.format = next() as ParsedArgs['format'];
    else if (a === '--concurrency') out.concurrency = parseInt(next(), 10);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--preview' || a === '-p') out.preview = true;
    else if (!a.startsWith('-')) {
      // 位置参数便捷形式
      if (a === 'staged') out.mode = 'staged';
      else if (a === 'workspace') out.mode = 'workspace';
      else if (a.includes('..')) {
        out.mode = 'range';
        const [from, to] = a.split('..');
        out.from = from;
        out.to = to;
      } else {
        // 视为 commit sha 或 ref
        out.mode = 'commit';
        out.commit = a;
      }
    }
    i++;
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const req: ReviewRequest = {
    repoRoot: process.cwd(),
    mode: args.mode,
    commit: args.commit,
    from: args.from,
    to: args.to,
    paths: args.paths,
    background: args.background,
    rulesPath: args.rules,
    dryRun: args.dryRun,
    format: args.format,
    concurrency: args.concurrency,
  };
  const ctx = await buildReviewContext(req);
  await writeContext(ctx.runId, ctx);
  const summary = {
    runId: ctx.runId,
    fileCount: ctx.files.length,
    hunkCount: ctx.files.reduce((s, f) => s + f.hunks.length, 0),
    changedLines: ctx.files.reduce(
      (s, f) => s + f.hunks.reduce((ss, h) => ss + h.lines.filter((l) => l.kind !== ' ').length, 0),
      0,
    ),
    contextPath: `.ocr-runs/${ctx.runId}/context.json`,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
}

main().catch((err) => {
  const code = (err && err.message && /OCRP-/.test(err.message)) ? 2 : 1;
  process.stderr.write(`[ocr-prepare] ${err?.message ?? err}\n`);
  process.exit(code);
});
```

- [ ] **Step 3: 运行 typecheck**

Run:
```bash
npm run typecheck
```

Expected: 退出码 0。

- [ ] **Step 4: 跑一次小冒烟 (在本仓库内)**

Run:
```bash
cd /Users/lixiangyang/Desktop/代码/open-code-review-plugin
node --import tsx src/cli/prepare.ts workspace 2>&1 | head -30
```

Expected: 输出形如 `{"runId":"...","fileCount":N,"hunkCount":...,"contextPath":"..."}`。
如果当前 workspace 没有变更，fileCount 可能为 0，这是正常情况。

- [ ] **Step 5: 提交**

```bash
git add src/core/context/ src/cli/prepare.ts
git commit -m "feat: ReviewContext 构造 + bin/ocr-prepare CLI

- buildReviewContext: git diff → parse → allowlist → 规则匹配 → newRunId
- ReviewMode 四种: workspace / staged / commit / range
- ocr-prepare CLI: OCR 风格 flag + 位置参数便捷形式
- stdout 输出 {runId, fileCount, hunkCount, contextPath}

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 9: bin/ 工具 - code_comment / task_done / file_read_diff CLI

**Files:**
- Create: `src/cli/code_comment.ts`
- Create: `src/cli/task_done.ts`
- Create: `src/cli/file_read_diff.ts`

**Interfaces:**
- Consumes: T2 `LlmComment`/`CommentRecord`、T3 store API、T8 `readContext`
- Produces:
  - `code_comment --runId <id> --path <p> --start <n> --end <m> --content <text> [--suggestion-code <c>] [--existing-code <c>] [--thinking <t>] [--subagent <id>]`
  - `task_done --runId <id> --subagent <id> --file <path>`
  - `file_read_diff --runId <id> --path <path>`

- [ ] **Step 1: 写 src/cli/code_comment.ts**

Create:
```typescript
#!/usr/bin/env node
import { appendComment } from '../core/runs/store.js';
import type { CommentRecord } from '../core/model/comment.js';

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] ?? '';
      out[k] = v;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  const required = ['runId', 'path', 'start', 'end', 'content'];
  for (const r of required) {
    if (!f[r]) {
      process.stderr.write(`[code_comment] missing --${r}\n`);
      process.exit(2);
    }
  }
  const rec: CommentRecord = {
    path: f.path,
    start_line: parseInt(f.start, 10),
    end_line: parseInt(f.end, 10),
    content: f.content,
  };
  if (f['suggestion-code']) rec.suggestion_code = f['suggestion-code'];
  if (f['existing-code']) rec.existing_code = f['existing-code'];
  if (f.thinking) rec.thinking = f.thinking;
  rec._meta = {
    subagent: f.subagent ?? 'unknown',
    ts: new Date().toISOString(),
  };
  await appendComment(f.runId, rec);
  process.stdout.write(
    JSON.stringify({ ok: true, path: rec.path, start: rec.start_line, end: rec.end_line }) + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(`[code_comment] ${err?.message ?? err}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: 写 src/cli/task_done.ts**

Create:
```typescript
#!/usr/bin/env node
import { markDone } from '../core/runs/store.js';

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] ?? '';
      out[k] = v;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  for (const r of ['runId', 'subagent', 'file']) {
    if (!f[r]) {
      process.stderr.write(`[task_done] missing --${r}\n`);
      process.exit(2);
    }
  }
  await markDone(f.runId, f.subagent, f.file);
  process.stdout.write(JSON.stringify({ ok: true, subagent: f.subagent, file: f.file }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[task_done] ${err?.message ?? err}\n`);
  process.exit(1);
});
```

- [ ] **Step 3: 写 src/cli/file_read_diff.ts**

Create:
```typescript
#!/usr/bin/env node
import { readContext } from '../core/runs/store.js';
import type { ReviewContext } from '../core/model/request.js';

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] ?? '';
      out[k] = v;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  for (const r of ['runId', 'path']) {
    if (!f[r]) {
      process.stderr.write(`[file_read_diff] missing --${r}\n`);
      process.exit(2);
    }
  }
  const ctx = await readContext<ReviewContext>(f.runId);
  const file = ctx.files.find((x) => x.path === f.path);
  if (!file) {
    process.stderr.write(`[file_read_diff] path not in context: ${f.path}\n`);
    process.exit(3);
  }
  process.stdout.write(file.diff + (file.truncated ? '\n... (truncated)\n' : '\n'));
}

main().catch((err) => {
  process.stderr.write(`[file_read_diff] ${err?.message ?? err}\n`);
  process.exit(1);
});
```

- [ ] **Step 4: typecheck**

Run:
```bash
npm run typecheck
```

Expected: 退出码 0。

- [ ] **Step 5: 手动冒烟 - 串起 prepare + code_comment**

Run:
```bash
cd /Users/lixiangyang/Desktop/代码/open-code-review-plugin
# 临时小 diff
echo "test" >> README.md 2>/dev/null || echo "" > README.md
git add -N README.md 2>/dev/null || true
RUNID=$(node --import tsx src/cli/prepare.ts workspace 2>&1 | grep -o '"runId":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "runId=$RUNID"
node --import tsx src/cli/code_comment.ts --runId "$RUNID" --path README.md --start 1 --end 1 --content "test comment" --subagent reviewer-x
node --import tsx src/cli/task_done.ts --runId "$RUNID" --subagent reviewer-x --file README.md
ls .ocr-runs/$RUNID/
cat .ocr-runs/$RUNID/comments.jsonl
```

Expected: `.ocr-runs/<runId>/` 出现 `context.json`、`comments.jsonl`、`done/reviewer-x.json`；comments.jsonl 含一行 JSON。
完成后清理：`rm -rf .ocr-runs/$RUNID`，`git checkout -- README.md` 或 `git reset README.md`。

- [ ] **Step 6: 提交**

```bash
git add src/cli/
git commit -m "feat: bin CLI - code_comment / task_done / file_read_diff

- code_comment: 解析 flag → CommentRecord → appendComment
- task_done: markDone 写 done/<subagent>.json
- file_read_diff: 读 context.json 中指定 path 的 diff
- 共用 parseFlags 极简实现 (零依赖)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 10: 构建链 - shebang 脚本 + bin/ 同步 + 验证 npm run build

**Files:**
- Create: `scripts/shebang.mjs`
- Modify: `package.json`（增 `build:bin` 脚本，串入 `build`）

**Interfaces:**
- Consumes: 所有 `src/cli/*.ts` 的产物 `dist/cli/*.mjs`
- Produces: `bin/<name>` 软链（指向 `../dist/cli/<name>.mjs`），失败时回退为复制；所有 `dist/cli/*.mjs` 顶部含 `#!/usr/bin/env node` + 可执行权限

- [ ] **Step 1: 写 scripts/shebang.mjs**

Create:
```javascript
#!/usr/bin/env node
/**
 * shebang.mjs - 给 dist/cli/*.mjs 加 shebang + chmod +x，并同步到 bin/。
 * bin/<name> 优先做软链 → dist/cli/<name>.mjs；软链失败时回退为复制。
 */

import { readdir, readFile, writeFile, chmod, symlink, copyFile, unlink, stat, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const cliDir = join(root, 'dist', 'cli');
const binDir = join(root, 'bin');

const SHEBANG = '#!/usr/bin/env node\n';

async function main() {
  await mkdir(binDir, { recursive: true });

  let files = [];
  try {
    files = await readdir(cliDir);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error('[shebang] dist/cli/ not found. Did you run build:tsc + build:mjs first?');
      process.exit(1);
    }
    throw err;
  }

  let count = 0;
  for (const f of files) {
    if (!f.endsWith('.mjs')) continue;
    const full = join(cliDir, f);
    const body = await readFile(full, 'utf8');
    const withShebang = body.startsWith('#!') ? body : SHEBANG + body;
    if (withShebang !== body) {
      await writeFile(full, withShebang, 'utf8');
    }
    await chmod(full, 0o755);

    // 同步到 bin/<basename without .mjs，下划线保留为下划线>
    const stem = basename(f, '.mjs');
    // CLI 名映射：prepare → ocr-prepare, aggregate → ocr-aggregate,
    //            rules_check → ocr-rules-check, 其他保留原名
    const map = {
      prepare: 'ocr-prepare',
      aggregate: 'ocr-aggregate',
      rules_check: 'ocr-rules-check',
    };
    const binName = map[stem] ?? stem;
    const target = join(binDir, binName);

    // 删除已存在的 bin 项
    try { await unlink(target); } catch { /* not exist */ }

    const rel = join('..', 'dist', 'cli', f);
    try {
      await symlink(rel, target);
    } catch (err) {
      // Windows 等不允许软链时，回退为复制
      await copyFile(full, target);
      await chmod(target, 0o755);
    }
    console.log(`[shebang] ${binName} -> dist/cli/${f}`);
    count++;
  }
  console.log(`[shebang] done. processed ${count} file(s).`);
}

main().catch((err) => {
  console.error('[shebang] failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: 修改 package.json 串入 build:bin**

修改 `package.json` 的 `scripts.build` 与新增 `scripts.build:bin`：
```json
{
  "scripts": {
    "clean": "rm -rf dist bin/[^.]* 2>/dev/null || true",
    "build:tsc": "tsc -p tsconfig.json",
    "build:assets": "node scripts/copy-assets.mjs",
    "build:mjs": "node scripts/build-mjs.mjs",
    "build:bin": "node scripts/shebang.mjs",
    "build": "npm run clean && npm run build:tsc && npm run build:assets && npm run build:mjs && npm run build:bin",
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test src/**/__tests__/*.test.ts",
    "preview": "ls -la dist/ bin/"
  }
}
```

注意 `clean` 改为同时清 `bin/` 下非隐藏文件（保留 `.gitkeep`）。

- [ ] **Step 3: 全量构建一次**

Run:
```bash
cd /Users/lixiangyang/Desktop/代码/open-code-review-plugin
npm run build 2>&1 | tail -30
```

Expected: 无错误；输出含 `[copy-assets]`、`[build-mjs]`、`[shebang]` 三段。

- [ ] **Step 4: 验证 bin/ 结构**

Run:
```bash
ls -la bin/
file bin/ocr-prepare
```

Expected: `bin/` 含 `ocr-prepare`、`code_comment`、`task_done`、`file_read_diff`、`.gitkeep`；`file` 显示为 symlink 或 ESM script。

- [ ] **Step 5: 验证 bin 可直接执行**

Run:
```bash
./bin/ocr-prepare --help 2>&1 || ./bin/ocr-prepare workspace 2>&1 | head -10
```

Expected: 退出码非 127（不是 "command not found"）。即使逻辑层报错（如非 git 仓库等）也可，只要能拉起 node。

- [ ] **Step 6: 提交**

```bash
git add scripts/shebang.mjs package.json
git commit -m "feat: 构建链 - shebang + bin/ 软链同步

- scripts/shebang.mjs: 给 dist/cli/*.mjs 加 #!/usr/bin/env node + chmod +x
- 软链 bin/<name> → ../dist/cli/<name>.mjs，失败时回退为复制
- CLI 名映射：prepare → ocr-prepare, aggregate → ocr-aggregate, rules_check → ocr-rules-check
- package.json: build = clean + tsc + assets + mjs + bin

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 11: Hook handler + hooks.json

**Files:**
- Create: `src/host/claude-code/hook_handler.ts`
- Create: `src/host/claude-code/__tests__/hook_handler.test.ts`
- Create: `hooks/hooks.json`

**Interfaces:**
- Consumes: T3 `appendEvent`、CLI 名约定
- Produces:
  - hook_handler 是一个独立 CLI：从 stdin 读 Claude Code 传入的 hook JSON，解析 `tool_input.command`，若命中三个工具之一则 `appendEvent` 并向 stdout 写一行人类可读的进度提示
  - `hooks/hooks.json` 声明 PostToolUse hook 匹配 Bash 工具，命令为 `node "${CLAUDE_PLUGIN_ROOT}/dist/host/claude-code/hook_handler.mjs"`

> 实施期需要验证：Claude Code 是否会消费 hook 命令的 stdout 作为可见消息。即使不可见，本插件的"jsonl 持久化总线"已保证最终结果正确（spec §11.1）。

- [ ] **Step 1: 写失败测试 src/host/claude-code/__tests__/hook_handler.test.ts**

Create:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHookInput, extractToolCall, formatProgressLine } from '../hook_handler.js';

test('parseHookInput 正确解析 JSON', () => {
  const j = parseHookInput('{"tool_name":"Bash","tool_input":{"command":"code_comment --runId x --path y --start 1 --end 1 --content z"}}');
  assert.equal(j?.tool_name, 'Bash');
  assert.equal(j?.tool_input?.command?.startsWith('code_comment'), true);
});

test('parseHookInput 容错非 JSON', () => {
  assert.equal(parseHookInput('not json'), null);
});

test('extractToolCall 识别 code_comment', () => {
  const t = extractToolCall('code_comment --runId R --path src/a.ts --start 42 --end 50 --content "x" --subagent reviewer-a');
  assert.deepEqual(t, {
    tool: 'code_comment',
    args: { runId: 'R', path: 'src/a.ts', start: '42', end: '50', content: 'x', subagent: 'reviewer-a' },
  });
});

test('extractToolCall 识别 task_done', () => {
  const t = extractToolCall('task_done --runId R --subagent reviewer-a --file src/a.ts');
  assert.equal(t?.tool, 'task_done');
});

test('extractToolCall 识别 file_read_diff', () => {
  const t = extractToolCall('file_read_diff --runId R --path src/a.ts');
  assert.equal(t?.tool, 'file_read_diff');
});

test('extractToolCall 非目标命令返回 null', () => {
  assert.equal(extractToolCall('ls -la'), null);
  assert.equal(extractToolCall('git status'), null);
});

test('formatProgressLine code_comment', () => {
  const line = formatProgressLine({
    tool: 'code_comment',
    args: { subagent: 'reviewer-a', path: 'src/foo.ts', start: '42' } as any,
  });
  assert.match(line, /💬|reviewer-a|src\/foo.ts/);
});

test('formatProgressLine task_done', () => {
  const line = formatProgressLine({ tool: 'task_done', args: { subagent: 'reviewer-a', file: 'src/a.ts' } as any });
  assert.match(line, /✅|reviewer-a/);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:
```bash
npm test 2>&1 | tail -10
```

Expected: 模块找不到。

- [ ] **Step 3: 实现 src/host/claude-code/hook_handler.ts**

Create:
```typescript
#!/usr/bin/env node
import { appendEvent } from '../../core/runs/store.js';

export interface ToolCallExtraction {
  tool: 'code_comment' | 'task_done' | 'file_read_diff';
  args: Record<string, string>;
}

export interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export function parseHookInput(raw: string): HookInput | null {
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return null;
  }
}

const TARGET_TOOLS = ['code_comment', 'task_done', 'file_read_diff'] as const;

/**
 * 从 Bash command 字符串提取目标工具调用。
 * 支持简单的 `--key value` 形式 (值含空格时必须用引号；本提取器简化处理：
 *  使用 shell 词法极简版 — 空格分隔，"..." 内空格保留)。
 */
function splitArgs(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: '"' | "'" | null = null;
  for (const c of cmd) {
    if (q) {
      if (c === q) q = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
    } else if (c === ' ') {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function extractToolCall(cmd: string): ToolCallExtraction | null {
  const parts = splitArgs(cmd);
  if (parts.length === 0) return null;
  const head = parts[0];
  if (!TARGET_TOOLS.includes(head as typeof TARGET_TOOLS[number])) return null;
  const args: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const a = parts[i];
    if (a.startsWith('--')) {
      args[a.slice(2)] = parts[i + 1] ?? '';
      i++;
    }
  }
  return { tool: head as ToolCallExtraction['tool'], args };
}

export function formatProgressLine(t: ToolCallExtraction): string {
  if (t.tool === 'code_comment') {
    return `💬 ${t.args.subagent ?? '?'} → ${t.args.path}:${t.args.start} 提交评论`;
  }
  if (t.tool === 'task_done') {
    return `✅ ${t.args.subagent ?? '?'} 完成 ${t.args.file ?? ''}`;
  }
  return `📖 ${t.args.path ?? '?'} 读取 diff`;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const j = parseHookInput(raw);
  if (!j || j.tool_name !== 'Bash') return; // 静默忽略
  const cmd = j.tool_input?.command;
  if (!cmd) return;
  const tc = extractToolCall(cmd);
  if (!tc) return;
  // 持久化总线：写 events.jsonl（最佳努力，失败不阻塞）
  try {
    if (tc.args.runId) {
      await appendEvent(tc.args.runId, { type: 'tool_call', tool: tc.tool, args: tc.args });
    }
  } catch {
    /* OCRP-HOOK-060: hook 失败不阻塞 */
  }
  // 事件总线：stdout 写一行进度提示
  process.stdout.write(formatProgressLine(tc) + '\n');
}

// 仅当作为 entry 运行时才执行 main；测试 import 时不应运行
const isMain = process.argv[1] && process.argv[1].endsWith('hook_handler.mjs');
if (isMain || (process.argv[1] && process.argv[1].endsWith('hook_handler.ts'))) {
  main().catch(() => process.exit(0)); // 永远不阻塞宿主
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run:
```bash
npm test 2>&1 | tail -10
```

Expected: hook_handler 8 个测试通过。

- [ ] **Step 5: 创建 hooks/hooks.json**

Create:
```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/host/claude-code/hook_handler.mjs\""
          }
        ]
      }
    ]
  }
}
```

注意：`${CLAUDE_PLUGIN_ROOT}` 是 Claude Code 注入的环境变量，指向当前插件的根目录。若实际名称不同（实施期需在 spec §11.1 确认），把 `hook_handler.mjs` 加一层 fallback 也可（如先用 `${CLAUDE_PLUGIN_ROOT}` 失败再用相对 cwd 寻路）。本期保守使用文档化变量。

- [ ] **Step 6: 全量构建并验证 hook handler 可拉起**

Run:
```bash
npm run build && echo '{"tool_name":"Bash","tool_input":{"command":"code_comment --runId test --path a.ts --start 1 --end 1 --content x --subagent reviewer-a"}}' | node dist/host/claude-code/hook_handler.mjs
```

Expected: 输出 `💬 reviewer-a → a.ts:1 提交评论`。

- [ ] **Step 7: 提交**

```bash
git add src/host/claude-code/ hooks/
git commit -m "feat: hook handler + hooks.json (PostToolUse 双总线)

- parseHookInput / extractToolCall / formatProgressLine 三个纯函数 + 8 个单测
- 主流程: stdin 读 hook JSON → 解析 Bash command → 命中目标工具时
  ① appendEvent 写 events.jsonl (持久化总线)
  ② stdout 输出进度行 (事件总线)
- hook 失败永远不阻塞宿主 (OCRP-HOOK-060 降级原则)
- hooks/hooks.json 声明 PostToolUse 匹配 Bash → 拉起 hook_handler.mjs

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 12: Report 渲染 + bin/ocr-aggregate + bin/ocr-rules-check

**Files:**
- Create: `src/core/report/markdown.ts`
- Create: `src/core/report/json.ts`
- Create: `src/core/report/__tests__/markdown.test.ts`
- Create: `src/cli/aggregate.ts`
- Create: `src/cli/rules_check.ts`

**Interfaces:**
- Consumes: T2-T11
- Produces:
  - `renderMarkdownReport(ctx, comments, opts): string`
  - `renderJsonReport(ctx, comments, opts): string` (OCR 兼容 schema)
  - bin `ocr-aggregate --runId <id>`：读 context + comments + done → 渲染 → 写 report.md/.json
  - bin `ocr-rules-check <path>`：输入路径 → 输出命中规则与 rule_docs 文本

- [ ] **Step 1: 写失败测试 src/core/report/__tests__/markdown.test.ts**

Create:
```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownReport } from '../markdown.js';
import type { ReviewContext } from '../../model/request.js';
import type { CommentRecord } from '../../model/comment.js';

const CTX: ReviewContext = {
  runId: 'r1',
  repoRoot: '/abs',
  range: 'HEAD~3..HEAD',
  background: 'fixing race',
  files: [
    {
      path: 'src/a.ts',
      status: 'modified',
      diff: '',
      truncated: false,
      hunks: [],
      rulesHit: [],
    },
    {
      path: 'src/b.ts',
      status: 'modified',
      diff: '',
      truncated: false,
      hunks: [],
      rulesHit: [],
    },
  ],
  changeFiles: ['src/a.ts', 'src/b.ts'],
  meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
};

const COMMENTS: CommentRecord[] = [
  { path: 'src/a.ts', start_line: 10, end_line: 12, content: 'high issue', _meta: { ts: 't1' } },
  { path: 'src/a.ts', start_line: 30, end_line: 30, content: 'medium issue', _meta: { ts: 't2' } },
];

test('renderMarkdownReport 含标题、文件数、评论', () => {
  const md = renderMarkdownReport(CTX, COMMENTS, { partialFiles: [] });
  assert.match(md, /Code Review Results/i);
  assert.match(md, /Files reviewed.*2/);
  assert.match(md, /src\/a\.ts:10/);
  assert.match(md, /high issue/);
});

test('renderMarkdownReport partialFiles 在顶部产生 Warnings 段', () => {
  const md = renderMarkdownReport(CTX, [], { partialFiles: ['src/c.ts'] });
  assert.match(md, /⚠️ Warnings/);
  assert.match(md, /src\/c\.ts/);
});

test('renderMarkdownReport 无评论时输出 No issues 信息', () => {
  const md = renderMarkdownReport(CTX, [], { partialFiles: [] });
  assert.match(md, /no issues found/i);
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:
```bash
npm test 2>&1 | tail -10
```

Expected: 模块找不到。

- [ ] **Step 3: 实现 src/core/report/markdown.ts**

参考 OCR plugin SKILL.md 的报告模板。Create:
```typescript
import type { ReviewContext } from '../model/request.js';
import type { CommentRecord } from '../model/comment.js';

export interface RenderOpts {
  partialFiles: string[];
}

/**
 * 渲染 Markdown 报告。模板与 OCR plugins/open-code-review/skills/.../SKILL.md
 * 中给出的"Output Format"段对齐：High Priority / Medium Priority 分组，
 * Low 静默丢弃 (与 OCR 一致)。
 *
 * 本 P0 阶段：评论的 severity 由宿主模型在 content 中自然语言描述，
 * 我们暂时把所有从 jsonl 收集到的 comment 都视为 medium（与 OCR plugin
 * 的"分类与展示由宿主完成"理念一致）；后续 P1 的 REVIEW_FILTER_TASK
 * 可在聚合前对 comment 做 severity 分类。
 */
export function renderMarkdownReport(
  ctx: ReviewContext,
  comments: CommentRecord[],
  opts: RenderOpts,
): string {
  const lines: string[] = [];

  if (opts.partialFiles.length > 0) {
    lines.push('## ⚠️ Warnings', '');
    for (const p of opts.partialFiles) {
      lines.push(`- ${p} 评审未完成 (subagent 未调用 task_done; partial=true)`);
    }
    lines.push('');
  }

  lines.push('## Code Review Results', '');
  lines.push(`**Run**: \`${ctx.runId}\`  `);
  lines.push(`**Range**: \`${ctx.range}\`  `);
  lines.push(`**Files reviewed**: ${ctx.files.length}  `);
  lines.push(`**Issues found**: ${comments.length}`);
  lines.push('');

  if (comments.length === 0) {
    lines.push(`Review complete — no issues found in ${ctx.files.length} file(s).`);
    return lines.join('\n');
  }

  // 按文件 + 起始行排序
  const sorted = [...comments].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.start_line - b.start_line;
  });

  lines.push('### Comments', '');
  for (const c of sorted) {
    const range =
      c.start_line === c.end_line ? `${c.start_line}` : `${c.start_line}-${c.end_line}`;
    lines.push(`- **\`${c.path}:${range}\`** — ${c.content.split('\n')[0]}`);
    if (c.content.includes('\n')) {
      const rest = c.content.split('\n').slice(1).join('\n');
      lines.push('  ', '  ' + rest.split('\n').join('\n  '));
    }
    if (c.suggestion_code) {
      lines.push('', '  Suggested:', '', '  ```', '  ' + c.suggestion_code.split('\n').join('\n  '), '  ```');
    }
    lines.push('');
  }

  lines.push(`---`);
  lines.push(`_Generated by open-code-review-plugin ${ctx.meta.pluginVersion} at ${ctx.meta.generatedAt}_`);
  return lines.join('\n');
}
```

- [ ] **Step 4: 实现 src/core/report/json.ts**

Create:
```typescript
import type { ReviewContext } from '../model/request.js';
import type { CommentRecord, LlmComment } from '../model/comment.js';

/**
 * OCR-compatible report JSON. 字段与 OCR `cmd/opencodereview/output.go::outputJSONWithWarnings` 对齐。
 */
export interface ReportJson {
  status: 'ok' | 'partial' | 'error';
  message?: string;
  summary: {
    files_reviewed: number;
    comments: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    duration_ms: number;
  };
  comments: LlmComment[];
  warnings: Array<{ path: string; reason: string }>;
}

export function renderJsonReport(
  ctx: ReviewContext,
  comments: CommentRecord[],
  opts: { partialFiles: string[]; durationMs: number },
): string {
  const lite: LlmComment[] = comments.map((c) => {
    const { _meta, ...rest } = c;
    return rest;
  });
  const r: ReportJson = {
    status: opts.partialFiles.length > 0 ? 'partial' : 'ok',
    summary: {
      files_reviewed: ctx.files.length,
      comments: lite.length,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      duration_ms: opts.durationMs,
    },
    comments: lite,
    warnings: opts.partialFiles.map((p) => ({ path: p, reason: 'subagent did not call task_done' })),
  };
  return JSON.stringify(r, null, 2);
}
```

注：token 字段在本插件中无来源（推理由宿主完成）；按 OCR schema 保留字段但置 0，确保下游消费者 schema 一致。

- [ ] **Step 5: 实现 src/cli/aggregate.ts**

Create:
```typescript
#!/usr/bin/env node
import {
  readContext,
  readComments,
  listDone,
  writeReport,
} from '../core/runs/store.js';
import { renderMarkdownReport } from '../core/report/markdown.js';
import { renderJsonReport } from '../core/report/json.js';
import type { ReviewContext } from '../core/model/request.js';
import type { CommentRecord } from '../core/model/comment.js';

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] ?? '';
      out[k] = v;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const start = Date.now();
  const f = parseFlags(process.argv.slice(2));
  if (!f.runId) {
    process.stderr.write('[ocr-aggregate] missing --runId\n');
    process.exit(2);
  }
  const format = f.format ?? 'both';

  const ctx = await readContext<ReviewContext>(f.runId);
  const comments = await readComments<CommentRecord>(f.runId);
  const dones = await listDone(f.runId);
  const doneFiles = new Set(dones.map((d) => d.file));
  const expected = new Set(ctx.files.map((x) => x.path));
  const partialFiles: string[] = [];
  for (const p of expected) if (!doneFiles.has(p)) partialFiles.push(p);

  const dur = Date.now() - start;

  if (format === 'markdown' || format === 'both') {
    const md = renderMarkdownReport(ctx, comments, { partialFiles });
    await writeReport(f.runId, 'report.md', md);
  }
  if (format === 'json' || format === 'both') {
    const j = renderJsonReport(ctx, comments, { partialFiles, durationMs: dur });
    await writeReport(f.runId, 'report.json', j);
  }
  process.stdout.write(
    JSON.stringify({
      runId: f.runId,
      reportMd: `.ocr-runs/${f.runId}/report.md`,
      reportJson: `.ocr-runs/${f.runId}/report.json`,
      partial: partialFiles.length > 0,
      filesReviewed: ctx.files.length,
      commentCount: comments.length,
      partialFiles,
    }, null, 2) + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(`[ocr-aggregate] ${err?.message ?? err}\n`);
  process.exit(1);
});
```

- [ ] **Step 6: 实现 src/cli/rules_check.ts**

Create:
```typescript
#!/usr/bin/env node
import { buildSystemRulePrompt } from '../core/rules/matcher.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('[ocr-rules-check] usage: ocr-rules-check <path>\n');
    process.exit(2);
  }
  const p = args[0];
  const m = buildSystemRulePrompt(p);
  process.stdout.write(
    JSON.stringify({ path: p, ruleId: m.ruleId, docPath: m.docPath, textPreview: m.text.slice(0, 200) }, null, 2) + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(`[ocr-rules-check] ${err?.message ?? err}\n`);
  process.exit(1);
});
```

- [ ] **Step 7: 运行测试 + 构建**

Run:
```bash
npm test 2>&1 | tail -10
npm run build 2>&1 | tail -10
```

Expected: 测试全过；构建无错。`bin/ocr-aggregate`、`bin/ocr-rules-check` 出现。

- [ ] **Step 8: 手动冒烟整条链**

Run:
```bash
cd /Users/lixiangyang/Desktop/代码/open-code-review-plugin
echo "// new line" >> README.md
git add -N README.md
SUMMARY=$(./bin/ocr-prepare workspace)
echo "$SUMMARY"
RUNID=$(echo "$SUMMARY" | grep -o '"runId":"[^"]*"' | cut -d'"' -f4)
./bin/code_comment --runId "$RUNID" --path README.md --start 1 --end 1 --content "smoke test comment" --subagent reviewer-x
./bin/task_done --runId "$RUNID" --subagent reviewer-x --file README.md
./bin/ocr-aggregate --runId "$RUNID"
cat .ocr-runs/$RUNID/report.md
echo "---"
cat .ocr-runs/$RUNID/report.json | head -30
# cleanup
rm -rf .ocr-runs/$RUNID
git checkout -- README.md 2>/dev/null || git reset README.md
```

Expected:
- `report.md` 包含 `## Code Review Results`、`Files reviewed: 1`、`smoke test comment`
- `report.json` schema 含 `status`、`summary`、`comments[]`

注意：如果 `git checkout -- README.md` 因为是新插入而无效，用 `git restore README.md` 或手动撤改。

- [ ] **Step 9: 验证 ocr-rules-check**

Run:
```bash
./bin/ocr-rules-check src/foo.ts
```

Expected: 输出 `{path, ruleId: "ts_js_tsx_jsx", docPath: "ts_js_tsx_jsx.md", textPreview: "..."}`。

- [ ] **Step 10: 提交**

```bash
git add src/core/report/ src/cli/aggregate.ts src/cli/rules_check.ts
git commit -m "feat: report 渲染 + ocr-aggregate + ocr-rules-check

- renderMarkdownReport: 与 OCR plugin SKILL.md 的 Output Format 对齐
  支持 partialFiles → 顶部 ⚠️ Warnings 段
- renderJsonReport: OCR-compatible schema (status/summary/comments[]/warnings[])
  token 字段保留但置 0 (推理委托宿主)
- ocr-aggregate: 读 context + comments + done → 渲染 report.md + report.json
  通过 done/ 目录缺失判定 partial
- ocr-rules-check: 复刻 OCR \`ocr rules check\`

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 13: Skills + Agent + Command 编排骨架

**Files:**
- Create: `skills/ocr-plan/SKILL.md`
- Create: `skills/ocr-review-file/SKILL.md`
- Create: `agents/ocr-reviewer.md`
- Overwrite: `commands/review.md`
- Create: `src/host/opencode/README.md`（占位）
- Delete: `skills/code-review/SKILL.md`（旧占位 skill，已被 ocr-review-file 取代）

**Interfaces:**
- Consumes: T7 的 MAIN_TASK_SYSTEM / PLAN_TASK_SYSTEM 字符串（这里需要把它们的内容**手动嵌入** SKILL.md，因为 SKILL.md 是 Markdown 而非 TS import）
- Produces: 用户输入 `/open-code-review:review HEAD~3 -b "..."` 后可完整跑通 PLAN → 并行 reviewer → aggregate

> **重要**：SKILL.md 中的 system prompt 字符串需要逐字复制 T7 中的 `MAIN_TASK_SYSTEM` / `PLAN_TASK_SYSTEM` 内容（不在 SKILL.md 中用 import 引用——它是给宿主读的 Markdown）。这是允许的"双源"（TS 字符串 + SKILL.md），因为 TS 字符串用于未来非 ClaudeCode 宿主时的统一实现，而 SKILL.md 是 ClaudeCode 宿主直接消费的形态。

- [ ] **Step 1: 写 skills/ocr-plan/SKILL.md**

Create:
````markdown
---
name: ocr-plan
description: |
  Generate a structured review plan (PLAN_TASK) for a code change. Input: a
  ReviewContext file from .ocr-runs/<runId>/context.json. Output: a JSON
  object with {change_summary, issues[]}, written to plan.json.
  Use only when the host /open-code-review:review command requests it
  (triggered by totalChangedLines > 50).
---

# OCR Plan Skill

You are an expert in code review task planning. You have access to a set of tools for retrieving relevant context about code changes, and your responsibility is to analyze those changes and produce a structured review plan.

## Core Responsibilities

Analyze code change content, identify potential risk points, and plan appropriate tool-calling strategies for each risk point.

## Tool Descriptions

- **Read**: read a file's content by absolute or repo-relative path.
- **Glob**: find files by glob pattern (e.g. "src/**/*.ts").
- **Grep**: search code by regex/text across the repository.
- **file_read_diff**: read the unified diff of another changed file in the current review.

## Output Format

Strictly follow the JSON format below. Do not include any additional explanatory text:

```json
{
  "change_summary": "A brief description of the purpose and scope of this code change",
  "issues": [
    {
      "severity": "high|medium|low",
      "description": "A clear description of the specific problem and its potential impact for this risk point",
      "tool_guidance": [
        {
          "name": "Tool name",
          "reason": "Explain the purpose of calling this tool and its relevance to the current issue",
          "arguments": "Invocation arguments"
        }
      ]
    }
  ]
}
```

## Analysis Rules

1. **Scope**: Only analyze newly added and modified code; ignore deleted code
2. **Ordering**: The issues list must be sorted by severity in descending order (high → medium → low)
3. **Severity Definitions**:
   - `high`: May cause security vulnerabilities, data loss, system crashes, or critical functional failures
   - `medium`: May affect performance, maintainability, or involve potential edge-case problems
   - `low`: Code style, readability, or non-critical best practice suggestions
4. **Tool Usage**: Tools are for reference purposes only and must not be actually invoked; describe the calling intent within tool_guidance
5. **Description Requirements**: Each description must cover three dimensions — problem location, nature of the problem, and potential impact

## Input Hand-off

The /open-code-review:review command will pass you the runId and you should:

1. Read `.ocr-runs/<runId>/context.json` to get the ReviewContext (files, diffs, rulesHit).
2. Produce ONE PlanOutput JSON covering ALL files in `context.files[]`.
3. Return the JSON inside a single fenced ```json block. The command will parse it and write to `plan.json`.

If your output cannot be parsed as JSON, the host command will downgrade with error code OCRP-SKILL-040 and proceed without plan_guidance.
````

- [ ] **Step 2: 写 skills/ocr-review-file/SKILL.md**

Create:
````markdown
---
name: ocr-review-file
description: |
  Review a single file's diff (MAIN_TASK). Used by the reviewer subagent
  defined in agents/ocr-reviewer.md. Inputs: runId + currentFile path +
  changeFiles + background + systemRule + planGuidance. Outputs: zero or
  more comments via `code_comment` Bash command, then `task_done` Bash.
---

# OCR Review-File Skill (MAIN_TASK)

## Role

You are a code review assistant developed by Alibaba. You are skilled at code review in the software development process and are responsible for providing professional review feedback for code changes that are about to be submitted. Your feedback perfectly combines detailed analysis with contextual explanations.

You are working in an IDE with editor concepts for open files and an integrated terminal. The user's developed code is stored in the IDE's staging area.

Before users commit staged code to remote repositories, they will send you tasks to help them complete the process successfully. Each time a user sends a task, it will be placed in `<user_task>`, and you will use tools to interact with the real world when executing tasks.

Please keep your responses concise and objective.

## Capabilities

- Think step by step progressively.
- First understand the code changes to be reviewed. Code changes are provided in Unified Diff format, where lines starting with `-` indicate deleted code, lines starting with `+` indicate added code, consecutive `-` and `+` lines represent modified code, and other lines represent unchanged code.
- Be objective and neutral, make judgments based on facts and logic, avoid subjective assumptions. When the context is unclear, use tools to obtain contextual information rather than judging based on assumptions.
- For the current code changes, provide feedback opinions, pointing out areas for improvement or potential issues. Focus on issues in newly added code.
- Avoid commenting on correct code or unchanged code.
- Avoid commenting on deleted code; deleted code serves only as reference context.
- Focus on clarity, practicality, and comprehensiveness.
- Use developer-friendly terminology and analogies in explanations.
- Focus primarily on the actual code logic and functionality. Avoid commenting on or providing feedback about non-functional elements such as code comments, tool-generated indicators (like @Generated annotations), or other metadata, unless the user explicitly requests you to review these elements.

## Strict Focus Rules

- Context tools are for understanding purposes only. Findings from other files must NOT become the subject of your comments.
- If you discover a potential issue in another file while gathering context, ignore it — your task is limited to the current diffs.

## Tool Mapping (host: Claude Code)

- To read a file: use the **Read** tool.
- To find files by pattern: use the **Glob** tool.
- To search code text: use the **Grep** tool.
- To read another changed file's diff: run **Bash** with `file_read_diff --runId <runId> --path <path>`.
- To submit a confirmed review comment: run **Bash** with:
  `code_comment --runId <runId> --path <p> --start <n> --end <m> --content <text> [--suggestion-code <code>] [--existing-code <code>] [--thinking <text>] --subagent <subagent_id>`
- When your review is complete, run **Bash** with: `task_done --runId <runId> --subagent <subagent_id> --file <currentFilePath>`.

## Reply limit

- If the current code review task is complete, run the `task_done` Bash command to end the task.
- If a code issue has been identified and confirmed, run the `code_comment` Bash command to provide feedback.
- If additional context is needed to confirm the issue, use Read / Glob / Grep / file_read_diff.

---

## Task Input

The main session will inject:

- `runId` — the .ocr-runs/<runId>/ directory key
- `subagent` — your unique id (e.g. `reviewer-a`)
- `currentFilePath`, `currentFileDiff`, `changeFiles[]`, `requirementBackground`, `systemRule`, `planGuidance`, `currentSystemDateTime`

Treat the diff in `<current_file_diff>` as your sole review target.
````

- [ ] **Step 3: 写 agents/ocr-reviewer.md**

Create:
````markdown
---
name: ocr-reviewer
description: |
  Single-file code reviewer subagent. Reads one file's diff from a prepared
  ReviewContext and emits review comments via the plugin's bin/code_comment
  Bash CLI. Always ends with bin/task_done.
tools:
  - Read
  - Glob
  - Grep
  - Bash
---

You are an `ocr-reviewer` subagent invoked by the `/open-code-review:review` command. Follow the **ocr-review-file** skill instructions exactly. Your scope is limited to the single file passed to you via the user message.

Workflow:

1. Read the user message to extract: `runId`, `subagent` (your id), `currentFilePath`, `currentFileDiff`, `changeFiles[]`, `requirementBackground`, `systemRule`, `planGuidance`.
2. Apply the **ocr-review-file** skill: analyze the diff, gather context via Read/Glob/Grep/file_read_diff as needed.
3. For each confirmed issue, run Bash: `code_comment --runId <runId> --path <currentFilePath> --start <n> --end <m> --content <text> --subagent <subagent>`.
4. After all comments are submitted (or if there are no issues), run Bash: `task_done --runId <runId> --subagent <subagent> --file <currentFilePath>`.
5. Your final assistant message must be a single short line: `done: <currentFilePath>` (or `done: <currentFilePath> (no issues)`).

Hard constraints:

- You may NOT use Edit / Write / WebFetch / any other tool not in the allowed list above. Comments are submitted only via the `code_comment` Bash command — never edit code directly.
- You may NOT call `code_comment` for a path other than your `currentFilePath`.
- If you cannot complete review (e.g. diff is malformed), still call `task_done` to signal completion; describe the issue in a single `code_comment` with content prefixed `[review-error]`.
````

- [ ] **Step 4: 覆盖 commands/review.md**

Overwrite:
````markdown
---
description: |
  Run the open-code-review-plugin code review on a git change set. Pass-through
  flags align with alibaba/open-code-review CLI: workspace (default), --staged,
  --commit <sha>, --from <a> --to <b>, --paths, --background, --rules.
argument-hint: "[workspace|staged|<sha>|<from>..<to>] [--background \"...\"]"
---

# /review — open-code-review-plugin

Run a code review on the current git change set using the host's agent loop.

## Workflow

You are orchestrating a code review. Follow these steps in order.

### Step 1 — Prepare

Run Bash:

```bash
ocr-prepare $ARGUMENTS
```

Capture the stdout JSON. It contains `runId`, `fileCount`, `hunkCount`, `changedLines`, `contextPath`.

If `fileCount` is 0 → tell the user "No changes to review." and stop.
If the command exits non-zero → surface the stderr to the user and stop.

### Step 2 — Plan (only when changedLines > 50)

If `changedLines > 50`:

1. Read `.ocr-runs/<runId>/context.json` to load the ReviewContext.
2. Invoke the `ocr-plan` skill with the runId. Its output should be a fenced ```json block containing PlanOutput.
3. Parse the JSON. If parsing fails, set `planMissing = true` and continue (downgrade per OCRP-SKILL-040).
4. If parsing succeeds, run Bash to write the plan:
   ```bash
   node -e "import('node:fs/promises').then(fs=>fs.writeFile('.ocr-runs/<runId>/plan.json', process.argv[1]))" '<the json string>'
   ```
   (Or write it via the Write tool to `.ocr-runs/<runId>/plan.json`.)

Otherwise skip this step.

### Step 3 — Dispatch reviewer subagents in parallel

For each file in `context.files[]`:

1. Compute `planGuidance` — if `plan.json` exists, extract the issues whose `description`, `tool_guidance.arguments`, or `tool_guidance.reason` mention this file's path, plus any with `file_hint == path`. Format as a Markdown bullet list sorted high→medium→low. If empty, use "".
2. Dispatch a `ocr-reviewer` subagent (via the Task tool) with a prompt containing exactly:

   ```
   runId: <runId>
   subagent: reviewer-<index>
   currentFilePath: <path>
   currentFileDiff:
   <fenced diff block>
   changeFiles: <comma-joined list>
   requirementBackground: <background or "">
   systemRule:
   <contents of assets/rule_docs/<rulesHit[0].docPath> verbatim>
   planGuidance:
   <planGuidance string or "">
   currentSystemDateTime: <ISO-8601>
   ```

Cap concurrency at 8 (override with the `--concurrency <n>` flag in $ARGUMENTS).

### Step 4 — Aggregate

After all reviewer subagents return (each ends with `done: <path>`), run Bash:

```bash
ocr-aggregate --runId <runId>
```

The stdout JSON contains `reportMd`, `reportJson`, `partial`, `partialFiles`.

### Step 5 — Present to user

Read `.ocr-runs/<runId>/report.md` and reply with its full contents inline. Also tell the user where the artifacts live:

- `<repo>/.ocr-runs/<runId>/report.md`
- `<repo>/.ocr-runs/<runId>/report.json`
- `<repo>/.ocr-runs/<runId>/comments.jsonl`

If `partial == true`, prefix your message with: `⚠️ Some files did not complete review; see Warnings section.`

## Error handling

| Error code | What to do |
|---|---|
| OCRP-LOAD-002 | "Plugin not built — please run `npm run build` in the plugin directory." |
| OCRP-RUN-010 | "Not a git repository at `<cwd>`. Run `/review` inside a git repo." |
| OCRP-RUN-011 | "Argument conflict: <message>. Use only one of --staged / --commit / --from..--to." |
| OCRP-RUN-012 | "No changes to review." (exit 0) |
| OCRP-SKILL-040 | Continue without plan_guidance; mention in the final report. |
| OCRP-SUB-050/051 | Already surfaced by `ocr-aggregate` as partial. |
| OCRP-HOOK-060 | Silent; jsonl bus still works. |
````

- [ ] **Step 5: 写 src/host/opencode/README.md（占位）**

Create:
```markdown
# opencode HostAdapter (placeholder, P1+)

This directory is reserved for the future opencode HostAdapter implementation.
P0 of open-code-review-plugin only targets Claude Code (see ../claude-code/).

To add opencode support later:
1. Mirror `../claude-code/hook_handler.ts` to `./hook_handler.ts`.
2. Add a `commands/`, `agents/`, `skills/` set appropriate to opencode's plugin
   contract (the design assumes the same `bin/` CLI shape works unchanged).
3. Update `.claude-plugin/plugin.json` or add a sibling `.opencode-plugin/plugin.json`.

See `docs/superpowers/specs/2026-06-24-opencodereview-plugin-design.md` §1 for the cross-host alignment rationale.
```

- [ ] **Step 6: 删除旧的 skills/code-review/SKILL.md**

Run:
```bash
rm -rf /Users/lixiangyang/Desktop/代码/open-code-review-plugin/skills/code-review
```

Expected: 目录已删除（旧占位 skill 被 ocr-review-file 取代）。

- [ ] **Step 7: 构建一次，验证 dist 中含 opencode README（如果走 copy-assets）**

Run:
```bash
npm run build && find dist -name "*.md" | head -5
```

Expected: 构建成功。`dist/host/opencode/README.md` 应被 copy-assets 复制（因为脚本扫 .md）。

- [ ] **Step 8: 提交**

```bash
git add skills/ agents/ commands/ src/host/opencode/
git rm -rf skills/code-review 2>/dev/null || true
git add -A
git commit -m "feat: skills + agents + commands 编排骨架

- skills/ocr-plan/SKILL.md: PLAN_TASK，输出 PlanOutput JSON
- skills/ocr-review-file/SKILL.md: MAIN_TASK，逐字移植 OCR system prompt
  (仅工具说明改为 Read/Glob/Grep/Bash + code_comment/task_done/file_read_diff)
- agents/ocr-reviewer.md: reviewer subagent，tools=[Read,Glob,Grep,Bash]
  硬约束：不能 Edit/Write，只能通过 code_comment Bash 提交评论
- commands/review.md: 5 步编排 (prepare → plan → dispatch → aggregate → present)
  + 错误码处理表
- src/host/opencode/README.md: P1+ 占位
- 删除旧 skills/code-review/SKILL.md (被 ocr-review-file 取代)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 14: 集成冒烟脚本 + 验证 dry-run 全链路

**Files:**
- Create: `scripts/smoke.sh`
- Modify: `package.json`（增 `smoke` 脚本）

**Interfaces:**
- Consumes: T1-T13 全部产物
- Produces: 一个独立可重入的 shell 脚本，在临时目录创建 git repo + 已知 diff + 跑 `ocr-prepare` + 模拟 subagent (手工调 code_comment + task_done) + 跑 `ocr-aggregate`，验证最终 report.md / report.json 形态。

- [ ] **Step 1: 写 scripts/smoke.sh**

Create:
```bash
#!/usr/bin/env bash
# scripts/smoke.sh — 集成冒烟测试。不依赖 Claude Code，仅验证 bin/ CLI 串联可用。
# 通过：① ocr-prepare 能产出 context.json；② code_comment + task_done 写 jsonl/done；
# ③ ocr-aggregate 渲染 report.md/.json 且 partial=false。

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d -t ocrp-smoke-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

echo "[smoke] plugin root: $PLUGIN_ROOT"
echo "[smoke] tmp repo:    $TMP"

cd "$TMP"
git init -q -b main
git config user.email smoke@test.local
git config user.name "smoke"

cat > a.ts <<'TS'
export function hello() {
  return "world";
}
TS
git add a.ts
git commit -q -m "init"

# 产生一个 modified diff
cat > a.ts <<'TS'
export function hello() {
  return "WORLD";
}
TS

# 跑 prepare
SUMMARY="$("$PLUGIN_ROOT/bin/ocr-prepare" workspace)"
echo "[smoke] prepare summary: $SUMMARY"
RUNID="$(echo "$SUMMARY" | grep -o '"runId":"[^"]*"' | head -1 | cut -d'"' -f4)"
if [ -z "$RUNID" ]; then
  echo "[smoke] FAIL: no runId in prepare output"
  exit 1
fi
if [ ! -f ".ocr-runs/$RUNID/context.json" ]; then
  echo "[smoke] FAIL: context.json missing"
  exit 1
fi

# 模拟 reviewer subagent 行为
"$PLUGIN_ROOT/bin/code_comment" --runId "$RUNID" --path a.ts --start 2 --end 2 --content "Magic string" --subagent reviewer-a >/dev/null
"$PLUGIN_ROOT/bin/task_done" --runId "$RUNID" --subagent reviewer-a --file a.ts >/dev/null

# 跑 aggregate
AGG="$("$PLUGIN_ROOT/bin/ocr-aggregate" --runId "$RUNID")"
echo "[smoke] aggregate: $AGG"

if [ ! -f ".ocr-runs/$RUNID/report.md" ]; then
  echo "[smoke] FAIL: report.md missing"
  exit 1
fi
if [ ! -f ".ocr-runs/$RUNID/report.json" ]; then
  echo "[smoke] FAIL: report.json missing"
  exit 1
fi

grep -q "Magic string" ".ocr-runs/$RUNID/report.md" || { echo "[smoke] FAIL: comment not in report.md"; exit 1; }
grep -q '"status": "ok"' ".ocr-runs/$RUNID/report.json" || { echo "[smoke] FAIL: report.json status != ok"; exit 1; }

# rules_check 冒烟
RC="$("$PLUGIN_ROOT/bin/ocr-rules-check" a.ts)"
echo "[smoke] rules-check: $RC"
echo "$RC" | grep -q '"docPath": "ts_js_tsx_jsx.md"' || { echo "[smoke] FAIL: rules-check docPath"; exit 1; }

echo "[smoke] PASS"
```

- [ ] **Step 2: 让脚本可执行**

Run:
```bash
chmod +x /Users/lixiangyang/Desktop/代码/open-code-review-plugin/scripts/smoke.sh
```

- [ ] **Step 3: 修改 package.json 增加 smoke 脚本**

修改 `package.json` `scripts`:
```json
{
  "scripts": {
    "smoke": "bash scripts/smoke.sh"
  }
}
```

（保留其他 scripts 不变。）

- [ ] **Step 4: 跑冒烟**

Run:
```bash
cd /Users/lixiangyang/Desktop/代码/open-code-review-plugin
npm run build
npm run smoke
```

Expected: 最后输出 `[smoke] PASS`，退出码 0。

- [ ] **Step 5: 跑全套单元测试**

Run:
```bash
npm test 2>&1 | tail -30
```

Expected: 所有测试通过（约 35+ 个测试通过）。

- [ ] **Step 6: 提交**

```bash
git add scripts/smoke.sh package.json
git commit -m "test: 集成冒烟脚本 scripts/smoke.sh

- 临时 git repo + modified diff → prepare → code_comment + task_done → aggregate
- 验证 context.json / comments.jsonl / done/ / report.md / report.json 形态
- 验证 ocr-rules-check 命中 ts_js_tsx_jsx.md
- npm run smoke 端到端约 < 5 秒

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 15: README + LICENSE + 最终验证清单

**Files:**
- Create: `README.md`
- Create: `LICENSE`（Apache-2.0，与 OCR 一致）
- Modify: `package.json` `files` 字段加入 `agents`、`hooks`、`bin`、`assets`

**Interfaces:**
- Consumes: 所有前置产物
- Produces: 用户可读的安装与使用文档；spec §12 的合并检查清单全部勾选

- [ ] **Step 1: 写 README.md（9 章对齐 OCR 风格）**

Create:
````markdown
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

| Flag | Equivalent OCR flag | Default |
|---|---|---|
| `-b, --background "ctx"` | same | "" |
| `--paths "g1,g2"` | `--include` | — |
| `--rules <path>` | `--rule` | (built-in) |
| `--concurrency <n>` | same | 8 |
| `--format markdown|json|both` | `--format` | both |
| `--dry-run` | — | false |

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
| `OCRP-RUN-011` | Argument conflict | Use only one of --staged / --commit / range |
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
````

- [ ] **Step 2: 写 LICENSE (Apache-2.0)**

Run:
```bash
curl -sL https://www.apache.org/licenses/LICENSE-2.0.txt > /Users/lixiangyang/Desktop/代码/open-code-review-plugin/LICENSE 2>&1 || cp /Users/lixiangyang/Desktop/代码/open-code-review/LICENSE /Users/lixiangyang/Desktop/代码/open-code-review-plugin/LICENSE
```

Expected: 文件存在；前几行含 `Apache License, Version 2.0`。

- [ ] **Step 3: 修改 package.json `files` 字段**

修改 `package.json` 的 `files` 字段（保留其他不变）：

```json
{
  "files": [
    ".claude-plugin",
    "commands",
    "agents",
    "skills",
    "hooks",
    "bin",
    "assets",
    "dist",
    "README.md",
    "LICENSE"
  ]
}
```

- [ ] **Step 4: 跑完整验收**

Run:
```bash
cd /Users/lixiangyang/Desktop/代码/open-code-review-plugin
npm run typecheck && npm test && npm run build && npm run smoke
```

Expected: 四个步骤全部退出 0。最后输出 `[smoke] PASS`。

- [ ] **Step 5: 验收清单逐项检查（spec §12）**

依次确认：

- [ ] 全部目录与文件按 spec §2 创建 — `tree -L 2 -I 'node_modules|dist|.git|.ocr-runs|.superpowers' .`
- [ ] `.claude-plugin/plugin.json` 字段完整且无 `apiKey/provider/model/baseUrl` — `cat .claude-plugin/plugin.json`
- [ ] PLAN_TASK / MAIN_TASK prompt 与 OCR 文字一致（除工具说明 6 行）— `diff <(cat skills/ocr-review-file/SKILL.md | grep -A 200 "## Role" | head -50) <(grep -A 50 '"MAIN_TASK"' /Users/lixiangyang/Desktop/代码/open-code-review/internal/config/template/task_template.json)` （部分对照即可，无需完全字符级一致——重点是 system prompt 主体文字未被改写）
- [ ] `LlmComment` 字段与 OCR 完全对齐 — 查 `src/core/model/comment.ts`：path / start_line / end_line / content / suggestion_code? / existing_code? / thinking?
- [ ] `bin/*` 文件存在执行位 — `ls -la bin/`
- [ ] `npm run build` 一次成功 — 已验证
- [ ] `npm test` 全部通过 — 已验证
- [ ] `npm run smoke` 在临时 repo 上通过 — 已验证
- [ ] 本地 `claude --plugin-dir ./` 可见 `/open-code-review:review` — 手工验证（要求本地 Claude Code 已安装）
- [ ] 在本 repo 上对 HEAD~1 跑通真机端到端 — 手工验证
- [ ] README 9 章齐全 — `grep -c '^## ' README.md` 应 ≥ 9
- [ ] §6.1 错误码全部覆盖至少一条用例 — code 路径检查
- [ ] `.ocr-runs/` 已加入 `.gitignore` — 已验证
- [ ] §11 6 个待解决问题在实施期均有结论 — 在 README 或 CHANGELOG 中记录每个的结论

- [ ] **Step 6: 提交并打第一个 tag**

```bash
git add README.md LICENSE package.json
git commit -m "docs+release: README + LICENSE + package.json files 字段

- README 9 章对齐 OCR 风格 (Why/Quickstart/Commands/Architecture/Comparison/
  Configuration/Troubleshooting/Development/License + naming-conflict 附录)
- LICENSE: Apache-2.0
- package.json files 字段含完整插件资产

完成 P0 全部里程碑。

Co-Authored-By: Claude <noreply@anthropic.com>"

git tag v0.1.0
```

Expected: tag 创建成功。

---

## Self-Review

下面是写完后对 spec 的覆盖核查。

**Spec 覆盖检查（对照 spec §1-§12）：**

- spec §1.1 流程总览 → T8 (prepare) + T11 (hook) + T12 (aggregate) + T13 (command 编排) 覆盖 7 步
- spec §1.2 OCR 对齐表 → T4/T5/T6 复用 OCR 资产；T7 移植 prompt；T9 三个 bin/ 对齐 OCR 工具名
- spec §2 目录布局 → T1 (.claude-plugin) + T2 (src/core 框架) + 后续逐 task 填充
- spec §2.1 设计点 ①TS→bin 同步 → T10；②commands/skills 分工 → T13；③subagent 工具锁定 → T13 agents/；④hooks 双总线 → T11
- spec §2.2 UX 对齐 → T1 (name=open-code-review) + T15 (README 解释冲突)
- spec §3.1-3.5 数据契约 → T2 (model/*) + T3 (runs/store) + T12 (report json schema)
- spec §4 prompt 移植表 → T7 (TS 字符串) + T13 (SKILL.md)；P1 三个 skill 显式排除
- spec §5 时序 24 步 → T13 commands/review.md 实现 5 段编排
- spec §5.1 容错点 5 项 → T13 (并发上限 = 8) + T12 (partial 判定) + T11 (hook 不阻塞) + T13 (PLAN 短路) + T8/T13 (--dry-run 通过 prepare + 跳过分发)
- spec §6 错误码 10 条 → 散布在 T8 (RUN-010/011/012) + T13 (LOAD-002 / SKILL-040 / SUB-050/051) + T11 (HOOK-060)
- spec §7 测试 6 类 → T3/T4/T5/T6/T7/T11/T12 单元 + T14 集成冒烟；真机端到端在 T15 手工 step
- spec §8 构建链 → T1 (基础 scripts) + T4 (copy-assets) + T10 (shebang + bin) + T14 (smoke) + T15 (files)
- spec §8.4 README 9 章 → T15
- spec §9 风险表 7 条 → 在 T2/T5/T11/T13 的代码注释或 task 步骤中显式应对
- spec §10 P0/P1 边界 → 计划范围严格 P0；P1 项不出现在任何 task 中
- spec §11 6 个待解决问题 → T11 step5 注释 (CLAUDE_PLUGIN_ROOT) + T13 commands 注释 (Task 工具并发) + T13 (大 JSON 注入采用方案 A：subagent 通过 Read 读 context.json) + T10 (bin/ 跨 OS 软链/复制 fallback) + T13 (agents tools 限定声明在 frontmatter 中) + T11 (hook stdout 可见性)
- spec §12 验收清单 13 项 → T15 step 5 逐项核对

**未发现遗漏。**

**Placeholder 扫描：** 全文已规避 "TBD" / "TODO" / "fill in" / "similar to" 等模式。

**类型一致性：** `LlmComment` (snake_case), `CommentRecord = LlmComment + _meta`, `PlanOutput / PlanIssue`, `FileChange / Hunk / DiffLine`, `ReviewRequest / ReviewContext` — 从 T2 定义到 T12 消费保持一致；T9 三个 CLI 直接使用 T3 store 的接口，签名匹配；T13 SKILL.md 中使用的 `runId`/`subagent` 占位符与 T7/T11 一致。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-24-opencodereview-plugin.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
