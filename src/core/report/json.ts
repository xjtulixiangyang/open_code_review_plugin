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
