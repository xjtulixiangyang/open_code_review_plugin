import type { ReviewContext } from '../model/request.js';
import type { CommentRecord, LlmComment } from '../model/comment.js';
import type { FilterWarning } from '../model/filter.js';
import type { RelocationWarning } from '../model/relocation.js';

export type ReportComment = LlmComment & { comment_id?: string };
export interface ReportWarning { path: string; reason: string }

function partialWarnings(partialFiles: string[]): ReportWarning[] {
  return partialFiles.map((p) => ({ path: p, reason: 'subagent did not call task_done' }));
}

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
    relocated_comments?: number;
    relocation_fallbacks?: number;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    duration_ms: number;
  };
  comments: ReportComment[];
  warnings: ReportWarning[];
  filter_warnings?: FilterWarning[];
  relocation_warnings?: RelocationWarning[];
}

export function renderJsonReport(
  ctx: ReviewContext,
  comments: CommentRecord[],
  opts: {
    partialFiles: string[];
    durationMs: number;
    rawCommentCount?: number;
    filteredCommentCount?: number;
    filterWarnings?: FilterWarning[];
    relocatedCount?: number;
    relocationFallbackCount?: number;
    relocationWarnings?: RelocationWarning[];
    warnings?: ReportWarning[];
  },
): string {
  const lite: ReportComment[] = comments.map((c) => {
    const { _meta, ...rest } = c;
    return rest;
  });
  const warnings = [
    ...partialWarnings(opts.partialFiles),
    ...(opts.warnings ?? []),
  ];
  const r: ReportJson = {
    status: opts.partialFiles.length > 0 ? 'completed_with_warnings' : 'success',
    summary: {
      files_reviewed: ctx.files.length,
      comments: lite.length,
      raw_comments: opts.rawCommentCount ?? lite.length,
      filtered_comments: opts.filteredCommentCount ?? 0,
      relocated_comments: opts.relocatedCount ?? 0,
      relocation_fallbacks: opts.relocationFallbackCount ?? 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      duration_ms: opts.durationMs,
    },
    comments: lite,
    warnings,
  };
  if (opts.filterWarnings && opts.filterWarnings.length > 0) r.filter_warnings = opts.filterWarnings;
  if (opts.relocationWarnings && opts.relocationWarnings.length > 0) r.relocation_warnings = opts.relocationWarnings;
  return JSON.stringify(r, null, 2);
}
