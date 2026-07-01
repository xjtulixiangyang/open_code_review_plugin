import { randomUUID } from 'node:crypto';
import { appendComment } from '../runs/store.js';
import type { CommentRecord } from '../model/comment.js';

/**
 * Mirrors open-code-review ParseComments. Returns parsed CommentRecords (with
 * generated comment_id + _meta) and an upstream-style error string when input
 * is missing or yields no valid comments.
 */
export function parseComments(args: Record<string, unknown>): {
  records: CommentRecord[];
  error?: string;
} {
  const path = typeof args['path'] === 'string' ? (args['path'] as string) : '';
  if (!path) return { records: [], error: "Error: 'path' is required" };

  const subagent = typeof args['subagent'] === 'string' ? (args['subagent'] as string) : 'unknown';

  let rawComments: unknown;
  if (Array.isArray(args['comments'])) {
    rawComments = args['comments'];
  } else if (typeof args['comments'] === 'string' && (args['comments'] as string) !== '') {
    try {
      rawComments = JSON.parse(args['comments'] as string);
    } catch (err) {
      return { records: [], error: `Error: failed to parse 'comments' JSON string: ${(err as Error).message}` };
    }
  } else {
    const raw = JSON.stringify(args);
    return { records: [], error: `Error: 'comments' array is required. Got args: ${raw}` };
  }

  if (!Array.isArray(rawComments)) {
    const raw = JSON.stringify(args);
    return { records: [], error: `Error: 'comments' array is required. Got args: ${raw}` };
  }

  const records: CommentRecord[] = [];
  for (const item of rawComments) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const content = typeof obj['content'] === 'string' ? (obj['content'] as string) : '';
    const start = toLineNumber(obj['start_line']);
    const end = toLineNumber(obj['end_line']);
    if (!content || start === null || end === null) continue;
    const rec: CommentRecord = {
      comment_id: `c-${randomUUID()}`,
      path,
      start_line: start,
      end_line: end,
      content,
    };
    if (typeof obj['suggestion_code'] === 'string') rec.suggestion_code = obj['suggestion_code'] as string;
    if (typeof obj['existing_code'] === 'string') rec.existing_code = obj['existing_code'] as string;
    if (typeof obj['thinking'] === 'string') rec.thinking = obj['thinking'] as string;
    rec._meta = { subagent, ts: new Date().toISOString() };
    records.push(rec);
  }
  if (records.length === 0) return { records: [], error: 'Error: no valid comments found' };
  return { records };
}

function toLineNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Appends each record to comments.jsonl, returning the generated comment_ids. */
export async function persistComments(runId: string, records: CommentRecord[]): Promise<string[]> {
  const ids: string[] = [];
  for (const rec of records) {
    await appendComment(runId, rec);
    ids.push(rec.comment_id);
  }
  return ids;
}
