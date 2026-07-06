# open-code-review-plugin · P1 Backlog 综合设计

> 日期：2026-07-07
> 状态：Final design, covering remaining P1 backlog items
> 范围：retry/resume、large diff guard、opencode HostAdapter、Windows 支持、GitHub/GitLab inline comment 发布

---

## 0. 摘要

一次性覆盖原始 P1 清单中剩余 5 项（MEMORY_COMPRESSION 除外，它依赖宿主上下文压缩，继续搁置）。设计保持最小可行，每项都复用现有架构。

---

## 1. retry/resume previous run

### 1.1 设计要点

**`ocr-prepare --resume <runId>`**
- 读取现有 `context.json`
- 列出已有 `done/*.json` 的文件
- 输出只有未完成文件的新 context（`files[]` 只含未完成文件，`changeFiles` 只含未完成文件路径）
- stdout summary 增加 `resumed: true` 和 `remainingFileCount`
- 如果所有文件已完成 → `fileCount: 0`, 退出 0，提示 "All files already reviewed."

**`commands/review.md` Step 1 增加 resume 检测**
- 如果 summary `resumed == true` → 从 Step 2/3 继续（跳过已完成的文件）
- 正常走 plan→reviewer→filter→relocate→aggregate 流程
- aggregate 仍然对比 done/ 标记，但 resume 时 partialFiles 不包括已经 done 的文件

### 1.2 接口变化

```ts
// ReviewRequest 增加
resume?: boolean;
resumeRunId?: string;

// ocr-prepare stdout 增加
resumed: boolean;
remainingFileCount: number;
```

### 1.3 测试

- `parseArgs(['--resume', '<runId>'])` → `resumeRunId = '<runId>'`
- `ocr-prepare --resume <validRunId>` → 只输出未完成文件
- `ocr-prepare --resume <allDoneRunId>` → `fileCount: 0`, exit 0
- `ocr-prepare --resume <missingRunId>` → 报错

---

## 2. large diff token guard

### 2.1 设计要点

**`ReviewRequest.maxFileChangedLines`**
- 每个文件 changed lines 超过阈值时标记 `FileChange.skipped = true` 和 `skipReason`
- prepare 阶段计算但不阻止进入 review
- preview 模式下在 files 表中显示 `skipped (N lines > threshold)`
- reviewer dispatch 跳过 `skipped === true` 的文件
- aggregate 在 partialFiles 中列出 skipped 文件并标注原因

### 2.2 接口变化

```ts
// FileChange 增加
skipped?: boolean;
skipReason?: string;
skippedLines?: number;

// ReviewRequest 增加
maxFileChangedLines?: number;

// constants.ts 增加
export const MAX_FILE_CHANGED_LINES = 2000;
```

### 2.3 测试

- `buildReviewContext` 不跳过低于阈值的文件
- `buildReviewContext` 对超过阈值的文件设置 `skipped = true`
- preview 输出显示 skipped 文件

---

## 3. opencode HostAdapter

### 3.1 设计要点

不重构整个插件为多 host（风险太大），而是**增加一个 opencode 兼容的 agent 定义文件**和最小适配脚本：

**`agents/ocr-reviewer-opencode.md`**
- 与 `agents/ocr-reviewer.md` 相同，但工具列表适配 opencode 命名
- tools: `[read, glob, grep, bash]`（opencode 的小写工具名）

**`src/host/opencode/adapter.ts`**（纯文档 + 类型定义）
- 定义 `HostAdapter` 接口：
  ```ts
  interface HostAdapter {
    name: 'claude-code' | 'opencode';
    agentTools: string[];
    isWorktreeEnv(): boolean;
    getCwdForRun(runId: string): string;
  }
  ```
- 实现在 `src/host/claude-code/adapter.ts`（提取现有逻辑）
- opencode 实现为 stub，返回合适的默认值

**`scripts/install-opencode.sh`**
- 创建 opencode 需要的符号链接
- 复制 agent/skill/command 到 opencode 期望的路径

### 3.2 非目标

- 不单独为 opencode 重写 hook_handler
- 不修改现有 Claude Code 插件的 plugin.json
- opencode 的 reviewer subagent 复用同一套 `bin/*` CLI

### 3.3 测试

- `HostAdapter` 类型定义正确导出
- Claude Code adapter 返回正确值
- opencode adapter stub 不崩溃

---

## 4. Windows 一等承诺

### 4.1 设计要点

**`bin/*.cmd` 包装**
- 每个 `bin/<tool>` 生成对应的 `<tool>.cmd`:
  ```cmd
  @echo off
  node "%~dp0..\dist\cli\<tool>.mjs" %*
  ```

**`scripts/shebang.mjs` 增加**
- 在 POSIX 平台上：继续当前 shebang + chmod 行为
- 在 Windows 上：跳过 shebang，生成 `.cmd` 包装

**路径归一化**
- `src/core/diff/git.ts`: Windows `git diff` 输出 `/` 路径，无需改动
- `src/core/runs/store.ts`: `join` 已经跨平台
- `src/core/allowlist/allowed_ext.ts`: `globToRegExp` 只匹配 `/`，统一在入口 convert `\` → `/`

**`package.json` 增加 CI 脚本**
```json
"test:win": "node --import tsx --test src/**/__tests__/*.test.ts"
```

### 4.2 测试

- `scripts/shebang.mjs` 在 mock Windows 环境生成 `.cmd`
- 所有 `node:path` 使用不需要 mock（已经跨平台）
- `.cmd` 文件存在于 `bin/` 目录

---

## 5. GitHub/GitLab inline comment API

### 5.1 设计要点

**`bin/ocr-post-comments` CLI**
- 读取 `comments.jsonl`
- 读取 `context.json`（获取 range 信息）
- 调用 `gh pr comment` 或 GitLab API 发布 inline comments
- 支持 `--provider github|gitlab` 和 `--pr <number>`

**`ReviewRequest` 增加**
```ts
postToPR?: boolean;
prNumber?: number;
prProvider?: 'github' | 'gitlab';
```

**`commands/review.md` Step 5 后增加可选步骤**

### 5.2 接口

```bash
ocr-post-comments --runId <runId> --provider github --pr <number>
```

stdout JSON:
```json
{ "posted": 5, "failed": 0, "skipped": 0 }
```

### 5.3 实现策略

- 优先级：`gh pr comment` 优先（零额外依赖）
- GitLab API：直接用 `curl` + `$GITLAB_TOKEN` 环境变量
- 每条 comment 对应一个 diff hunk 的行号，带 suggestion code 块

### 5.4 测试

- `ocr-post-comments --help` 输出 usage
- 空 comments.jsonl 时输出 `posted: 0`
- mock `gh` 命令测试参数拼装

---

## 6. 文件改动边界

| 文件 | 改动 |
|---|---|
| `src/cli/prepare.ts` | `--resume <runId>` 解析和 resume 逻辑 |
| `src/core/context/review_context.ts` | resume 时读已有 context，筛除已完成文件；large diff 跳过逻辑 |
| `src/core/model/request.ts` | 增加 `resumeRunId`, `maxFileChangedLines`, `postToPR`, `prNumber`, `prProvider` 等字段 |
| `src/core/prompts/constants.ts` | `MAX_FILE_CHANGED_LINES` 常量 |
| `src/core/runs/store.ts` | `listDone` 已存在，resume 直接复用 |
| `src/cli/post_comments.ts` | 新增 CLI |
| `bin/ocr-post-comments` | 新增 bin 入口 |
| `src/host/claude-code/adapter.ts` | 提取并实现 HostAdapter |
| `src/host/opencode/adapter.ts` | opencode stub |
| `agents/ocr-reviewer-opencode.md` | 新增 opencode agent 定义 |
| `scripts/shebang.mjs` | Windows `.cmd` 生成 |
| `scripts/install-opencode.sh` | 新增 |
| `commands/review.md` | resume 流、skipped 文件跳过、post 步骤 |
| `README.md` | 5 项新能力文档 |
| 各 `__tests__/` | 分别增加对应测试 |

---

## 7. 不支持 / 不做

- MEMORY_COMPRESSION（待宿主自身压缩机制成熟后再评估）
- opencode 完整 hook_handler 实现（仅做 agent 定义 + stub adapter）
- Windows CI 流水线（仅做 `.cmd` 生成 + 路径归一化）
- GitLab API 完整 OAuth 流（仅做 `$GITLAB_TOKEN` 环境变量方式）
- marketplace 上架
