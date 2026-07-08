# open-code-review-plugin · 设计文档

> 日期：2026-06-24
> 路径：`/Users/lixiangyang/Desktop/代码/open-code-review-plugin/docs/superpowers/specs/2026-06-24-opencodereview-plugin-design.md`
> 状态：Draft for user review
> 参考源：`/Users/lixiangyang/Desktop/代码/open-code-review`（阿里开源 OCR Go CLI）
> 参考文档：https://code.claude.com/docs/zh-CN/plugins

---

## 0. 摘要

把 [alibaba/open-code-review](https://github.com/alibaba/open-code-review)（下称 **OCR**）的代码审查能力以 **Claude Code 插件** 形态重新交付：

- **不再** 自带 LLM Provider / API Key / 独立 CLI 二进制；
- **借用宿主 Claude Code 自身的 agent loop**（主会话 + reviewer subagent），**不开** Claude Agent SDK 子进程；
- TypeScript 单一源码 → `dist/*.mjs` + `bin/*` 可执行入口；
- 编排骨架（`commands/review.md`）+ Prompt 工程（`skills/*/SKILL.md`）+ 工具 CLI（`bin/`）+ 事件 hook（`hooks/hooks.json`）四件套；
- 保持与 OCR 的 **数据契约、prompt 模板、报告结构** 逐项对齐，便于未来回流；
- 顶层 `src/host/` 留 opencode 占位（P1+）。

---

## 1. 总体架构

### 1.1 流程总览

```
                    ┌──────────────────────────────────────────────┐
                    │  Claude Code（宿主主会话）                     │
                    │                                              │
   /review HEAD~3   │   ┌─ /review command.md ─────────────────┐  │
   ─────────────▶   │   │  1. Bash → bin/ocr-prepare $ARGS     │  │
                    │   │     输出 runId + ReviewContext.json   │  │
                    │   │  2. 读 ReviewContext.json             │  │
                    │   │  3. PLAN 阶段（主会话 inline）        │  │
                    │   │  4. 按文件 dispatch reviewer subagent │  │
                    │   │  5. 等所有 subagent 返回              │  │
                    │   │  6. Bash → bin/ocr-aggregate         │  │
                    │   │     合并 jsonl + 渲染 report.md       │  │
                    │   │  7. 把 report.md 内容贴回 chat        │  │
                    │   └──────────────────────────────────────┘  │
                    │                    │                         │
                    │       并行 ▼      ▼      ▼                  │
                    │   ┌────────┐ ┌────────┐ ┌────────┐          │
                    │   │reviewer│ │reviewer│ │reviewer│ subagent │
                    │   │ a.ts   │ │ b.ts   │ │ c.ts   │          │
                    │   └───┬────┘ └───┬────┘ └───┬────┘          │
                    │       │ Bash 调 bin/code_comment / task_done│
                    │       ▼                                       │
                    │   ┌──────────────────────────────────────┐  │
                    │   │ hooks.json: PostToolUse(Bash)        │  │
                    │   │   → 实时进度回写主会话               │  │
                    │   │ 子进程同时 append jsonl 落盘         │  │
                    │   └──────────────────────────────────────┘  │
                    └──────────────────────────────────────────────┘
                                       │
                                       ▼
        .ocr-runs/<runId>/  comments.jsonl, events.jsonl, plan.json, report.md/.json
```

### 1.2 与 OCR 原版的概念对齐表

| OCR 原版 | 本插件对应 | 说明 |
|---|---|---|
| `cmd/opencodereview/review_cmd.go` | `commands/review.md` | 入口从 Go CLI 变 slash command，编排骨架一致 |
| `internal/agent/agent.go` 主 loop | 主会话 + reviewer subagent | 不再自写 loop，借宿主 loop |
| `MAIN_TASK` system prompt | reviewer subagent system prompt | **逐字移植**，仅工具说明替换 |
| `PLAN_TASK` system prompt | 主会话 PLAN skill prompt | **逐字移植** |
| `internal/tool/code_comment.go` | `bin/code_comment` | 同名 CLI，参数对齐 |
| `internal/tool/task_done.go` | `bin/task_done` | 同名 CLI |
| `internal/tool/file_read_diff.go` | `bin/file_read_diff` | 同名 CLI |
| `file_read` / `file_find` / `code_search` | 直接用 `Read`/`Glob`/`Grep` | prompt 里说明映射 |
| `internal/diff/*` | `src/core/diff/` | 算法逐行复刻 |
| `system_rules.{go,json}` + `rule_docs/*.md` | `src/core/rules/` + `assets/rule_docs/` | rule_docs 直接复制，不重写 |
| allowlist 两份 json | `src/core/allowlist/` | 直接内嵌 |
| `output.go` text/json 渲染 | `src/core/report/markdown.ts` + `json.ts` | Markdown 为主，OCR JSON 备选 |
| OCR plugin 的 `/review` | 同名 `/review` → `/open-code-review:review` | **用户层 UX 与 OCR plugin 完全一致** |
| `RE_LOCATION_TASK` / `REVIEW_FILTER_TASK` / `MEMORY_COMPRESSION_TASK` | — | P1 增量 |

---

## 2. 目录布局

```
open-code-review-plugin/
├── .claude-plugin/
│   └── plugin.json                     # name: open-code-review, version: 0.1.0
├── commands/
│   └── review.md                       # /review 编排骨架（不含 prompt 逻辑）
├── agents/
│   └── ocr-reviewer.md                 # reviewer subagent（tools: Read/Glob/Grep/Bash）
├── skills/
│   ├── ocr-plan/SKILL.md               # PLAN_TASK（主会话 inline）
│   └── ocr-review-file/SKILL.md        # MAIN_TASK（reviewer subagent 引用）
├── hooks/
│   └── hooks.json                      # PostToolUse: Bash → hook_handler.mjs
├── bin/                                # 构建后由 scripts/shebang.mjs 写入
│   ├── ocr-prepare                       # 解析 $ARGS + git diff + 规则匹配 → ReviewContext.json
│   ├── code_comment                      # subagent 提交单条评论
│   ├── task_done                         # subagent 声明完成
│   ├── file_read_diff                    # 读另一变更文件的 diff
│   ├── ocr-aggregate                     # 合并 jsonl + 渲染 report.md
│   └── ocr-rules-check                   # 复刻 OCR `ocr rules check`
├── src/
│   ├── core/
│   │   ├── diff/                         # 移植 internal/diff/（parser/hunk/git/workspace）
│   │   ├── rules/                        # 移植 internal/config/rules/（含 system_rules.json）
│   │   ├── allowlist/                    # 移植 internal/config/allowlist/
│   │   ├── context/review_context.ts     # 构造 ReviewContext
│   │   ├── prompts/                      # main_task.ts / plan_task.ts / render.ts
│   │   ├── report/markdown.ts + json.ts  # OCR 兼容渲染
│   │   ├── runs/store.ts                 # .ocr-runs/<runId>/ 路径与 jsonl 读写
│   │   ├── model/                        # LlmComment / PlanOutput / ReviewRequest / ReviewContext
│   │   └── types.ts
│   ├── cli/                              # 每个 bin/* 一个入口
│   │   ├── prepare.ts
│   │   ├── code_comment.ts
│   │   ├── task_done.ts
│   │   ├── file_read_diff.ts
│   │   ├── aggregate.ts
│   │   └── rules_check.ts
│   └── host/
│       ├── claude-code/
│       │   └── hook_handler.ts           # PostToolUse hook 实际逻辑
│       └── opencode/README.md            # P1+ 占位
├── assets/
│   └── rule_docs/                        # 直接复制 OCR 16 个 .md（不重写）
├── scripts/
│   ├── build-mjs.mjs                     # 沿用
│   └── shebang.mjs                       # 给 dist/cli/*.mjs 加 #!/usr/bin/env node + chmod +x + 同步到 bin/
├── dist/                                 # 构建产物（core/cli/host）
├── package.json
├── tsconfig.json
├── README.md
└── .ocr-runs/                            # 运行时数据（.gitignore）
```

### 2.1 关键设计点

**① TS 单一源 ↔ `bin/` 同步机制**
所有可执行逻辑写在 `src/cli/*.ts` → tsc → `dist/cli/*.mjs`。构建末尾 `scripts/shebang.mjs` 给每个 mjs 加 `#!/usr/bin/env node`、`chmod +x`，并在 `bin/` 下创建同名软链（失败时回退为复制）。Claude Code 启用插件时会把 `bin/` 加进 Bash 的 PATH，subagent 直接调 `code_comment …`。

**② `commands/review.md` 只编排，`skills/*` 只装 prompt**
`review.md` 是 7 步编排骨架；PLAN_TASK / MAIN_TASK 的 system+user prompt 分别写在 `skills/ocr-plan/SKILL.md` 与 `skills/ocr-review-file/SKILL.md`。调 prompt 不动 ts；调编排不动 prompt。

**③ `agents/ocr-reviewer.md` 锁工具集**
frontmatter `tools: [Read, Glob, Grep, Bash]`。system prompt 中声明 Bash 只允许调 `code_comment` / `task_done` / `file_read_diff` 三个命令。其余文件读取 → Read，找文件 → Glob，搜代码 → Grep（直接对齐 OCR 工具语义）。

**④ `hooks.json` 拦截 Bash 实现"实时事件总线"**
挂一个 `PostToolUse`，matcher = `Bash`，命令拉起 `dist/host/claude-code/hook_handler.mjs`。handler 解析 Bash 的 tool_input，若命令前缀是三个 OCR 工具之一：
1. 写一行到 `.ocr-runs/<runId>/events.jsonl`（持久化总线）
2. 通过 stdout 给主会话写一行可读的"💬 reviewer-a 在 src/foo.ts:42 提交了一条评论"（事件总线）

### 2.2 与 OCR plugin 的 UX 对齐

- `plugin.json` 的 `name` 沿用 **`open-code-review`**，命名空间路径 `/open-code-review:review` 与 OCR plugin 完全一致。当用户已安装 OCR plugin（`alibaba/open-code-review` 的 `plugins/open-code-review/`）时存在同名冲突；本插件 README 在"安装"段显式说明：用户应卸载 OCR plugin 或将本插件目录在 `--plugin-dir` / `~/.claude/plugins/` 中**唯一存在**。在 P1 阶段如有上 marketplace 计划，可改名为 `open-code-review-cc`，但 P0 仍优先 UX 一致。
- 支持的入参语义参照 OCR：`--commit / --from / --to / --paths / --background / --rules / --concurrency / --preview / --timeout / --format`。
- 短名 `/review` 与 OCR plugin 一致。
- 报告 Markdown 模板：High Priority / Medium Priority 分组，与 OCR `skills/open-code-review/SKILL.md` 的模板逐字对齐。

---

## 3. 数据契约

### 3.1 ReviewContext（`bin/ocr-prepare` 输出）

```jsonc
{
  "runId": "20260624-153012-a1b2",
  "repoRoot": "/abs/path",
  "range": "workspace | staged | HEAD~3..HEAD | commit:abc123",
  "background": "...",
  "files": [
    {
      "path": "src/foo.ts",
      "oldPath": null,
      "status": "added | modified | deleted | renamed | binary",
      "diff": "<unified diff，截断到 maxHunkLines>",
      "truncated": false,
      "hunks": [ /* Hunk[] */ ],
      "rulesHit": [{ "ruleId": "...", "message": "...", "docPath": "assets/rule_docs/ts_js_tsx_jsx.md" }]
    }
  ],
  "changeFiles": ["src/foo.ts", "src/bar.ts"],
  "meta": { "generatedAt": "ISO8601", "pluginVersion": "0.1.0" }
}
```

### 3.2 ReviewerInput（主会话给 subagent 的 prompt 注入）

```jsonc
{
  "runId": "...",
  "currentFile": { /* FileChange，即 ReviewContext.files[i] */ },
  "changeFiles": ["src/foo.ts", "src/bar.ts"],
  "background": "...",
  "systemRule": "<从 system_rules + rule_docs 拼出>",
  "planGuidance": "<可空字符串，PLAN 阶段产出经文本化后>",
  "currentSystemDateTime": "ISO8601"
}
```

**`planGuidance` 文本化规则**：`review.md` 编排阶段读 `plan.json`，将 `PlanOutput.issues[]` 按 severity 降序拼成 Markdown 列表，仅保留与 `currentFile.path` 相关或全局性（`tool_guidance` 中提到 `currentFile.path`、或 `description` 含该 path、或 `issues[].file_hint == path`）的条目，注入到 MAIN_TASK 模板的 `{{plan_guidance}}` 占位符。无相关条目时 `planGuidance = ""`。该转换由 `src/core/prompts/plan_guidance.ts` 完成（纯函数，单元可测）。

### 3.3 LlmComment（与 OCR `internal/model/review.go` 字段逐项对齐）

```jsonc
{
  "path": "src/foo.ts",
  "start_line": 42,
  "end_line": 50,
  "content": "...",
  "suggestion_code": null,
  "existing_code": null,
  "thinking": null
}
```

### 3.4 PlanOutput（PLAN_TASK 输出，OCR 原版 JSON）

```jsonc
{
  "change_summary": "...",
  "issues": [
    {
      "severity": "high | medium | low",
      "description": "...",
      "tool_guidance": [
        { "name": "code_search", "reason": "...", "arguments": "..." }
      ]
    }
  ]
}
```

### 3.5 jsonl 总线文件

| 路径 | 写者 | 读者 | schema |
|---|---|---|---|
| `.ocr-runs/<runId>/context.json` | `bin/ocr-prepare` | `review.md`、subagent | ReviewContext |
| `.ocr-runs/<runId>/plan.json` | 主会话 PLAN skill 后 | `review.md` 分发时 | PlanOutput |
| `.ocr-runs/<runId>/comments.jsonl` | `bin/code_comment` | `bin/ocr-aggregate` | LlmComment + `{"_meta": {...}}` |
| `.ocr-runs/<runId>/events.jsonl` | hook_handler | 事后审计/debug | `{"type":"tool_call","tool":"...","args":{...},"ts":...}` |
| `.ocr-runs/<runId>/done/<subagent>.json` | `bin/task_done` | `bin/ocr-aggregate` 完成判定 | `{"subagent":"...","file":"...","ts":...}` |
| `.ocr-runs/<runId>/report.md` | `bin/ocr-aggregate` | 用户 / 主会话 | Markdown |
| `.ocr-runs/<runId>/report.json` | `bin/ocr-aggregate` | CI / OCR 兼容下游 | OCR JSON schema |

---

## 4. Prompt 模板移植清单

| OCR 模板 | 本插件落点 | 占位符 | P0/P1 |
|---|---|---|---|
| `MAIN_TASK` | `skills/ocr-review-file/SKILL.md`（system+user 逐字移植，仅工具说明替换） | `{{change_files}}` `{{current_file_path}}` `{{diff}}` `{{current_system_date_time}}` `{{requirement_background}}` `{{system_rule}}` `{{plan_guidance}}` | **P0** |
| `PLAN_TASK` | `skills/ocr-plan/SKILL.md`（逐字移植） | `{{change_files}}` `{{current_file_path}}` `{{diff}}` `{{current_system_date_time}}` `{{requirement_background}}` `{{system_rule}}` `{{plan_tools}}` | **P0** |
| `REVIEW_FILTER_TASK` | `skills/ocr-review-filter/SKILL.md` | `{{path}}` `{{diff}}` `{{comments}}` | P1 |
| `RE_LOCATION_TASK` | `skills/ocr-relocate/SKILL.md` | `{diff}` `{existing_code}` `{suggestion_content}` | P1 |
| `MEMORY_COMPRESSION_TASK` | —（依赖宿主自身上下文压缩） | — | P1 |

### 4.1 工具说明替换表

| OCR 工具描述（system prompt 中） | 替换后的描述 |
|---|---|
| `code_comment(path, start_line, end_line, content, suggestion_code?, existing_code?)` | **保留语义**。声明 Bash 调用：`code_comment --path … --start 42 --end 50 …` |
| `task_done()` | **保留语义**。"Bash 调用 `task_done`" |
| `file_read_diff(path)` | **保留语义**。"Bash 调用 `file_read_diff --path …`" |
| `file_read(path, [start, end])` | 替换为 **"使用 Read 工具读取文件"** |
| `file_find(pattern)` | 替换为 **"使用 Glob 工具按 pattern 查找文件"** |
| `code_search(query, [path])` | 替换为 **"使用 Grep 工具搜索代码"** |

### 4.2 P0 不变量

- `LlmComment` 字段与 OCR 逐项对齐，`report.json` 通过 OCR JSON schema 验证。
- PLAN_TASK / MAIN_TASK 的 system prompt 文字 **除工具说明 6 行外整段保留**，含 `/no_think` 等所有控制 token。
- Severity 数据层走 OCR 原生三档 `high|medium|low`，仅在 Markdown 渲染时映射为 "High Priority / Medium Priority"（low 默认丢弃，与 OCR plugin SKILL.md 一致）。
- `PLAN_MODE_LINE_THRESHOLD = 50`、`MAX_TOKENS = 58888` 等常量从 OCR `task_template.json` 同步到 `src/core/prompts/constants.ts`。

---

## 5. 关键时序

按 6 条泳道 4 个阶段：

**阶段 1 · 准备（确定性工程，0 个 LLM 调用）**
1. User: `/review HEAD~3 -b "..."`
2. 主会话 Bash → `ocr-prepare`
3. `ocr-prepare`: git diff → 解析 hunk → allowlist 过滤 → 规则匹配
4. 写 `context.json`
5. stdout 返回 `{"runId":"...","fileCount":3}`

**阶段 2 · PLAN（主会话 inline，仅 totalChangedLines > 50 触发）**
6. 主会话判断阈值
7. 调用 `ocr-plan` skill，渲染 PLAN_TASK prompt
8. 宿主模型返回 PlanOutput JSON（fenced block）
9. Bash 写 `plan.json`

**阶段 3 · 并行评审（每个文件一个 reviewer subagent）**
10. 主会话用 Task 工具派发 N 个 reviewer subagent，每个带 ReviewerInput
11. 各 subagent 跑宿主自身 loop：Read/Glob/Grep 收集 context
12. Bash 调 `code_comment --path foo.ts --start 42 …`
13. CLI append 一行到 `comments.jsonl`
14. PostToolUse hook 触发，解析 Bash tool_input
15. hook handler stdout 回显 + 写 `events.jsonl`
16. Bash 调 `task_done`
17. CLI 写 `done/reviewer-a.json`
18. subagent 返回主会话

**阶段 4 · 聚合与输出**
19. 所有 subagent 完成，主会话恢复控制
20. Bash 调 `ocr-aggregate --runId …`
21. 读 comments.jsonl → 去重/排序 → 渲染 Markdown + OCR JSON
22. 写 `report.md` + `report.json`
23. 主会话读 `report.md`，贴回 chat（含本地文件路径以便跳转）
24. 用户看到完整报告

### 5.1 关键并发与容错点

- **并发上限**：OCR 原版默认 `--concurrency 8` 并用 semaphore 控制；本插件在 Claude Code subagent 编排下默认 `2` 以提升稳定性，`ocr-prepare` 输出 effective `concurrency`，`review.md` 按该值分批。遇到 API 503、timeout 或 partial 文件较多时，建议用 `--concurrency 1` 重跑；用户显式设置高并发时仍最高 capped 到 `8`。
- **subagent 死掉/未完成**：每个 subagent 必须在结束前调一次 `task_done` → 写入 `done/<subagent>.json`。aggregate 阶段比对 `done/` 文件数与派发数；缺少的视为未完成，对该文件标 `partial: true` 并在 Markdown 顶部加 ⚠️ 警告（对应 OCR 的 `AgentWarning`）。注意：本插件不主动计时杀 subagent，"未完成"靠 `done/` 缺失推断而非时钟。
- **hook 失败不阻塞**：实时回显是"事件总线"，挂掉只丢进度提示，持久化总线（jsonl）由 bin/ CLI 子进程同步写入完成。最终聚合**只依赖 jsonl**，不依赖 hook 是否成功 → 双总线 = 鲁棒。
- **PLAN 短路**：当 `totalChangedLines ≤ 50` 时跳过阶段 2，直接进入阶段 3，`ReviewerInput.planGuidance` 留空字符串。
- **`--dry-run`**：跳过阶段 2 + 3，`ocr-aggregate` 只渲染"将评审 N 个文件 / M 个 hunk / 命中 K 条规则"摘要，零模型调用。

---

## 6. 错误处理

### 6.1 错误码表

| 错误码 | 触发场景 | 抛出方 | 用户提示 |
|---|---|---|---|
| `OCRP-LOAD-001` | `plugin.json` 字段缺失/非法 | Claude Code 启动 | "manifest 校验失败：<字段>" |
| `OCRP-LOAD-002` | `dist/` 缺失或 bin 无执行位 | `review.md` 入口检测 | "请先 `npm run build`" |
| `OCRP-RUN-010` | 非 git 仓库 / git 不可用 | `ocr-prepare` | "当前目录不是 git 仓库 / 找不到 git CLI" |
| `OCRP-RUN-011` | 参数互斥（`--staged` + `--from/--to` 等） | `ocr-prepare` | "参数冲突：xxx 与 yyy 互斥" |
| `OCRP-RUN-012` | diff 为空（无变更） | `ocr-prepare` | 友好提示并以 exit 0 结束 |
| `OCRP-RULES-030` | 规则 JSON 解析失败（P1 自定义时） | `ocr-prepare` | "规则文件解析失败：<path>:<line>" |
| `OCRP-SKILL-040` | PLAN_TASK 输出无法解析为 PlanOutput JSON | `review.md` 编排 | "PLAN 阶段输出非法，已跳过 plan_guidance"（降级） |
| `OCRP-SUB-050` | reviewer subagent 已返回但未调过 `task_done`（done/ 缺文件） | `ocr-aggregate` | 报告顶部 ⚠️ "<file> 评审未完成" + `partial: true` |
| `OCRP-SUB-051` | subagent 异常退出 / Task 工具报错 | 主会话 Task 工具 | 同上，partial 标记 |
| `OCRP-HOOK-060` | hook handler 执行失败 | Claude Code hook 层 | 仅 warning log，不影响 jsonl |

### 6.2 错误降级原则

除 LOAD/RUN 类硬错误外，其余阶段均"尽力交付"：
- PLAN 失败 → 跳过 plan_guidance
- subagent 死 → partial 标记
- hook 死 → 静默继续

任何降级都在 `report.md` 顶部 `## ⚠️ Warnings` 段显式列出，对齐 OCR 的 `AgentWarning`。

---

## 7. 测试策略

### 7.1 单元测试（P0）
- `core/diff/parser.ts` · 用 OCR 同款 fixture diff
- `core/rules/matcher.ts` · path-pattern 命中
- `core/allowlist/allowed_ext.ts` · 扩展名 + 排除 glob
- `core/prompts/render.ts` · 占位符替换
- `core/report/markdown.ts` · 已知 LlmComment[] → 已知 Markdown

### 7.2 CLI 黑盒（P0）
- 构建 dist 后，调 `bin/ocr-prepare` 检测 stdout JSON shape
- `bin/code_comment` append jsonl 是否合法
- `bin/ocr-aggregate` 输入 known jsonl → 输出 known md/json
- `bin/ocr-rules-check` 输入路径 → 输出命中规则列表

### 7.3 集成冒烟（P0）
- 临时 git 仓库 + 已知 commit + `--dry-run` 全链路
- 验证 `context.json` + `report.md`（不调模型）
- CI 友好（无需 ANTHROPIC token）

### 7.4 OCR 兼容性（P0）
- 用 OCR 项目自带的 fixture（如 examples/）
- 对比 deterministic 部分（rules 命中、diff 解析）输出
- `report.json` 走 OCR 的 JSON schema 验证

### 7.5 真机端到端（P0）
- 本地 Claude Code：`claude --plugin-dir ./`
- 跑 `/open-code-review:review HEAD~1`
- 人工核对 chat 输出 + `.ocr-runs/<runId>/report.md`

### 7.6 Mock subagent（P1）
- 不依赖宿主，用一个 mock CLI 模拟 subagent 行为
- 覆盖：超时、partial、并发竞争 jsonl 写入

---

## 8. 构建与发布

### 8.1 构建链路

```
src/**/*.ts
      │  tsc (ES2022, ESM, strict)
      ▼
dist/**/*.js
      │  scripts/build-mjs.mjs   ── 改写 import 后缀 .js → .mjs，重命名文件
      ▼
dist/**/*.mjs
      │  scripts/shebang.mjs     ── dist/cli/*.mjs 加 #!/usr/bin/env node + chmod +x
      │                           ── 软链 bin/ocr-prepare → ../dist/cli/prepare.mjs
      ▼
bin/  (可执行)  +  dist/  (可 import)
      │
      ▼
.claude-plugin/plugin.json + commands/ + agents/ + skills/ + hooks/ + bin/ + assets/
      │  npm pack / git tag
      ▼
分发产物（npm tgz 或 git ref）
```

### 8.2 npm scripts

| 脚本 | 用途 |
|---|---|
| `npm run clean` | rm -rf dist bin/* (保留 bin/.gitkeep) |
| `npm run build:tsc` | tsc 生成 ESM `.js` |
| `npm run build:mjs` | 改写为 `.mjs` |
| `npm run build:bin` | 给 cli/*.mjs 加 shebang + chmod + 同步到 `bin/` |
| `npm run build` | = clean → tsc → mjs → bin |
| `npm test` | node --test（Node 20+ 内置测试，零依赖） |
| `npm run smoke` | 启动临时 git repo 跑集成冒烟 |

### 8.3 安装方式

**开发期**：
```bash
git clone … && cd open-code-review-plugin
npm install && npm run build
claude --plugin-dir /path/to/open-code-review-plugin
```
然后 `/help` 应看到 `/open-code-review:review`。

**本地常驻**：把目录软链到 `~/.claude/plugins/open-code-review-plugin`；或在 `~/.claude/settings.json` 中加入插件路径。

**分发（P1）**：通过 git tag 直接被 Claude Code marketplace 拉取（`plugin.json` 的 `version` 字段控制更新）。npm 包 `@open-code-review/plugin` 作为备选。

### 8.4 README.md 章节骨架（与 OCR README 风格对齐）

1. **Why this plugin?** — 一句话讲清"对齐 OCR 评审能力，但推理交给 Claude Code 自身 agent loop，无 API Key"
2. **Quickstart** — 3 步：clone → build → `claude --plugin-dir`
3. **Commands** — `/open-code-review:review` 全部入参（对齐 OCR CLI）
4. **Architecture** — 引用本设计文档的架构图
5. **Comparison with OCR CLI** — 字段映射 + 何时用哪个的取舍
6. **Configuration** — P0 只有内置规则；P1 才有 `.code-review.yaml`
7. **Troubleshooting** — 常见错误码表（§6.1）
8. **Development** — npm scripts、目录约定、测试
9. **License** — Apache-2.0（与 OCR 一致）

---

## 9. 风险与权衡

| 风险 | 影响 | 缓解 |
|---|---|---|
| Claude Code 插件 API 仍演进 | 高 | 仅依赖已稳定文档化字段；hook handler 单点抽象 |
| 宿主 PLAN 返回非 JSON | 中 | `OCRP-SKILL-040` 降级，plan_guidance 留空 |
| 大 diff 触发 token 上限 | 中 | maxHunkLines 截断 + truncated 标记；reviewer subagent 按文件隔离上下文 |
| subagent 并发竞争 jsonl 写入 | 低 | 每条 append 用 `O_APPEND` 原子写 + fsync；测试覆盖 |
| Windows 路径 / glob 差异 | 中 | 内部统一 POSIX；P0 仅 macOS/Linux 一等承诺，Windows 尽力支持 |
| `bin/` 软链跨 OS 行为差异 | 低 | 跨平台 fallback：失败时直接复制 mjs，加 `.cmd` 包装（Windows） |
| 命名冲突（与 OCR plugin 同名） | 低 | 详见 §2.2：P0 优先 UX 一致沿用 `open-code-review`，文档显式提示卸载 OCR plugin；P1 上 marketplace 时可改名 |

---

## 10. 范围边界（P0 vs P1）

### 10.1 P0（本期交付）

- ✅ 完整插件骨架（manifest / commands / agents / skills / hooks / bin / assets）
- ✅ `bin/ocr-prepare` + `bin/ocr-aggregate` + `bin/ocr-rules-check`
- ✅ `bin/code_comment` + `bin/task_done` + `bin/file_read_diff`
- ✅ PLAN_TASK + MAIN_TASK prompt 移植
- ✅ reviewer subagent 定义 + 工具锁定
- ✅ PostToolUse hook + 双总线（jsonl + 实时回显）
- ✅ Markdown + OCR-compatible JSON 报告
- ✅ 内置规则（OCR `system_rules.json` + `rule_docs/*.md` 直接复制）
- ✅ 单元 + CLI 黑盒 + 集成冒烟 + 真机端到端测试
- ✅ README 9 章
- ✅ macOS / Linux 支持

### 10.2 P1（后续增量）

- ⏳ `REVIEW_FILTER_TASK` skill（去除被 diff 证伪的评论）
- ⏳ `RE_LOCATION_TASK` skill（行号定位失败的重定位）
- ⏳ `MEMORY_COMPRESSION_TASK`（按需）
- ⏳ 自定义规则装载（`.code-review.yaml` / `~/.code-review/rules.yaml`，4 层优先级）
- ⏳ opencode HostAdapter 实现
- ⏳ Windows 一等承诺
- ⏳ PR 平台集成（GitHub/GitLab comment API）
- ⏳ marketplace 上架

### 10.3 明确不做

- ❌ 自带 LLM Provider / API Key 配置
- ❌ 独立 CLI 二进制
- ❌ Claude Agent SDK 子进程
- ❌ AST 级静态分析
- ❌ Web UI / TUI

---

## 11. 待解决问题

> 这些不影响 P0 启动，但实施期需要回过头来验证。

1. **`PostToolUse` hook 的 stdout 是否会被宿主主会话直接消费成可见消息？** 文档未完全明确，需要在实施期通过最小冒烟样本验证。若不可见，则降级为只写 events.jsonl（实时回显失效，不影响最终结果）。
2. **`Task` 工具派发 subagent 的并发上限**：文档未给出确切数值，需要实测；初值用 8（OCR 默认）+ 实测后调整。
3. **subagent 派发时如何把大 JSON 注入 prompt**：方案 A 写入 `.ocr-runs/<runId>/inputs/<idx>.json` 后让 subagent 用 Read 读取；方案 B 直接拼到 prompt 字符串里。建议 A（避开 prompt 长度问题），实施期确认。
4. **`bin/` 加入 PATH 的具体路径分隔符**：Windows 用 `;`，POSIX 用 `:`。`scripts/shebang.mjs` 需要跨平台。
5. **`bin/` 软链 vs 复制的实际选择**：在 macOS/Linux 默认软链 `bin/<name> → ../dist/cli/<name>.mjs`；shebang 直接写在 dist 的 mjs 上以保持单源。若软链创建失败（如 Windows），fallback 为复制并维持构建可重入。需要测试用例覆盖。
6. **Claude Code 是否允许 `agents/*.md` frontmatter 强制限定 `tools` 子集**：文档显示支持，但需要冒烟期实证子集生效（subagent 不能调 Edit/Write，避免它直接改代码而非提交评论）。

---

## 12. 合并 / 验收检查清单

- [ ] 全部目录与文件按 §2 创建
- [ ] `.claude-plugin/plugin.json` 字段完整且无 `apiKey/provider/model/baseUrl`
- [ ] PLAN_TASK / MAIN_TASK prompt 与 OCR 文字一致（除工具说明 6 行）
- [ ] `LlmComment` 字段与 OCR 完全对齐（含字段名大小写、可选性）
- [ ] `bin/*` 文件存在执行位
- [ ] `npm run build` 一次成功
- [ ] `npm test` 全部通过
- [ ] `npm run smoke` 在临时 repo 上通过
- [ ] 本地 `claude --plugin-dir ./` 可见 `/open-code-review:review`
- [ ] 在本 repo 上对 HEAD~1 跑通真机端到端
- [ ] README 9 章齐全
- [ ] §6.1 错误码全部覆盖至少一条用例
- [ ] `.ocr-runs/` 已加入 `.gitignore`
- [ ] §11 6 个待解决问题在实施期均有结论
