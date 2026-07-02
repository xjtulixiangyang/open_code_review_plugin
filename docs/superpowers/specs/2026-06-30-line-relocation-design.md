# open-code-review-plugin · line resolver / RE_LOCATION_TASK 设计

> 日期：2026-06-30
> 状态：Approved for implementation by continuous P1 roadmap instruction
> 基于：`docs/superpowers/specs/2026-06-27-p0-closeout-and-p1-roadmap-design.md` §7.1 P1-A2
> 范围：P1-A2，在 aggregate 前统一 normalize comment line range；优先 deterministic resolver，LLM relocation 作为 soft fallback 编排点

---

## 0. 摘要

本设计为 review comments 增加 line resolver / relocation 阶段，目标是把 reviewer 写入的 `start_line` / `end_line` 规范化到当前 diff 的新增代码行或新文件行，减少评论落在删除代码、上下文行或过期行号上的情况，并为后续 GitHub/GitLab inline comments 铺路。

核心原则：

- **不改写原始 `comments.jsonl`**：原始 reviewer 输出保留；relocation 是附加层。
- **确定性优先**：先用 `existing_code`、diff hunk 和新文件内容解析位置。
- **LLM 只做最后 fallback**：确定性解析失败时可由 `RE_LOCATION_TASK` 判断；失败仍降级使用原位置。
- **aggregate 前统一 normalize**：最终 Markdown/JSON 使用 normalized comments，并保留 relocation 审计摘要。

---

## 1. 背景与现状

当前 reviewer 通过 `code_comment` 写入 `CommentRecord`：

```ts
export interface CommentRecord extends LlmComment {
  comment_id: string;
  _meta?: { subagent?: string; ts?: string };
}
```

P1-A1 已增加过滤层：`ocr-aggregate` 读取 `comments.jsonl` + `filters/`，隐藏被过滤评论。当前仍存在两个位置问题：

1. reviewer 可能把评论落在删除行、上下文行或不在 diff 新增范围内的行；
2. 后续 PR inline comments 需要稳定的新文件行号，不能依赖模型随手给出的范围。

P1-A2 要在 aggregate 前对可见评论做位置规范化。

---

## 2. 非目标

本 spec 不实现：

- severity / priority 分类；
- GitHub/GitLab 发布；
- 跨文件 comment relocation；
- 对 comment content 的改写；
- retry/resume；
- 大 diff chunking。

relocation 只改变 `start_line` / `end_line` 的最终展示位置，并记录审计原因。

---

## 3. 数据模型

### 3.1 RelocationDecision

新增 `src/core/model/relocation.ts`：

```ts
export type RelocationSource =
  | 'unchanged'
  | 'existing_code_diff'
  | 'existing_code_file'
  | 'line_clamped'
  | 'llm_relocation'
  | 'fallback_original';

export interface RelocationDecision {
  comment_id: string;
  original_start_line: number;
  original_end_line: number;
  resolved_start_line: number;
  resolved_end_line: number;
  source: RelocationSource;
  reason: string;
}

export interface RelocationFileResult {
  path: string;
  decisions: RelocationDecision[];
  _meta?: {
    source: 'line_resolver' | 're_location_task';
    subagent?: string;
    ts?: string;
  };
}

export interface RelocationWarning {
  kind: string;
  path?: string;
  comment_id?: string;
  detail: string;
}

export interface ReadRelocationResultsOutput {
  results: RelocationFileResult[];
  warnings: RelocationWarning[];
}
```

### 3.2 文件布局

每个文件一个 relocation 审计产物：

```text
.ocr-runs/<runId>/relocations/<safePathKey(file)>.json
```

示例：

```json
{
  "path": "src/a.ts",
  "decisions": [
    {
      "comment_id": "c-4f9163b1-7d2e-4d52-9be2-a8474ccf03df",
      "original_start_line": 10,
      "original_end_line": 10,
      "resolved_start_line": 14,
      "resolved_end_line": 15,
      "source": "existing_code_diff",
      "reason": "Matched existing_code against added lines in diff hunk."
    }
  ],
  "_meta": { "source": "line_resolver", "ts": "..." }
}
```

---

## 4. Deterministic resolver

新增 `src/core/relocation/resolve.ts`，核心接口：

```ts
export function resolveCommentLocation(
  file: FileChange,
  comment: CommentRecord,
  newFileText?: string,
): RelocationDecision
```

解析顺序：

1. **原位置已在新增行范围内**：若 `[start_line, end_line]` 全部落在 diff 的 `+` 行或 context/new line 范围内，并且不落在删除行，返回 `unchanged`。
2. **`existing_code` 匹配 diff 新增行**：若 comment 带 `existing_code`，在该文件所有 hunk 的 `+` / ` ` 行构成的新侧文本中查找连续片段，返回匹配行范围，source=`existing_code_diff`。
3. **`existing_code` 匹配新文件内容**：若提供 `newFileText`，在新文件全文中查找连续片段，返回 source=`existing_code_file`。
4. **line clamp**：若原行号超出新侧范围，但文件有 hunk，则 clamp 到最近的新侧有效行，source=`line_clamped`。
5. **fallback original**：无法解析时保留原行号，source=`fallback_original`。

匹配规则：

- 先做 exact line sequence match；
- 忽略前后空白进行第二轮 match；
- 多处匹配时选择距离原 `start_line` 最近的匹配；
- resolved range 必须满足 `start <= end`，且行号为正整数。

### 新文件内容读取

新增 CLI `ocr-relocate-apply` 可选择读取工作区文件内容：

- 对 workspace/staged 模式，优先读取 repoRoot 下当前文件；
- 对 commit/range 模式，P1 首版不调用 git show 取目标版本；没有可读文件时跳过 `existing_code_file`，仍可用 diff hunk 解析。

---

## 5. ocr-relocate-apply CLI

新增 `src/cli/relocate_apply.ts`，映射到 `bin/ocr-relocate-apply`：

```bash
ocr-relocate-apply --runId <runId> --path <file>
```

职责：

1. 读取 `context.json`，找到目标 `FileChange`；
2. 读取 `comments.jsonl`，筛选该 path comments；
3. 读取 `filters/`，跳过已隐藏 comments；
4. 对可见 comments 调用 `resolveCommentLocation()`；
5. 写入 `.ocr-runs/<runId>/relocations/<safePathKey>.json`；
6. stdout 输出 `{ runId, path, relocatedCount, unchangedCount, fallbackCount, relocationPath }`。

不直接改写 `comments.jsonl`。

---

## 6. RE_LOCATION_TASK（LLM fallback）

P1-A2 首版预留 `skills/ocr-relocate/SKILL.md`，用于确定性 resolver 无法解析时的人类语言判断。主会话只在 `fallback_original` 且 comment 仍可见时调用。

输入：

- runId、currentFilePath、currentFileDiff；
- comment（含 comment_id、content、existing_code、原 line range）；
- deterministic failure reason。

输出：

```json
{
  "path": "src/a.ts",
  "decisions": [
    {
      "comment_id": "c-...",
      "resolved_start_line": 14,
      "resolved_end_line": 14,
      "reason": "The issue corresponds to the added null check on line 14."
    }
  ]
}
```

P1-A2 implementation 可先实现 deterministic resolver + CLI + aggregate 应用，并在 command/skill 中定义 LLM fallback 编排点；若 LLM fallback 输出不可解析，仍保留 deterministic fallback。

---

## 7. Aggregate 应用 relocation

`ocr-aggregate` 当前流程：raw comments → filters → visible comments → report。

增加 relocation：

```text
raw comments → apply filters → visible comments → apply relocations → report
```

规则：

- relocation 只应用于 visible comments；
- 找不到 relocation decision 的 comment 保留原位置；
- relocation decision 的 `comment_id` 不存在或 path mismatch 时记 `relocationWarnings`；
- `report.json.comments[]` 输出 normalized `start_line` / `end_line`；
- summary 增加：
  - `relocated_comments`
  - `relocation_fallbacks`
- top-level 可选：`relocation_warnings`。

Markdown 在 header 增加：

```text
**Relocated**: X (fallback Y)
```

仅当 X 或 Y 大于 0 时显示。

---

## 8. Command 编排

`commands/review.md` 在 Step 3.5 filter 后、Step 4 aggregate 前插入 Step 3.6：

```markdown
### Step 3.6 — Line relocation

For each file with visible comments, run:

ocr-relocate-apply --runId <runId> --path <currentFilePath>

If it fails, continue; aggregate will use original line ranges and mention relocation warning.
If deterministic relocation reports fallback comments, optionally invoke `ocr-relocate` skill for those comments and apply the returned decisions with `ocr-relocate-apply --input <json>`.
```

P1 首版为了稳定，CLI 不依赖模型即可完成基本 relocation；LLM fallback 是软增强。

---

## 9. 错误处理

新增错误码：

- `OCRP-RELOCATE-080`：deterministic relocation failed for a file; aggregate uses original line ranges.
- `OCRP-RELOCATE-081`：relocation input references path outside review context.
- `OCRP-RELOCATE-082`：relocation decision malformed.

所有 relocation 错误均不阻断 aggregate。

---

## 10. 测试策略

TDD 覆盖：

1. `resolveCommentLocation()`：
   - 原位置新增行 → unchanged；
   - `existing_code` 匹配 diff 新侧 → relocated；
   - `existing_code` 匹配新文件全文 → relocated；
   - 超出范围 → clamped；
   - 无法解析 → fallback_original。
2. relocation store：roundtrip、missing dir、malformed file warning。
3. `ocr-relocate-apply`：生成 relocation audit，跳过 filtered comments。
4. aggregate：应用 relocation 后 report line range 改变；warnings 进入 JSON。
5. smoke：写一条故意行号错误但带 `existing_code` 的 comment，relocate 后报告显示正确行号。

---

## 11. 文件清单

新增：

- `src/core/model/relocation.ts`
- `src/core/relocation/resolve.ts`
- `src/core/relocation/__tests__/resolve.test.ts`
- `src/core/runs/__tests__/store_relocation.test.ts`
- `src/cli/relocate_apply.ts`
- `src/cli/__tests__/relocate_apply.test.ts`
- `skills/ocr-relocate/SKILL.md`

修改：

- `src/core/runs/store.ts`
- `src/cli/aggregate.ts`
- `src/core/report/json.ts`
- `src/core/report/markdown.ts`
- `scripts/shebang.mjs`
- `scripts/smoke.sh`
- `commands/review.md`
- `README.md`

---

## 12. 完成定义

- 可见评论在 aggregate 前被统一 normalize line range；
- `existing_code` 可在 diff 新侧或新文件内容中定位；
- relocation 审计产物可读且不改写原始 comments；
- aggregate 输出 normalized comments、relocation summary 和 warnings；
- deterministic resolver 失败不会阻断报告；
- `npm test` / `npm run typecheck` / `npm run build` / `npm run smoke` 全部通过。
