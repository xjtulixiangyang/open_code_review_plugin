import type { FileChange, Hunk, DiffLine } from '../model/request.js';
import type { FileStatus } from '../types.js';
import { hashHunk } from './hunk.js';

const DIFF_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const BINARY = /^Binary files /;

interface InFlight {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  diff: string[];
  hunks: Hunk[];
  current?: {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    oldCursor: number;
    newCursor: number;
    lines: DiffLine[];
  };
}

function freshFile(oldPath: string, newPath: string): InFlight {
  return {
    oldPath,
    newPath,
    status: 'modified',
    diff: [],
    hunks: [],
  };
}

function finalize(f: InFlight, opts: { maxHunkLines: number }): FileChange {
  // 截断检测：任一 hunk lines.length > maxHunkLines 视为 truncated
  let truncated = false;
  for (const h of f.hunks) {
    if (h.lines.length > opts.maxHunkLines) {
      truncated = true;
      h.lines.length = opts.maxHunkLines;
    }
  }
  const path = f.status === 'deleted' ? f.oldPath : f.newPath;
  const out: FileChange = {
    path,
    status: f.status,
    diff: f.diff.join('\n'),
    truncated,
    hunks: f.hunks,
    rulesHit: [],
  };
  if (f.status === 'renamed') out.oldPath = f.oldPath;
  return out;
}

export function parseUnifiedDiff(
  diffText: string,
  opts: { maxHunkLines?: number } = {},
): FileChange[] {
  const maxHunkLines = opts.maxHunkLines ?? 10000;
  const lines = diffText.split('\n');
  const results: FileChange[] = [];
  let cur: InFlight | null = null;

  const flushHunk = () => {
    if (!cur || !cur.current) return;
    const { oldStart, oldLines, newStart, newLines, lines: lns } = cur.current;
    cur.hunks.push({
      id: hashHunk(cur.newPath || cur.oldPath, oldStart, oldLines, newStart, newLines),
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines: lns,
    });
    cur.current = undefined;
  };

  const flushFile = () => {
    flushHunk();
    if (cur) {
      results.push(finalize(cur, { maxHunkLines }));
      cur = null;
    }
  };

  for (const line of lines) {
    const m = DIFF_HEADER.exec(line);
    if (m) {
      flushFile();
      cur = freshFile(m[1], m[2]);
      cur.diff.push(line);
      continue;
    }
    if (!cur) continue;
    cur.diff.push(line);

    if (BINARY.test(line)) {
      cur.status = 'binary';
      continue;
    }
    if (line.startsWith('new file mode ')) {
      cur.status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode ')) {
      cur.status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from ')) {
      cur.oldPath = line.slice('rename from '.length);
      cur.status = 'renamed';
      continue;
    }
    if (line.startsWith('rename to ')) {
      cur.newPath = line.slice('rename to '.length);
      cur.status = 'renamed';
      continue;
    }
    if (line === '--- /dev/null') {
      cur.status = 'added';
      continue;
    }
    if (line === '+++ /dev/null') {
      cur.status = 'deleted';
      continue;
    }
    if (line.startsWith('---') || line.startsWith('+++')) continue;

    const h = HUNK_HEADER.exec(line);
    if (h) {
      flushHunk();
      const oldStart = Number(h[1]);
      const oldLines = h[2] ? Number(h[2]) : 1;
      const newStart = Number(h[3]);
      const newLines = h[4] ? Number(h[4]) : 1;
      if (oldStart === 0 && oldLines === 0 && cur.status === 'modified') cur.status = 'added';
      if (newStart === 0 && newLines === 0 && cur.status === 'modified') cur.status = 'deleted';
      cur.current = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        oldCursor: oldStart,
        newCursor: newStart,
        lines: [],
      };
      continue;
    }

    if (cur.current) {
      const c = cur.current;
      if (line.startsWith('+')) {
        c.lines.push({ kind: '+', oldLineNo: 0, newLineNo: c.newCursor++, text: line.slice(1) });
      } else if (line.startsWith('-')) {
        c.lines.push({ kind: '-', oldLineNo: c.oldCursor++, newLineNo: 0, text: line.slice(1) });
      } else if (line.startsWith(' ')) {
        c.lines.push({
          kind: ' ',
          oldLineNo: c.oldCursor++,
          newLineNo: c.newCursor++,
          text: line.slice(1),
        });
      }
      // 其他 (例如 `\ No newline at end of file`) 忽略
    }
  }

  flushFile();
  return results;
}
