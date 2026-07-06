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
