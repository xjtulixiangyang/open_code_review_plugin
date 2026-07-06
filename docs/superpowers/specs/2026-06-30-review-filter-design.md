# open-code-review-plugin · REVIEW_FILTER_TASK 设计

> 日期：2026-06-30
> 状态：Draft for user review
> 基于：`docs/superpowers/specs/2026-06-27-p0-closeout-and-p1-roadmap-design.md` §7.1 P1-A1
> 范围：P1-A1，按文件过滤 reviewer 误报/低质量评论；不实现 severity、line relocation、GitHub posting、resume

---

## 0. 摘要

本设计为插件增加一个 per-file 的 `REVIEW_FILTER_TASK` 阶段：在 reviewer 产出评论后、aggregate 之前，针对单个文件的评论集合运行过滤，隐藏误报/低质量评论，同时保留原始评论和可审计的过滤记录。

核心原则（与 P0 一致）：

- **模型决策交给 host Claude Code**，确定性动作交给 CLI；
- **原始 comments.jsonl 不改写**，过滤是附加层；
- **filter 失败可降级**，不阻断最终报告；
- **保持 `LlmComment` OCR 兼容字段不变**，扩展放在 runtime record 层。

完成后，插件报告默认展示“过滤后的保留评论”，并在报告/JSON 中注明过滤了多少条、审计产物在哪。

---

## 1. 背景与现状

### 1.1 当前评论数据流

1. `ocr-reviewer` subagent 针对单个文件 review，通过 `code_comment` Bash 向 `.ocr-runs/<runId>/comments.jsonl` 追加 `CommentRecord`，并以 `task_done` 标记完成；
2. `ocr-aggregate` 读取 `context.json` + `comments.jsonl` + `done/`，直接把全部 comments 渲染成 `report.md` / `report.json`；
3. 目前 comment 无稳定 id，无过滤阶段，无 filtered/unfiltered 区分。

### 1.2 现有 schema

`CommentRecord extends LlmComment`：

```ts
export interface LlmComment {
  path: string;
  start_line: number;
  end_line: number;
  content: string;
  suggestion_code?: string;
  existing_code?: string;
  thinking?: string;
}
export interface CommentRecord extends LlmComment {
  _meta?: { subagent?: string; ts?: string };
}
```

`ocr-aggregate` 计算 `partialFiles` 后调用 `renderMarkdownReport(ctx, comments, { partialFiles })` 与 `renderJsonReport(ctx, comments, { partialFiles, durationMs })`。

### 1.3 P1-A1 acceptance（来自 roadmap）

- filter 输入 diff + comments + rule + background；
- filter 输出要删除（隐藏）的 comment index/id；
- 删除动作由 deterministic CLI 执行；
- aggregate 展示过滤后的结果；
- 过滤过程可审计。

本设计把“删除”实现为“隐藏”，原始评论保留在 `comments.jsonl`，满足审计要求。

---

## 2. 非目标

以下不在本 spec 范围：

- severity / priority 分类（P1-A3）；
- line resolver / relocation（P1-A2）；
- 全局跨文件去重；
- 自定义规则加载 / `--rules`（P1-B1）；
- preview / dry-run（P1-B2）；
- GitHub/GitLab inline posting（P1-D1/D2）；
- retry / resume（P1-C1）。

filter 阶段只做“是否隐藏某条评论”的二元判断，不重写评论内容、不改变 line range。

---

## 3. 架构与数据模型

### 3.1 总体流程

```text
prepare → (plan?) → per-file reviewer → per-file filter → aggregate
                                                  │
                              ocr-filter-apply (deterministic)
```

每个文件 review 完成后，主会话针对该文件运行 `REVIEW_FILTER_TASK`（host LLM 判断），产出结构化决定；`ocr-filter-apply` 校验并落盘；aggregate 读取所有 filter 审计产物，构造 hidden id 集合，最终报告只渲染未隐藏评论。

### 3.2 CommentRecord 扩展

`LlmComment` 保持不变。`CommentRecord` 增加稳定 `comment_id`：

```ts
export interface CommentRecord extends LlmComment {
  comment_id: string;
  _meta?: { subagent?: string; ts?: string };
}
```

- `comment_id` 由 `code_comment` CLI 写入时生成，reviewer 无需传入；
- `comment_id` 属于 runtime record 字段，不属于 OCR 原生 comment body；
- `renderJsonReport()` 输出到 `report.json` 的 `comments[]` 时保留 `comment_id`（剥离 `_meta`），以便后续 severity、relocation、posting 复用。

`comment_id` 格式：`c-<uuid>`，例如 `c-4f9163b1-7d2e-4d52-9be2-a8474ccf03df`。

- 由 `node:crypto` 的 `randomUUID()` 生成，外层加 `c-` 前缀，避免与未来纯数字 index 混淆；
- 生成后持久写入 `comments.jsonl`，因此对后续 filter / aggregate 是稳定引用；
- 不依赖读取现有行数，不受并发追加顺序影响；
- 单 run 内碰撞可视为不可达；若未来需要完全 deterministic id，可在 P1-C1 resume 设计中引入 run 级计数器。

### 3.3 Filter 模型

新增 `src/core/model/filter.ts`：

```ts
export interface FilterDecision {
  comment_id: string;
  action: 'hide';
  reason: string;
}

export interface FilterFileResult {
  path: string;
  decisions: FilterDecision[];
  _meta?: {
    source: 'review_filter_task';
    subagent?: string;
    ts?: string;
  };
}
```

- P1 首版 `action` 仅支持 `'hide'`；不支持 `edit` / `rewrite`。
- `reason` 非空字符串，必须由 filter 阶段给出，作为审计依据。
- `FilterFileResult` 与单个变更文件一一对应。

### 3.4 过滤文件布局

每个文件一个审计产物：

```text
.ocr-runs/<runId>/filters/<safePathKey(file)>.json
```

示例内容：

```json
{
  "path": "src/a.ts",
  "decisions": [
    {
      "comment_id": "c-4f9163b1-7d2e-4d52-9be2-a8474ccf03df",
      "action": "hide",
      "reason": "The comment is based on deleted code, not newly added behavior."
    }
  ],
  "_meta": {
    "source": "review_filter_task",
    "subagent": "filter-src-a-ts",
    "ts": "2026-06-30T12:00:00.000Z"
  }
}
```

`safePathKey(path)`：使用 `encodeURIComponent(path)`，因此 `/` 会变成 `%2F`，不会产生子目录；空 path / 含 `..` 的 path 在 CLI 层拒绝（防目录穿越）。例如 `src/a.ts` → `src%2Fa.ts`。

### 3.5 store helper

在 `src/core/runs/store.ts` 增加：

```ts
export interface ReadFilterResultsOutput {
  results: FilterFileResult[];
  warnings: Array<{ kind: string; path?: string; detail: string }>;
}

export async function writeFilterResult(runId: string, result: FilterFileResult): Promise<void>
export async function readFilterResults(runId: string): Promise<ReadFilterResultsOutput>
```

- `writeFilterResult` 写入 `filters/<safePathKey(result.path)>.json`，覆盖该文件的旧过滤结果（支持重跑 filter）。
- `readFilterResults` 读取 `filters/` 目录下所有 `.json`，逐个解析；`ENOENT` 返回 `{ results: [], warnings: [] }`；单个文件解析失败时跳过该文件并把原因加入 `warnings`（见 §6）。

---

## 4. 运行流程

### 4.1 code_comment 变更

`src/cli/code_comment.ts` 增加 `comment_id` 生成：

1. 解析参数（不变）。
2. 调用 `randomUUID()`，组装 `comment_id = "c-" + randomUUID()`。
3. 写入 `CommentRecord.comment_id`。
4. stdout 输出增加 `comment_id`：

```json
{ "ok": true, "path": "src/a.ts", "start": 1, "end": 1, "comment_id": "c-4f9163b1-7d2e-4d52-9be2-a8474ccf03df" }
```

reviewer 调用形态不变（不传 `--comment-id`）。若未来需要显式传入，CLI 可接受可选 `--comment-id` 覆盖，P1 首版不实现该覆盖分支。

### 4.2 REVIEW_FILTER_TASK（host LLM 判断）

新增 skill `skills/ocr-review-filter/SKILL.md`，定位为 per-file filter 任务（对应 OCR `REVIEW_FILTER_TASK`）。主会话在每个文件 review 完成后、该文件 `task_done` 之前或之后均可触发；推荐在 `task_done` 之后立即运行，确保 comments 已就绪。

skill 输入（主会话注入）：

```
runId: <runId>
subagent: filter-<safePathKey>
currentFilePath: <path>
currentFileDiff:
<fenced diff block>
requirementBackground: <background or "">
systemRule:
<rule doc verbatim>
planGuidance:
<plan guidance string or "">
candidateComments:
<该文件的全部 CommentRecord，含 comment_id、start_line、end_line、content、suggestion_code、existing_code、thinking>
```

skill 指令要点：

- 逐条评估 candidateComments，判断哪些应隐藏（误报、针对删除代码、针对未改动代码、与 rule/background 无关、重复）；
- 只能输出 hide 决定，不能改写 content / line range；
- 每条 hide 必须给出 reason；
- 不隐藏的评论不输出；
- 输出一个 fenced ```json 块，schema 为 `FilterFileResult`（无 `_meta`，`_meta` 由 `ocr-filter-apply` 补）。

skill 输出示例：

```json
{
  "path": "src/a.ts",
  "decisions": [
    { "comment_id": "c-4f9163b1-7d2e-4d52-9be2-a8474ccf03df", "action": "hide", "reason": "Comment targets deleted code, not added behavior." }
  ]
}
```

### 4.3 ocr-filter-apply（确定性落盘）

新增 CLI `src/cli/filter_apply.ts`，映射到 `bin/ocr-filter-apply`：

```bash
ocr-filter-apply --runId <runId> --path <file> --input <filter-output-json-string>
```

职责：

1. 解析 flags，校验 `runId`、`path`、`input`。
2. `JSON.parse(input)`，校验是合法 `FilterFileResult`：
   - `path` 等于 `--path`；
   - `decisions[]` 每项 `comment_id` 非空、`action === 'hide'`、`reason` 非空；
3. 读取 `context.json`，校验 `path` 在 `ctx.files` 中（防止 filter 误写到非本次 review 的文件）。
4. 读取 `comments.jsonl`，校验每个 `comment_id` 存在且 `path` 匹配；不存在的 id 记 warning 并跳过（不 fail）。
5. 补 `_meta`：`source: 'review_filter_task'`、`subagent`、`ts`。
6. 调 `writeFilterResult(runId, result)` 落盘。
7. stdout 输出：

```json
{ "runId": "...", "path": "src/a.ts", "hiddenCount": 2, "filterPath": ".ocr-runs/<runId>/filters/src%2Fa.ts.json" }
```

退出码：成功 0；参数/校验错误 2；内部错误 1。

### 4.4 ocr-aggregate 变更

`src/cli/aggregate.ts` 流程改为：

1. 读取 `context.json`、`comments.jsonl`、`done/`（不变）。
2. 读取 `readFilterResults(runId)` 得到 `{ results, warnings }`，构造 `hiddenIds: Set<string>`，并把 `warnings` 合入 `filterWarnings`（解析失败 / id 不匹配 / path 不在 review 范围）。
3. `rawComments` = 全部 comments；`visibleComments` = `rawComments.filter(c => !hiddenIds.has(c.comment_id))`。
4. 渲染时传入 `visibleComments`。
5. JSON / stdout summary 增加：

```json
{
  "runId": "...",
  "reportMd": "...",
  "reportJson": "...",
  "partial": false,
  "filesReviewed": 2,
  "rawCommentCount": 5,
  "commentCount": 3,
  "filteredCommentCount": 2,
  "partialFiles": [],
  "filterWarnings": []
}
```

### 4.5 报告渲染调整

`renderMarkdownReport(ctx, comments, opts)` 与 `renderJsonReport(ctx, comments, opts)` 的 `comments` 入参语义改为“已过滤的可见评论”。在 Markdown 头部与 JSON summary 中体现过滤摘要：

- Markdown：在 `**Issues found**: N` 一行后增加 `**Filtered**: M (hidden from raw R)`，并在报告尾部链接审计目录 `.ocr-runs/<runId>/filters/`。
- JSON `ReportJson` 增加：

```ts
summary: {
  files_reviewed: number;
  comments: number;            // visible
  raw_comments: number;       // 全部
  filtered_comments: number;  // hidden
  ...
};
warnings: Array<{ path: string; reason: string }>;
filter_warnings?: Array<{ kind: string; detail: string }>;
```

`filter_warnings` 收集 filter 阶段 soft failures（见 §6），与 partial `warnings` 区分。

---

## 5. 命令编排

`commands/review.md` 在 Step 3 与 Step 4 之间插入新 Step（filter 阶段）：

```markdown
### Step 3.5 — Per-file filter (REVIEW_FILTER_TASK)

After each file's reviewer subagent returns, for that file:

1. Read the file's comments from `.ocr-runs/<runId>/comments.jsonl` (filter by `path == currentFilePath`), keeping `comment_id`.
2. If the file has zero comments, skip filter for this file.
3. Otherwise invoke the `ocr-review-filter` skill with runId, currentFilePath, currentFileDiff, requirementBackground, systemRule, planGuidance, candidateComments.
4. Capture the skill's fenced ```json output (FilterFileResult without `_meta`).
5. Run Bash to apply:
   ```bash
   ocr-filter-apply --runId <runId> --path <currentFilePath> --input '<json string>'
   ```
6. If the skill output is unparseable or `ocr-filter-apply` exits non-zero, treat as soft failure: set `filterSkipped = true`, continue without filtering for this file, mention `OCRP-FILTER-070` in the final report.
```

Step 4 aggregate 不变（aggregate 已内置读取 filters）。Step 5 present 增加：若 `filteredCommentCount > 0`，提示用户过滤了多少条、审计在 `.ocr-runs/<runId>/filters/`。

并发：filter 与 reviewer 同样 per-file，可在 reviewer 返回后串行或按文件并行；P1 首版由 command 串行驱动即可，不强制并行。

---

## 6. 错误处理与降级

filter 阶段全部为 soft failure，不阻断 aggregate：

| 场景 | 处理 | 标记 |
|---|---|---|
| skill 输出不可解析 | 该文件不过滤，使用原始 comments | `OCRP-FILTER-070` |
| `ocr-filter-apply` 退出非 0 | 同上 | `OCRP-FILTER-070` |
| filter 文件 JSON 解析失败 | aggregate 跳过该 filter 文件，使用原始 comments | `filter_warnings` |
| `comment_id` 在 comments.jsonl 不存在 | 跳过该 decision，继续 | `filter_warnings` |
| `path` 不在 review 范围 | 拒绝写入 / 跳过 | `OCRP-FILTER-071`（hard，apply 阶段） |
| `decisions` 缺 reason / action 非法 | apply 拒绝，exit 2 | `OCRP-FILTER-072` |

新增错误码：

- `OCRP-FILTER-070`：filter 阶段 soft failure，已降级。
- `OCRP-FILTER-071`：filter 目标文件不在本次 review 范围（apply hard fail）。
- `OCRP-FILTER-072`：filter decision 校验失败（apply hard fail，exit 2）。

aggregate 永远能产出报告：无 filter 文件 → 全部 comments 可见 + `filteredCommentCount: 0`；filter 部分失败 → 成功部分生效，失败部分进 `filter_warnings`。

---

## 7. 测试策略

TDD，每个行为先写失败测试。

### 7.1 单元测试

- `src/core/model/__tests__/filter.test.ts`：类型与默认值（可选，若纯类型则跳过）。
- `src/core/runs/__tests__/store_filter.test.ts`：
  - `writeFilterResult` + `readFilterResults` roundtrip；
  - `readFilterResults` 在无 `filters/` 时返回 `{ results: [], warnings: [] }`；
  - 单个 filter 文件损坏时跳过并返回其余。
- `src/cli/__tests__/code_comment_id.test.ts`：
  - `code_comment` stdout 含 `comment_id`；
  - 连续两次调用生成不同 id，且都匹配 `^c-[0-9a-f-]+$`；
  - 写入的 `comments.jsonl` 行含 `comment_id` 字段。
- `src/cli/__tests__/filter_apply.test.ts`：
  - 合法输入落盘并输出 `hiddenCount`；
  - `path` 不在 context → exit 2 `OCRP-FILTER-071`；
  - decision 缺 `reason` → exit 2 `OCRP-FILTER-072`；
  - `comment_id` 不存在 → 该 decision 跳过，仍 exit 0，stdout `hiddenCount` 不含它。
- `src/core/report/__tests__/json.test.ts`（扩展）：
  - `raw_comments` / `filtered_comments` 正确；
  - `filter_warnings` 收集解析失败。
- `src/core/report/__tests__/markdown.test.ts`（扩展）：
  - 含 `**Filtered**: M` 行（当 M>0）；
  - 无过滤时不含该行（或显示 0，二选一，本 spec 选 M>0 才显示）。
- `src/cli/__tests__/aggregate_filter.test.ts`：
  - 有 filter 文件时 aggregate 输出 `commentCount` = raw - hidden；
  - 无 filter 文件时 `commentCount == rawCommentCount`，`filteredCommentCount == 0`。

### 7.2 集成 / roundtrip

扩展 `scripts/smoke.sh`：在 aggregate 前对单文件写入一个 filter 文件（或调用 `ocr-filter-apply`），断言 `report.md` 不含被隐藏评论、`report.json` `filtered_comments >= 1`。

`src/cli/__tests__/roundtrip.test.ts` 增加：写两条 comment、隐藏一条、aggregate 后 `commentCount == 1`、`filteredCommentCount == 1`、`report.md` 只含保留评论。

### 7.3 skill 一致性

新增 `src/core/prompts/__tests__/skill_consistency.test.ts` 断言（若已存在则扩展）：校验 `skills/ocr-review-filter/SKILL.md` 关键约束（只输出 hide、必须 reason、输出 FilterFileResult JSON）与文档一致。

---

## 8. 文件清单

### 新增

- `src/core/model/filter.ts` — `FilterDecision` / `FilterFileResult`。
- `src/cli/filter_apply.ts` — `ocr-filter-apply` CLI。
- `src/cli/__tests__/code_comment_id.test.ts`
- `src/cli/__tests__/filter_apply.test.ts`
- `src/cli/__tests__/aggregate_filter.test.ts`
- `src/core/runs/__tests__/store_filter.test.ts`
- `skills/ocr-review-filter/SKILL.md` — per-file filter skill。

### 修改

- `src/core/model/comment.ts` — `CommentRecord` 增加 `comment_id`。
- `src/cli/code_comment.ts` — 生成并写入 `comment_id`，stdout 增加 `comment_id`。
- `src/core/runs/store.ts` — 增加 `writeFilterResult` / `readFilterResults`，`readComments` 不变。
- `src/core/report/json.ts` — `ReportJson.summary` 增加 `raw_comments` / `filtered_comments`，新增 `filter_warnings`；status 语义不变。
- `src/core/report/markdown.ts` — 头部增加 `**Filtered**` 行（M>0 时），尾部链接审计目录。
- `src/cli/aggregate.ts` — 读取 filters、构造 hiddenIds、传入可见 comments、summary 增加过滤字段。
- `scripts/shebang.mjs` — map 增加 `filter_apply: 'ocr-filter-apply'`。
- `commands/review.md` — 增加 Step 3.5 filter 阶段；Step 5 提示过滤摘要；错误码表增加 `OCRP-FILTER-070/071/072`。
- `README.md` — 架构/流程说明增加 filter 阶段；troubleshooting 增加 `OCRP-FILTER-*`。
- `scripts/smoke.sh` — 扩展覆盖 filter 隐藏。

### 不改

- `src/core/model/comment.ts` 的 `LlmComment` 字段。
- `prepare.ts` 参数（filter 不引入新 CLI flag，由 command 编排触发）。

---

## 9. 完成定义

- `code_comment` 写入的每条 comment 含稳定 `comment_id`，stdout 返回该 id。
- 存在 `skills/ocr-review-filter/SKILL.md`，输出符合 `FilterFileResult` schema。
- `ocr-filter-apply` 能校验并落盘 filter 结果，非法输入稳定报错。
- `ocr-aggregate` 默认使用过滤后可见评论，JSON / stdout summary 含 `rawCommentCount` / `commentCount` / `filteredCommentCount` / `filterWarnings`。
- filter 阶段任意失败均可降级，aggregate 仍产出报告。
- `npm test` / `typecheck` / `build` / `smoke` 全部通过。
- README、command、spec、skill 关于 filter 的描述一致，不夸大能力。

---

## 10. 后续 implementation plan 输入

本 spec 批准后，下一步 implementation plan 只覆盖 P1-A1。建议拆分：

1. `comment_id` 生成 + `code_comment` 改造 + 测试；
2. filter model + store helper + 测试；
3. `ocr-filter-apply` CLI + 测试；
4. `ocr-review-filter` skill + 一致性测试；
5. aggregate 读取 filters + 报告字段 + 测试；
6. command 编排 Step 3.5 + README / smoke；
7. 最终验证与文档收口。

P1-A2（line relocation）、P1-A3（severity）、P1-B1（custom rules）等后续单独走 brainstorming → design doc → writing-plans。
