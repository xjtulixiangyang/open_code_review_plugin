import type { ReviewContext } from '../model/request.js';
import type { CommentRecord, LlmComment } from '../model/comment.js';
import type { FilterWarning } from '../model/filter.js';

export type ReportComment = LlmComment & { comment_id?: string };

/**
 * OCR-compatible report JSON. 字段与 OCR `cmd/opencodereview/output.go::outputJSONWithWarnings` 对齐。
 */
export interface ReportJson {
  status: 'success' | 'skipped' | 'completed_with_warnings' | 'completed_with_errors';
  message?: string;
  summary: {
    files_reviewed: number;
    comments: number;
    raw_comments: number;
    filtered_comments: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    duration_ms: number;
  };
  comments: ReportComment[];
  warnings: Array<{ path: string; reason: string }>;
  filter_warnings?: FilterWarning[];
}

export function renderJsonReport(
  ctx: ReviewContext,
  comments: CommentRecord[],
  opts: { partialFiles: string[]; durationMs: number; rawCommentCount?: number; filteredCommentCount?: number; filterWarnings?: FilterWarning[] },
): string {
  const lite: ReportComment[] = comments.map((c) => {
    const { _meta, ...rest } = c;
    return rest;
  });
  const r: ReportJson = {
    status: opts.partialFiles.length > 0 ? 'completed_with_warnings' : 'success',
    summary: {
      files_reviewed: ctx.files.length,
      comments: lite.length,
      raw_comments: opts.rawCommentCount ?? lite.length,
      filtered_comments: opts.filteredCommentCount ?? 0,
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
  if (opts.filterWarnings && opts.filterWarnings.length > 0) r.filter_warnings = opts.filterWarnings;
  return JSON.stringify(r, null, 2);
}
