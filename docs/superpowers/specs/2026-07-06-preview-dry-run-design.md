# open-code-review-plugin · Preview / Dry-Run 设计

> 日期：2026-07-06  
> 状态：Approved design direction, ready for implementation planning  
> 范围：`/open-code-review:review --preview|--dry-run` 的最小可用闭环

---

## 0. 摘要

为 `/open-code-review:review` 增加 **preview / dry-run** 模式。该模式只执行 deterministic prepare，不调用 PLAN skill、不派发 reviewer subagent、不执行 filter/relocate、不聚合正式 review report。

目标是让用户在真正触发 LLM review 前确认：

- 将审查哪个 diff range；
- 会进入 review 的文件列表；
- 每个文件的 status、hunk 数、changed lines、命中的规则；
- 被排除的文件及原因；
- 生效的自定义规则来源；
- 实际并发参数。

本设计采用最小方案：**`ocr-prepare` 原生支持 `--preview` / `--dry-run`，`commands/review.md` 在 Step 1 后短路输出摘要。**

---

## 1. 非目标

本轮不做：

- 不生成正式 `report.md` / `report.json`；
- 不新增 `ocr-preview` CLI；
- 不改 `ocr-aggregate` 的 partial/done 语义；
- 不实现 resume/retry previous run；
- 不做 GitHub/GitLab inline comments；
- 不做大 diff 拆分或 token guard。

这些可以在后续增量中独立设计。

---

## 2. 用户行为

### 2.1 支持参数

`ocr-prepare` 和 `/open-code-review:review` 支持：

```bash
--preview
-p
--dry-run
```

三者行为等价：进入 preview/dry-run 模式。

### 2.2 命令示例

```bash
/open-code-review:review --preview
/open-code-review:review -p --from main --to feature/foo
/open-code-review:review --dry-run --rules team-rules.yaml
```

### 2.3 输出语义

当 prepare summary 中 `preview === true || dryRun === true`：

1. 主会话读取 `.ocr-runs/<runId>/context.json`；
2. 输出 preview 摘要；
3. 停止流程；
4. 不进入 plan/reviewer/filter/relocate/aggregate。

如果 `fileCount` 为 0，仍输出 “No changes to review.”，并可附带 runId/contextPath。

---

## 3. 数据模型

### 3.1 ReviewRequest

已有字段：

```ts
preview?: boolean;
dryRun?: boolean;
```

本轮要求：

- `parseArgs(['--preview'])` 设置 `preview = true`；
- `parseArgs(['-p'])` 设置 `preview = true`；
- `parseArgs(['--dry-run'])` 设置 `dryRun = true`；
- 构造 `ReviewRequest` 时透传这两个字段。

### 3.2 ReviewContext

已有字段：

```ts
preview?: boolean;
dryRun?: boolean;
rulesSource?: string;
excludedFiles?: Array<{ path: string; reason: string }>;
```

本轮要求 `buildReviewContext(req)` 在返回 context 时写入：

```ts
preview: req.preview === true,
dryRun: req.dryRun === true,
```

`rulesSource` / `excludedFiles` 继续由 custom rules/file scope 逻辑产生。

### 3.3 prepare stdout summary

`ocr-prepare` stdout JSON 增加：

```jsonc
{
  "runId": "...",
  "fileCount": 3,
  "hunkCount": 5,
  "changedLines": 42,
  "concurrency": 2,
  "preview": true,
  "dryRun": false,
  "rulesSource": ".code-review.yaml",
  "excludedFileCount": 1,
  "contextPath": ".ocr-runs/<runId>/context.json"
}
```

规则：

- `preview` 总是 boolean；
- `dryRun` 总是 boolean；
- `rulesSource` 没有 custom rules 时为 `system`；
- `excludedFileCount` 为 `context.excludedFiles?.length ?? 0`。

---

## 4. Preview 摘要格式

`commands/review.md` 负责文本输出，不新增 CLI。

建议输出：

```md
## Review Preview

**Run**: `<runId>`
**Range**: `<context.range>`
**Mode**: `preview` / `dry-run`
**Rules source**: `<context.rulesSource || "system">`
**Concurrency**: `<summary.concurrency>`

### Files to review (<N>)

| File | Status | Hunks | Changed lines | Rule |
|---|---:|---:|---:|---|
| `src/foo.ts` | modified | 2 | 18 | custom:src/**/*.ts |

### Excluded files (<M>)

| File | Reason |
|---|---|
| `src/foo.test.ts` | default-exclude |
```

Changed lines 按现有 summary 的算法在 command 侧按文件计算即可：每个 hunk 中 `kind !== ' '` 的行数之和。

如果没有 excluded files，可省略 `Excluded files` 段或写 `None`。为降低复杂度，推荐写 `None`，便于用户确认确实无排除。

---

## 5. 代码改动边界

### 5.1 `src/cli/prepare.ts`

改动：

- `ParsedArgs` 保留/增加：
  ```ts
  preview?: boolean;
  dryRun?: boolean;
  ```
- `parseArgs`：
  - `--preview` / `-p` 不再进入 `unsupported`；
  - `--dry-run` 不再进入 `unsupported`；
  - 设置对应 boolean。
- `ReviewRequest` 构造透传 `preview` / `dryRun`。
- summary 增加 `preview` / `dryRun` / `rulesSource` / `excludedFileCount`。

### 5.2 `src/core/context/review_context.ts`

改动：

- return context 时增加：
  ```ts
  preview: req.preview === true,
  dryRun: req.dryRun === true,
  ```

### 5.3 `commands/review.md`

改动：

- Step 1 summary 字段列表加入 `preview` / `dryRun` / `rulesSource` / `excludedFileCount`；
- `fileCount === 0` 处理保持成功跳过；
- 在 Step 1 后增加 preview/dry-run 短路：
  - 读取 context；
  - 输出 preview summary；
  - stop；
- Error handling 中 `OCRP-RUN-011` 不再提 `--preview/--dry-run` 是 P1 flag。

### 5.4 README

改动：

- Commands/Configuration 中将 `--preview` / `--dry-run` 从 unsupported/P1 改为 supported；
- 增加 preview 模式说明；
- 明确 preview 不调用 LLM，不生成正式 report。

---

## 6. 错误处理

- `--preview` / `--dry-run` 不再触发 `OCRP-RUN-011`；
- 参数冲突仍触发 `OCRP-RUN-011`；
- 规则文件错误仍为 hard failure；
- preview 模式下不产生 `OCRP-SKILL-040`、`OCRP-SUB-*`、`OCRP-FILTER-*`、`OCRP-RELOCATE-*`，因为这些阶段不会执行。

---

## 7. 测试策略

### 7.1 CLI parser tests

新增/更新：

- `parseArgs(['--preview'])` → `preview === true`，`unsupported === []`；
- `parseArgs(['-p'])` → `preview === true`；
- `parseArgs(['--dry-run'])` → `dryRun === true`；
- `parseArgs(['--preview', '--dry-run'])` → 两者都 true，允许。

### 7.2 prepare integration tests

新增/更新：

- `ocr-prepare --preview` 成功退出，stdout JSON 包含 `preview: true`；
- `ocr-prepare --dry-run` 成功退出，stdout JSON 包含 `dryRun: true`；
- context.json 中包含对应 boolean；
- `rulesSource` / `excludedFileCount` 出现在 stdout summary。

### 7.3 context tests

新增/更新：

- `buildReviewContext({ preview: true })` 返回 `ctx.preview === true`；
- `buildReviewContext({ dryRun: true })` 返回 `ctx.dryRun === true`。

### 7.4 docs checks

更新 grep/README 检查，确保不存在：

- `--preview` 仍被称为 unsupported；
- `--dry-run` 仍被称为 unsupported；
- `planned for P1 preview mode`。

### 7.5 smoke

在 `scripts/smoke.sh` 中增加最小 preview 检查：

```bash
ocr-prepare --preview
```

断言：

- exit code 0；
- stdout JSON `preview === true`；
- 不要求生成 report。

---

## 8. 验收标准

- `npm run typecheck` 通过；
- `npm test` 通过；
- `npm run build` 通过；
- `npm run smoke` 通过；
- `/open-code-review:review --preview` 不调用 reviewer subagent；
- preview 输出能列出将审查文件、排除文件、规则来源和并发；
- README 与 command 文档不再把 preview/dry-run 标为 P1 unsupported。

---

## 9. 后续扩展

后续可基于本设计扩展：

1. `ocr-preview` CLI：把 preview 渲染从 command 文档迁到 deterministic CLI；
2. preview artifacts：写 `preview.md` / `preview.json`；
3. aggregate dry-run 模式：生成统一 report，但不改变当前 aggregate partial 语义；
4. large diff guard：在 preview 中显示 skipped/too-large 文件。
