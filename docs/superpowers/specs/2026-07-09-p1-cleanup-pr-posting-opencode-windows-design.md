# open-code-review-plugin · P1 收尾设计文档

> 日期：2026-07-09
> 路径：`docs/superpowers/specs/2026-07-09-p1-cleanup-pr-posting-opencode-windows-design.md`
> 状态：Draft for user review
> 参考源：`../open-code-review`（阿里开源 OCR Go CLI — GitHub/GitLab 行内评论实现参考）

---

## 0. 摘要

在 v0.1.0 P0 基准之上完成三项功能增强 + 一项仓库清理，遵循**串行执行（文档清理 → Windows 修复 → PR Posting → OpenCode adapter）**顺序：

1. **文档清理** — 纳入 4 个未跟踪计划文档；gitignore 运行时/重复工件
2. **Windows 一等支持（代码路径级）** — 路径归一化、`/dev/null` → `NUL`、`.cmd` 测试；不加 Windows CI
3. **PR Posting 行内评论** — GitHub `pulls.createReview` + GitLab Discussions API，各有多级降级
4. **OpenCode HostAdapter 完整适配** — 与 Claude Code 等价体验，差异处明确降级声明

---

## 1. 任务 1：文档清理

### 1.1 纳入版本控制

`git add` 以下 4 个计划文档（方案执行记录，与 `docs/superpowers/plans/` 下已跟踪的 8 个同类型）：

| 文件 |
|---|
| `docs/superpowers/plans/2026-07-02-custom-rules-preview-dry-run.md` |
| `docs/superpowers/plans/2026-07-03-review-stability-custom-rules.md` |
| `docs/superpowers/plans/2026-07-07-ocr-context-tools.md` |
| `docs/superpowers/plans/2026-07-07-review-partial-ref-fix.md` |

### 1.2 Gitignore 追加

在 `.gitignore` 末尾追加 4 行：

```
.claude/worktrees/
codespec/superpowers/
codespec/design.md
codespec/spec.md
```

> `codespec/design.md` 和 `codespec/spec.md` 内容与 `docs/superpowers/specs/` 已有文档高度重叠，不加版本控制；本地文件保留，仅忽略。

---

## 2. 任务 2：Windows 代码路径兼容

### 2.1 路径归一化

在以下入口处统一 `\` → `/`：

| 位置 | 归一化点 |
|---|---|
| `src/core/runs/store.ts` | `safePathKey()` 和 run 路径构建前 |
| `src/core/allowlist/allowed_ext.ts` | glob 匹配入口前（`globToRegExp` 只匹配 `/`） |
| `src/core/diff/git.ts` | 路径传入 `spawn` 前（如有 `\`分隔路径） |

新增 `normalizePath(p: string): string` 工具函数：

```ts
const SLASH_RE = /\\/g;
export function normalizePath(p: string): string {
  return p.replace(SLASH_RE, '/');
}
```

### 2.2 `/dev/null` → `NUL`

| 文件 | 行号 | 变更 |
|---|---|---|
| `src/core/diff/workspace.ts` | L6 | `spawn('git', ['diff', ..., '/dev/null', file])` → 使用 `NULL_PATH` 常量 |
| `src/core/diff/parser.ts` | L122, L126 | diff header 解析同时接受 `/dev/null` 和 `NUL` |

新增常量：

```ts
// src/core/diff/constants.ts
export const NULL_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';
export const NULL_PATH_ALTS = ['/dev/null', 'NUL'];
```

Parser 变更（L122, L126）：

```ts
// 原来：if (line === '--- /dev/null')
// 改为：
if (NULL_PATH_ALTS.some(alt => line === `--- ${alt}`))
// 同理 a-side 判断
```

### 2.3 软链说明

`bin/` 下 symlink 在 Windows 上需要开发者模式或管理员权限。在安装文档中注明这一点，不额外创建非 symlink 方案。

### 2.4 测试

新增 `src/core/diff/__tests__/null_path.test.ts`：

- `NULL_PATH` 在 `process.platform === 'win32'` 时返回 `'NUL'`，否则 `'/dev/null'`
- parser 正确识别 `NUL` 作为 null 源路径

新增 `src/core/__tests__/normalize_path.test.ts`：

- `normalizePath('a\\b\\c')` → `'a/b/c'`
- `normalizePath('a/b/c')` → `'a/b/c'`（幂等）

### 2.5 不做的

- 不新增 Windows CI（不在 GitHub Actions 中加 `windows-latest` runner）
- 不重写 `smoke.sh` 为跨平台
- 不创建 PowerShell smoke 脚本
- 不改变软链安装机制

---

## 3. 任务 3：PR Posting 行内评论

### 3.1 设计原则

复用 `../open-code-review` 的思路，将当前纯 PR 级 `gh pr comment` / GitLab note 替换为**行内 review comment + 多级降级**：

- GitHub：`pulls.createReview`（带 `comments[]` 数组，每条含 `path/line/start_line/side`）
- GitLab：Discussions API（带 `position` 对象，含 `new_path/new_line/base_sha/start_sha/head_sha`）
- 注释质量不变：每批 comment 仍从 `comments.jsonl` 读取现有 `CommentRecord`

### 3.2 GitHub Provider

**步骤：**

1. `gh repo view --json nameWithOwner` → 获得 `owner/repo`
2. `gh pr view <pr> --json headRefOid` → 获得 `headRefOid`
3. 构造 review payload：

```json
{
  "commit_id": "<headRefOid>",
  "event": "COMMENT",
  "comments": [
    {
      "path": "<path>",
      "body": "<content>",
      "line": <end_line>,
      "start_line": <start_line>,
      "side": "RIGHT",
      "start_side": "RIGHT"
    }
  ]
}
```

4. 调用：

```bash
gh api repos/<owner>/<repo>/pulls/<pr>/reviews --method POST --input -
```

**三级降级：**

| 级别 | 操作 | 触发条件 |
|---|---|---|
| 1 | 批量 `createReview`（带全部 comments） | 默认 |
| 2 | 逐条 `createReview`（每条一个 review） | 批量失败 |
| 3 | `gh pr comment`（普通评论，无 diff 行关联） | 逐条失败 |

### 3.3 GitLab Provider

**步骤：**

1. `GET /api/v4/projects/<id>/merge_requests/<iid>/versions` → 获得 `base_sha`、`start_sha`、`head_sha`
2. 对每条评论调用：

```bash
curl --request POST \
  "https://gitlab.com/api/v4/projects/<projectId>/merge_requests/<iid>/discussions" \
  --header "PRIVATE-TOKEN: <token>" \
  --data-urlencode "body=<content>" \
  --data-urlencode "position[position_type]=text" \
  --data-urlencode "position[new_path]=<path>" \
  --data-urlencode "position[old_path]=<path>" \
  --data-urlencode "position[new_line]=<end_line>" \
  --data-urlencode "position[base_sha]=<base_sha>" \
  --data-urlencode "position[start_sha]=<start_sha>" \
  --data-urlencode "position[head_sha]=<head_sha>"
```

**两级降级：**

| 级别 | 操作 | 触发条件 |
|---|---|---|
| 1 | 行内 discussion | 默认 |
| 2 | `POST /notes` 普通 MR note | 行内 discussion 失败 |

### 3.4 新增 CLI 标志

| 标志 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `--pr <number>` | string | — | PR/MR 编号（必填，保持现有一致） |
| `--provider <github\|gitlab>` | string | `github` | 平台选择 |
| `--dry-run` | flag | false | 生成评论 JSON 但不调用 API，输出到 stdout |
| `--retry <n>` | number | 1 | 单条评论失败重试次数 |

### 3.5 文件变更

| 操作 | 文件 |
|---|---|
| 重写 | `src/cli/post_comments.ts` |
| 新增 | `src/cli/github_post.ts` — GitHub 行内 review 逻辑 |
| 新增 | `src/cli/gitlab_post.ts` — GitLab 行内 discussion 逻辑 |
| 新增 | `src/cli/__tests__/github_post.test.ts` |
| 新增 | `src/cli/__tests__/gitlab_post.test.ts` |
| 更新 | `src/cli/__tests__/post_comments.test.ts` |

### 3.6 `commands/review.md` Step 6 更新

原 Step 6 无行内评论能力说明。更新为：

```md
### Step 6 — Post to PR (optional)

If the user requests posting review comments to a PR, run:

```bash
ocr-post-comments --runId <runId> --provider <github|gitlab> --pr <number>
```

Comments are posted as **inline review comments** on the diff (GitHub `pulls.createReview`,
GitLab Discussions API). If inline posting fails, falls back to a regular PR/MR comment.
```

---

## 4. 任务 4：OpenCode HostAdapter 完整适配

### 4.1 目标

让 OpenCode 用户安装后可以用 `/review` 获得与 Claude Code 一致的核心体验。由于 OpenCode v1.15.11 **不支持 subagent 并行**，review 采用顺序单文件模式。差异在文档中明确声明。

### 4.2 OpenCode 环境实测结果（v1.15.11）

| 项目 | Claude Code | OpenCode |
|---|---|---|
| 配置目录 | 项目 `.claude/` | `~/.config/opencode/` |
| 命令机制 | `commands/*.md`（frontmatter）+ `plugin.json` 注册 | `commands/*.md`（frontmatter: `description`, `allowed-tools`） |
| Skills | `skills/<name>/SKILL.md` | 目录内 `SKILL.md`，通过 `~/.config/opencode/` 挂载 |
| Agents | `agents/*.md` | 同样 `agents/*.md` |
| 插件安装 | file-based（`plugin.json` + 目录同步） | npm-based：`opencode plugin <module>` |
| SubAgent 并行 | ✅（Agent 工具 + concurrency） | ❌（不支持并行 dispatch） |
| 工具命名 | PascalCase（Read, Glob, Grep, Bash） | 小写（read, glob, grep, bash） |
| 参数传递 | `$ARGUMENTS` | `$ARGUMENTS`（同样支持） |

### 4.3 文件变更

#### 4.3.1 提取 `HostAdapter` 接口

**操作：** 从 `src/host/claude-code/adapter.ts` 提取到 `src/host/types.ts`

```ts
// src/host/types.ts
export interface HostAdapter {
  name: 'claude-code' | 'opencode';
  agentTools: string[];
}

export interface HostManifest {
  adapter: HostAdapter;
  commandsDir: string;
  skillsDir: string;
  agentsDir: string;
  /** 工具名映射：PascalCase ↔ 小写 */
  toolNameMap: Record<string, string>;
}
```

#### 4.3.2 更新 `src/host/claude-code/adapter.ts`

导入 `HostAdapter`，从 `../types.js` 而不是本地定义：

```ts
import type { HostAdapter } from '../types.js';

export const claudeCodeAdapter: HostAdapter = {
  name: 'claude-code',
  agentTools: ['Read', 'Glob', 'Grep', 'Bash'],
};
```

#### 4.3.3 补齐 `src/host/opencode/adapter.ts`

```ts
import type { HostAdapter } from '../types.js';

export const opencodeAdapter: HostAdapter = {
  name: 'opencode',
  agentTools: ['read', 'glob', 'grep', 'bash'],
};
```

#### 4.3.4 新建 `commands/review-opencode.md`

与 Claude Code `commands/review.md` 的关键差异：

| 步骤 | Claude Code | OpenCode |
|---|---|---|
| Step 2 plan | ocr-plan skill | 相同 |
| Step 3 dispatch | 并行 dispatch `reviewConcurrency` 个 reviewer | **顺序 `for file in files`** 逐个 review |
| Step 3.5 filter | per-file filter skill, 并行 | per-file filter, 顺序 |
| Step 3.6 relocate | per-file, 无差异 | 相同 |
| 工具调用语法 | `Read`/`Bash`/etc. | `read`/`bash`/etc. |

Step 3 在 OpenCode 上的核心差异伪代码：

```
// OpenCode: 单 agent 顺序遍历
for file in context.files:
  if file.skipped: continue
  1. 读取 diff
  2. 在当前上下文应用 ocr-review-file skill
  3. 执行 filter（如有 comments）
  4. 执行 relocate

// Claude Code: 并行批次 dispatch
for batch in batches(context.files, reviewConcurrency):
  parallel dispatch ocr-reviewer subagent per file
```

OpenCode Review Command frontmatter：

```yaml
---
description: |
  Run the open-code-review-plugin code review on a git change set.
  Pass-through flags align with alibaba/open-code-review CLI.
argument-hint: "[workspace|staged|<sha>|<from>..<to>] [--background \"...\"]"
allowed-tools: read, glob, grep, bash, write
---
```

#### 4.3.5 更新 `scripts/install-opencode.sh`

安装目标改为 `~/.config/opencode/`（符合实际 OpenCode 配置目录）：

```bash
#!/bin/bash
set -euo pipefail
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPN_DIR="${HOME}/.config/opencode"

echo "[install-opencode] installing to ${OPN_DIR}"

# 命令（以 /review 为入口）
mkdir -p "${OPN_DIR}/commands"
cp "${PLUGIN_DIR}/commands/review-opencode.md" "${OPN_DIR}/commands/review.md"

# Skills（保持子目录结构）
mkdir -p "${OPN_DIR}/skills/open-code-review"
cp "${PLUGIN_DIR}/skills/ocr-plan/SKILL.md"       "${OPN_DIR}/skills/open-code-review/ocr-plan.md"
cp "${PLUGIN_DIR}/skills/ocr-relocate/SKILL.md"    "${OPN_DIR}/skills/open-code-review/ocr-relocate.md"
cp "${PLUGIN_DIR}/skills/ocr-review-file/SKILL.md" "${OPN_DIR}/skills/open-code-review/ocr-review-file.md"
cp "${PLUGIN_DIR}/skills/ocr-review-filter/SKILL.md" "${OPN_DIR}/skills/open-code-review/ocr-review-filter.md"

# Agent（reviewer 专用）
mkdir -p "${OPN_DIR}/agents"
cp "${PLUGIN_DIR}/agents/ocr-reviewer-opencode.md" "${OPN_DIR}/agents/ocr-reviewer.md"

echo "[install-opencode] done"
echo "  commands: ${OPN_DIR}/commands/review.md"
echo "  skills:   ${OPN_DIR}/skills/open-code-review/"
echo "  agents:   ${OPN_DIR}/agents/ocr-reviewer.md"
```

#### 4.3.6 更新 `src/host/opencode/README.md`

替换现有 P1 占位说明为实际完成说明：

```md
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

## Tool name convention

OpenCode uses **lowercase** tool names in frontmatter (`allowed-tools`). The
adapter exports this mapping automatically.
```

### 4.4 测试

| 测试文件 | 内容 |
|---|---|
| `src/host/__tests__/types.test.ts` | `HostAdapter`/`HostManifest` 类型结构验证 |
| `src/host/__tests__/opencode_adapter.test.ts` | `opencodeAdapter.name`、`agentTools` 值正确 |
| `scripts/__tests__/install.test.ts` | install 脚本输出路径、文件存在性验证 |

**集成测试：** 跑 `scripts/install-opencode.sh` 后，在插件仓库根目录执行 `opencode run "/review --staged"` 观察 `ocr-prepare`、`ocr-aggregate` 等 CLI 是否正常工作。

---

## 5. 能力差异总览

### 5.1 OpenCode vs Claude Code

| 能力 | Claude Code | OpenCode | 备注 |
|---|---|---|---|
| `/review` 命令 | ✅ | ✅ | 单独命令文件，顺序遍历 |
| SubAgent 并行 | ✅ | ❌ | OpenCode 单 agent，多文件耗时长 |
| 事件总线 (events.jsonl) | ✅ | ❌ | 无 PostToolUse hook 等价物 |
| Skills（plan/relocate/filter） | ✅ | ✅ | CLI 共用，无差异 |
| Custom rules | ✅ | ✅ | 同上 |
| Preview / dry-run | ✅ | ✅ | 同上 |
| line relocation | ✅ | ✅ | 同上 |

### 5.2 PR Posting vs 当前

| 能力 | 当前 (`gh pr comment`) | 本次实现 |
|---|---|---|
| GitHub 行内评论 | ❌ | ✅ `pulls.createReview` |
| GitLab 行内 discussion | ❌ | ✅ Discussions API |
| 降级到普通 PR/MR comment | ✅（直接就是普通评论） | ✅（行内失败后降级） |
| dry-run | ❌ | ✅ `--dry-run` |
| 重试 | ❌ | ✅ `--retry` |

---

## 6. 实现顺序与里程碑

```
M1: 文档清理 → commit
M2: Windows 修复 → commit
M3: PR Posting → commit
M4: OpenCode adapter → commit
```

每个 milestone 独立提交，commit message 按现有约定（`feat(...)` / `chore(...)` / `docs(...)`）。
