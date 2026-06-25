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
