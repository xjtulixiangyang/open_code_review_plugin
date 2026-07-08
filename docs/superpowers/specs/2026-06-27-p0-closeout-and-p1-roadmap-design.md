# open-code-review-plugin · P0 收尾与 P1 路线设计

> 日期：2026-06-27  
> 状态：Draft for user review  
> 基于：`docs/superpowers/specs/2026-06-24-opencodereview-plugin-design.md`  
> 范围：对齐 OCR review 主流程，不完整复刻 OCR CLI

---

## 0. 摘要

本设计用于补充既有 P0 架构设计，目标是整理当前 `open-code-review-plugin` 的 P0 收尾标准和 P1 路线。

本轮范围不是重写插件架构，也不是完整复刻 `alibaba/open-code-review` CLI；而是以 OCR 的 **review 主流程** 为参考，确保插件可以可靠完成：选择 git 变更、准备 ReviewContext、匹配内置规则、可选 PLAN、按文件分发 reviewer、收集 comments/done、聚合 Markdown/JSON 报告，并明确剩余差异进入 P1。

P0 完成后，应能说明：当前插件已经可作为 Claude Code 插件形态执行 OCR review 主流程；README、command、CLI 行为一致；关键差异已记录；测试、typecheck、build、smoke 通过。

---

## 1. 背景与当前状态

### 1.1 已有 P0 架构

既有设计文档已经定义了 P0 架构：

1. `/open-code-review:review` slash command 负责主会话编排；
2. `bin/ocr-prepare` 负责 deterministic prep，输出 `.ocr-runs/<runId>/context.json`；
3. 大变更可进入 `ocr-plan` PLAN 阶段；
4. 每个变更文件由 `ocr-reviewer` subagent 独立 review；
5. reviewer 通过 `code_comment` / `task_done` / `file_read_diff` CLI 与运行目录交互；
6. PostToolUse hook 记录 Bash 事件和实时进度；
7. `ocr-aggregate` 聚合 `comments.jsonl`、`done/`，生成 `report.md` 和 `report.json`。

### 1.2 当前已实现能力

当前项目已经具备 P0 主体骨架：

- plugin command、agent、skills、hooks 已存在；
- core diff/parser/allowlist/rules/prompt/report/run store 已实现；
- CLI 包括 prepare、comment、done、file_read_diff、aggregate、rules_check；
- README 已覆盖 quickstart、参数、架构、troubleshooting、development；
- 测试已覆盖多个 core 模块；
- smoke 脚本已存在。

### 1.3 当前工作区待处理改动

当前工作区已有与 P0 收尾相关的未提交实现改动：

- `src/core/diff/workspace.ts`：`collectWorkspaceDiff(repoRoot, paths)` 支持 path filter；
- `src/core/context/review_context.ts`：workspace 模式把 `req.paths` 传入 `collectWorkspaceDiff`；
- `src/core/context/__tests__/review_context.test.ts`：新增 workspace + paths 测试；
- `.claude/settings.local.json`：本地设置改动，应单独判断是否保留。

这些改动属于 P0 收尾中的 workspace paths 行为修复，应在后续 implementation plan 中验收和收口。

---

## 2. OCR review 主流程参考模型

### 2.1 输入选择

OCR review 主流程首先需要确定审查哪段变更：

- workspace：当前工作区变更；
- staged：暂存区变更，本插件增强能力；
- single commit：单个 commit 相对 parent 的变更；
- range：`from..to` 范围变更；
- paths/include：只审查部分路径；
- background：用户提供业务背景，注入 review prompt。

P0 对齐的是这些核心输入能力。更高级的 CLI 参数不作为 P0 强制目标，除非 README、command 或 CLI 已经把它写成支持能力。

### 2.2 deterministic prep

LLM 开始前，应由确定性逻辑准备 review context：

- 调 git 获取 diff；
- 解析 unified diff；
- 建立文件级 `FileChange`；
- 应用 allowlist / exclude；
- 匹配 system rules；
- 生成 `ReviewContext`；
- 持久化到 `.ocr-runs/<runId>/context.json`。

P0 重点是保证 workspace 中 tracked + untracked 都能进入 diff，`paths` 对 tracked / untracked 都生效，特殊文件不会破坏流程。

### 2.3 PLAN 阶段

OCR review 主流程在较大变更时先做 PLAN：

- 变更规模超过阈值时进入 plan；
- PLAN_TASK 输出 `PlanOutput`；
- plan 失败时不应中断 review，而是降级继续；
- per-file review 时只注入与当前文件相关的 `plan_guidance`。

P0 需要明确阈值、fallback、schema 和 guidance 筛选规则。

### 2.4 per-file review 阶段

主流程核心是按文件独立 review。每个 reviewer 应能看到：

- 当前文件 diff；
- changed files 列表；
- requirement background；
- system rule；
- plan guidance；
- 当前时间。

reviewer 可以读取相关上下文，但只能为当前文件提交评论。无问题时也必须标记完成。

### 2.5 aggregate/report 阶段

所有 reviewer 完成后，聚合阶段应：

- 读取 comments；
- 读取 done markers；
- 判断 partial；
- 渲染 Markdown 报告；
- 输出 JSON 报告；
- 把 artifact 路径交给用户。

P0 应保证 `LlmComment` 字段稳定，partial/no-comment 输出稳定，JSON status 和 warnings 语义明确。

### 2.6 错误处理和降级

错误分为两类：

- hard failure：无法确定审查对象或无法生成报告，例如非 git repo、参数冲突；
- soft failure：可降级继续，但最终报告必须说明，例如 plan parse 失败、部分 reviewer 未完成、hook 失败。

### 2.7 P0 非目标

以下不属于本次 P0 主流程对齐：

- 自定义 `.code-review.yaml` 或 OCR project/global rule layering；
- `REVIEW_FILTER_TASK`；
- `RE_LOCATION_TASK`；
- GitHub/GitLab inline comment 发布；
- retry/resume previous run；
- marketplace 发布；
- 完整 OCR CLI 所有参数兼容；
- 多轮 memory compression。

---

## 3. 当前插件实现状态与兼容性矩阵

### 3.1 输入与参数

| 能力 | OCR 主流程 | 当前插件状态 | 分类 | 后续动作 |
|---|---|---|---|---|
| workspace review | 默认模式，tracked + untracked | 已实现 `collectWorkspaceDiff()` | P0 必须验证 | 验证 tracked、untracked、paths filter |
| staged review | OCR 原版无单独 staged 模式 | 插件已承诺并实现 | P0 必须验证 | 作为增强能力验收 |
| commit review | 单 commit review | 插件支持 `--commit` / positional sha | P0 必须验证 | 验证输出和 rename 行为 |
| range review | OCR 使用 merge-base 到 `to` | 插件当前直接 range | P0 必须补齐/决策 | 推荐改为 OCR merge-base 语义 |
| paths/include | 只审查部分路径 | 插件支持 `--paths`，当前正在修 workspace | P0 必须补齐/验证 | 保留修复并扩展测试 |
| background | 注入 prompt | 已透传 | P0 已具备 | 长度/安全限制后移 |
| concurrency | OCR semaphore 默认 8 | 插件靠 command 编排约束，默认 2、上限 8 | P0 已修正 | 默认低并发保障 Claude Code subagent 稳定性；遇到 503/timeout/partial 时可用 `--concurrency 1` |
| preview/dry-run | OCR 有 preview | 插件 parse 但未实现 | P0 必须修正 | 实现最小 preview 或标为 P1 unsupported |
| custom rules | OCR `--rule` | 插件 parse `--rules` 但未加载 | P0 必须修正 | P0 不静默忽略，P1 实现 |

### 3.2 deterministic prep / diff

| 能力 | OCR 主流程 | 当前插件状态 | 分类 | 后续动作 |
|---|---|---|---|---|
| git repo 校验 | 明确错误 | 当前依赖 git stderr | P0 必须补齐 | 输出稳定 `OCRP-RUN-010` |
| no changes | skipped/no files | command 文档处理，prepare 仍输出 context | P0 必须验证/修正 | 建议 prepare exit 0 + `fileCount: 0` |
| workspace tracked diff | `git diff HEAD` | 已实现 | P0 必须验证 | 单测/集成测试 |
| workspace untracked diff | `/dev/null` 合成新增 diff | 已实现 | P0 必须验证 | 测试 parser path/status |
| range diff | merge-base diff | 当前直接 range | P0 必须补齐 | 推荐实现 merge-base |
| commit diff | `git show --find-renames` | 当前 `git diff-tree -p -r` | P0 必须验证/决策 | 验证是否足够等价 |
| rename/binary/deleted | OCR 有检测/过滤 | parser 能识别部分状态 | P0 必须验证 | 补测试或手动验收 |
| large diff guard | OCR token guard | 插件只有 hunk line 限制 | P1 backlog | 后续设计 |

### 3.3 rule / prompt

| 能力 | OCR 主流程 | 当前插件状态 | 分类 | 后续动作 |
|---|---|---|---|---|
| built-in system rules | embedded rules | 已有 `system_rules.json` + docs | P0 已具备 | 回归测试 |
| custom rule layering | CLI/project/global/embedded | 未实现 | P1 backlog | P0 处理参数一致性 |
| per-file rule resolution | first matching rule | 插件 first match | P0 已具备 | 保持 |
| prompt 模板移植 | OCR task templates | TS + skill 文件双份 | P0 必须验证 | 加强一致性检查或人工验收 |
| plan threshold | 模板常量 | command 写 changedLines > 50 | P0 必须验证/修正 | 统一阈值语义 |
| plan fallback | warning 后继续 | command 文档要求降级 | P0 必须验证 | 手动/测试验收 |
| plan guidance | 注入相关 guidance | 有 helper，但 command 让模型手算 | P0 必须修正 | CLI/helper 确定性化 |

### 3.4 per-file review / subagent

| 能力 | OCR 主流程 | 当前插件状态 | 分类 | 后续动作 |
|---|---|---|---|---|
| per-file 并行 | bounded semaphore | Claude Code subagents | P0 已具备/需约束 | 文档说明调度边界 |
| reviewer 只评当前文件 | per-file subtask | agent 约束当前文件 | P0 已具备 | 可增加 CLI 校验 |
| code_comment | 收集评论 | 写 `comments.jsonl` | P0 必须验证 | CLI roundtrip 测试 |
| task_done | 完成文件 | 写 done marker | P0 必须验证 | partial 测试 |
| file_read_diff | 读其他变更 diff | 已支持 | P0 必须验证 | path normalization 可后移 |
| line relocation | OCR resolve/relocate | 未实现 | P1 backlog | 后续设计 |
| review filter | OCR filter 阶段 | 未实现 | P1 backlog | 后续设计 |

### 3.5 aggregate / report

| 能力 | OCR 主流程 | 当前插件状态 | 分类 | 后续动作 |
|---|---|---|---|---|
| comments 聚合 | collector | 读 `comments.jsonl` | P0 必须验证 | 多文件/多评论测试 |
| partial 判断 | warnings/errors | done marker 对比 | P0 必须验证 | missing done 测试 |
| Markdown report | OCR text output | 插件 Markdown | P0 已具备 | 接受格式差异 |
| JSON schema | OCR JSON fields | 插件有 status/summary/comments/warnings | P0 必须验证/修正 | 统一 status 值 |
| severity grouping | OCR 无基础字段 | 插件当前缺 severity | P0 文档修正/P1 | P0 不强加 severity |
| token counts | OCR 有真实 token | 插件无独立 LLM | P0 必须决策 | 保留 0 并说明 |
| empty result | 正常输出 | 已支持 | P0 必须验证 | 回归测试 |

### 3.6 hooks / runtime bus

| 能力 | OCR 主流程 | 当前插件状态 | 分类 | 后续动作 |
|---|---|---|---|---|
| durable comment bus | OCR 内存 collector | 插件 jsonl | P0 已具备 | 架构差异可接受 |
| live progress | OCR CLI 输出 | hook 捕捉 Bash | P0 必须验证 | hook 失败不影响 aggregate |
| hook failure fallback | 无对应 | silent/best-effort | P0 已具备 | 明确 soft failure |
| shell parse robustness | 无对应 | 简化 parser | P1 backlog | 后续增强 |

### 3.7 tests / verification

| 能力 | 当前状态 | 分类 | 后续动作 |
|---|---|---|---|
| unit tests | 已覆盖多个 core 模块 | P0 已具备 | 跑全量 |
| workspace path tests | 新增未提交测试 | P0 必须补齐 | 保留并扩展 |
| staged/commit/range tests | 不足 | P0 必须验证 | 增加或手动验收 |
| CLI tools tests | 不足 | P0 必须补齐/验证 | 覆盖 comment/done/aggregate |
| smoke test | 已有 | P0 必须验证 | 确认关键路径 |
| README/spec/command consistency | 有潜在冲突 | P0 必须补齐 | 逐项核对 |

---

## 4. P0 完成定义

P0 完成需要同时满足以下条件。

### 4.1 输入范围稳定

稳定支持 workspace、staged、single commit、range、path-scoped review、background context。staged 是插件增强能力，纳入 P0 验收。

### 4.2 deterministic prep 可测

`ocr-prepare` 和 core prep 必须能稳定生成 `ReviewContext`：非 git repo 有明确错误，无变更有稳定结果，tracked/untracked/paths/allowlist/rules 都可测。

### 4.3 PLAN 行为明确

大变更触发 PLAN，小变更跳过 PLAN；parse 失败降级继续；`plan_guidance` 只注入相关文件；空 guidance 不泄漏占位符。

### 4.4 per-file review 契约完整

每个 reviewer 输入字段完整；评论通过 `code_comment`，完成通过 `task_done`；缺失 done 时 aggregate 标记 partial。

### 4.5 report 输出稳定

`ocr-aggregate` 必须输出 Markdown、JSON、partial warnings、empty/no issue 输出和 artifact paths。JSON status 和 token counts 语义要稳定。

### 4.6 文档不夸大能力

已实现写 supported；未实现写 P1/planned；parsed-but-not-implemented flags 不能静默假支持；与 OCR 差异必须明确。

### 4.7 验证通过

至少通过：

- `npm test`；
- `npm run typecheck`；
- `npm run build`；
- `npm run smoke`；
- 关键手动或自动兼容性检查。

---

## 5. P0 必须补齐/修正

### P0-Fix-1：处理 parsed-but-not-implemented flags

`--preview`、`--dry-run`、`--rules` 存在被解析但未实现或未完全实现的问题。P0 必须选择：实现最小行为，或返回明确 unsupported / planned，不能静默忽略。

建议：

- P0 不实现自定义规则，`--rules` 明确报错或 warning；
- `--preview` / `--dry-run` 若不做最小 preview，则从 supported docs 中移到 P1；
- `--format` 和 `--concurrency` 明确属于 command/aggregate 编排，文档同步。

### P0-Fix-2：确定 range diff 语义

OCR range 使用 merge-base 到 `to`。插件当前直接使用 `${from}..${to}`，在分叉场景可能不同。

建议 P0 改成 OCR merge-base 语义；若暂不改，README/spec 必须明确差异。推荐改实现。

### P0-Fix-3：补 git repo / no changes 稳定错误语义

建议：

- 非 git repo 返回稳定 `OCRP-RUN-010`；
- no changes 时 `ocr-prepare` exit 0，输出 `fileCount: 0`；
- command 看到 `fileCount === 0` 后友好停止。

### P0-Fix-4：让 plan guidance 逻辑确定性化

当前已有 `plan_guidance.ts` helper，但 command 让主会话手算 guidance。P0 应增加 CLI/helper，例如 `ocr-plan-guidance --runId <id> --path <file>`，让 command 调工具获取结果，避免模型重复实现过滤规则。

### P0-Fix-5：report JSON/status 与 README/spec 对齐

定义稳定 status，例如：

- `success`；
- `skipped`；
- `completed_with_warnings`；
- `error` 或 `completed_with_errors`。

token counts 因插件不直接调用 LLM 可保留为 0，但必须文档说明。

### P0-Fix-6：README/command/spec 参数一致性

建立 P0 supported / P1 planned flag 表，并同步 README、command frontmatter、`prepare.ts` 行为。不支持的 flag 不应静默通过。

---

## 6. P0 必须验证

### P0-Verify-1：workspace + paths

验证 tracked modified、untracked、unmatched、多 path、excluded path 行为。当前已有测试应保留并扩展。

### P0-Verify-2：staged / commit / range

验证 staged 只审暂存区，workspace 包含 staged + unstaged，commit 只审该 commit，range 符合最终语义，rename/binary/deleted 不破坏 parser/aggregate。

### P0-Verify-3：allowlist / rules

验证 unsupported extension 被过滤，default excluded patterns 生效，TS/JS 命中正确 rule doc，default fallback 生效，构建后 rule docs 能加载。

### P0-Verify-4：prompt / skill consistency

验证 TS prompt 模板和 skill 文件关键内容一致，空 `plan_guidance` 不泄漏，reviewer input 字段完整，OCR MAIN_TASK / PLAN_TASK 的关键约束未丢。

### P0-Verify-5：CLI tool roundtrip

验证 `code_comment`、`task_done`、`file_read_diff`、`ocr-aggregate` 的完整 roundtrip；missing done 产生 partial warning；no comments 产生 clean report。

### P0-Verify-6：hook 行为

验证 Bash 调 OCR 工具时 hook 写入 `events.jsonl`，hook 失败不影响最终 aggregate，hook 输出不污染 CLI JSON stdout。

### P0-Verify-7：end-to-end smoke

验证 `npm run smoke` 覆盖 prepare → comment/done → aggregate，不依赖真实 LLM，可重复运行，失败信息可定位。

---

## 7. P1 backlog

### 7.1 Review quality

#### P1-A1：`REVIEW_FILTER_TASK`

优先级：高。  
价值：降低误报，提升报告可信度，更接近 OCR 主流程。

Acceptance：

- filter 输入 diff + comments + rule + background；
- filter 输出要删除的 comment index/id；
- 删除动作由 deterministic CLI 执行；
- aggregate 展示过滤后的结果；
- 过滤过程可审计。

#### P1-A2：line resolver / `RE_LOCATION_TASK`

优先级：高。  
价值：提升评论位置准确性，为 PR inline comments 铺路。

Acceptance：

- deterministic resolver 可用 `existing_code` 匹配 diff hunk；
- fallback 到新文件内容；
- LLM relocation 作为最后 fallback；
- aggregate 前统一 normalize line range。

#### P1-A3：severity / priority 分类

优先级：中高。  
建议不改 OCR-compatible `LlmComment` 基础字段，在 `_meta` 或 report layer 增加 severity。

### 7.2 Rules and filtering

#### P1-B1：自定义规则配置

优先级：高。  
建议优先支持 OCR 原版 JSON 规则层级，再考虑 `.code-review.yaml` 别名。

Acceptance：

- `--rules <path>` 最高优先级；
- 项目/用户规则自动发现；
- parse error 是 hard failure；
- rule resolver 输出 include/exclude/rule prompt/fallback。

#### P1-B2：preview / dry-run

优先级：中高。  
输出 included files、excluded files、原因、rule hit、insertions/deletions/hunks、是否触发 plan。

#### P1-B3：file filter reason

优先级：中。  
将 `isAllowed()` 从 boolean 升级为 decision object，并在 preview/report 中展示排除原因。

### 7.3 Runtime reliability

#### P1-C1：retry / resume partial run

优先级：中。  
支持只重跑未完成文件，保留已有 comments，必要时清理单文件旧 comments。

#### P1-C2：subagent timeout / max rounds

优先级：中。  
先做软约束和 partial 标记，再研究 Claude Code 是否能传真实 timeout。

#### P1-C3：large diff token guard / chunking

优先级：中。  
先做 skip guard，再做 hunk chunking 和去重/filter。

### 7.4 Platform integration

#### P1-D1：GitHub inline comments

优先级：中高，但依赖 line resolver/relocation。  
使用 `gh` CLI 或 GitHub API，认证来自用户环境，支持 dry-run，失败不影响本地 report。

#### P1-D2：GitLab inline comments

优先级：中低。  
建议先完成 GitHub 后再做。

### 7.5 Productization

#### P1-E1：插件命名与冲突策略

优先级：中。  
P0 保持 `open-code-review`；P1 发布前评估 `open-code-review-cc` 或发布名与本地 plugin name 分离。

#### P1-E2：发布流程

优先级：中。  
包括 package files、versioning、changelog、release smoke、install docs、compatibility matrix、license/source attribution。

#### P1-E3：observability / debug

优先级：中低。  
增强 `.ocr-runs/<runId>/manifest.json`、timing、subagent durations、warnings/errors、hook events summary。

---

## 8. 推荐路线图

推荐顺序：

```text
P0 closeout
  → REVIEW_FILTER_TASK
  → severity + line resolver + relocation
  → custom rules + preview
  → retry/resume + large diff
  → GitHub/GitLab posting
  → marketplace/productization
```

P1 应优先补影响 review 质量和可信度的能力，而不是过早发布到 PR 平台。

---

## 9. 后续 implementation plan 输入

这份 spec 批准后，下一步 implementation plan 只覆盖 **P0 closeout**，不一次性实现 P1。

建议 plan 目标：

> 完成 open-code-review-plugin P0 收尾：修正文档/CLI 参数不一致，补齐 OCR review 主流程关键差异，增加最小验收测试，确保 test/typecheck/build/smoke 全部通过。

建议拆成 8 个任务：

1. 参数/文档一致性审计；
2. workspace paths 当前修复收口；
3. range / commit / rename diff 语义；
4. 错误语义稳定；
5. plan guidance 确定性化；
6. aggregate/report 状态对齐；
7. CLI tool roundtrip + hook smoke；
8. 最终验证和文档收口。

P1 不建议一次性做完。后续每个大项单独走 brainstorming → design doc → writing-plans → implementation，例如：

- `review-filter-design.md`；
- `line-relocation-design.md`；
- `custom-rules-design.md`；
- `preview-dry-run-design.md`；
- `github-posting-design.md`；
- `resume-retry-design.md`。
