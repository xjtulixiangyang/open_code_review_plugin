import type { CommentRecord } from '../model/comment.js';
import type { FileChange } from '../model/request.js';
import type { RelocationDecision } from '../model/relocation.js';

interface LineEntry {
  lineNo: number;
  text: string;
}

function decision(
  comment: CommentRecord,
  resolvedStart: number,
  resolvedEnd: number,
  source: RelocationDecision['source'],
  reason: string,
): RelocationDecision {
  return {
    comment_id: comment.comment_id,
    original_start_line: comment.start_line,
    original_end_line: comment.end_line,
    resolved_start_line: resolvedStart,
    resolved_end_line: resolvedEnd,
    source,
    reason,
  };
}

function newSideLines(file: FileChange): LineEntry[] {
  const out: LineEntry[] = [];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if ((line.kind === '+' || line.kind === ' ') && line.newLineNo > 0) {
        out.push({ lineNo: line.newLineNo, text: line.text });
      }
    }
  }
  return out.sort((a, b) => a.lineNo - b.lineNo);
}

function rangeWithinNewSide(lines: LineEntry[], start: number, end: number): boolean {
  if (start <= 0 || end < start) return false;
  const valid = new Set(lines.map((line) => line.lineNo));
  for (let n = start; n <= end; n++) {
    if (!valid.has(n)) return false;
  }
  return true;
}

function targetLines(code: string): string[] {
  const lines = code.split('\n');
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
}

function trimmedTargetLines(code: string): string[] {
  return targetLines(code).map((line) => line.trim());
}

function findLineSequence(lines: LineEntry[], code: string, near: number): { start: number; end: number } | null {
  const targetExact = targetLines(code);
  const targetTrimmed = trimmedTargetLines(code);
  const candidates: Array<{ start: number; end: number; distance: number }> = [];

  for (const target of [targetExact, targetTrimmed]) {
    if (target.length === 0) continue;
    for (let i = 0; i <= lines.length - target.length; i++) {
      let ok = true;
      for (let j = 0; j < target.length; j++) {
        const actual = target === targetExact ? lines[i + j].text : lines[i + j].text.trim();
        if (actual !== target[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        candidates.push({
          start: lines[i].lineNo,
          end: lines[i + target.length - 1].lineNo,
          distance: Math.abs(lines[i].lineNo - near),
        });
      }
    }
    if (candidates.length > 0) break;
  }

  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0] ?? null;
}

function fileTextLines(text: string): LineEntry[] {
  const lines = text.split('\n');
  const contentLines = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
  return contentLines.map((line, index) => ({ lineNo: index + 1, text: line }));
}

function nearestLine(lines: LineEntry[], target: number): number | null {
  if (lines.length === 0) return null;
  let best = lines[0].lineNo;
  let bestDistance = Math.abs(best - target);
  for (const line of lines.slice(1)) {
    const distance = Math.abs(line.lineNo - target);
    if (distance < bestDistance || (distance === bestDistance && line.lineNo > best)) {
      best = line.lineNo;
      bestDistance = distance;
    }
  }
  return best;
}

export function resolveCommentLocation(
  file: FileChange,
  comment: CommentRecord,
  newFileText?: string,
): RelocationDecision {
  const lines = newSideLines(file);

  if (rangeWithinNewSide(lines, comment.start_line, comment.end_line)) {
    return decision(comment, comment.start_line, comment.end_line, 'unchanged', 'Original range is already on the new side of the diff.');
  }

  if (comment.existing_code) {
    const diffMatch = findLineSequence(lines, comment.existing_code, comment.start_line);
    if (diffMatch) {
      return decision(comment, diffMatch.start, diffMatch.end, 'existing_code_diff', 'Matched existing_code against new-side diff lines.');
    }

    if (newFileText) {
      const fileMatch = findLineSequence(fileTextLines(newFileText), comment.existing_code, comment.start_line);
      if (fileMatch) {
        return decision(comment, fileMatch.start, fileMatch.end, 'existing_code_file', 'Matched existing_code against new file content.');
      }
    }
  }

  const clamped = nearestLine(lines, comment.start_line);
  if (clamped !== null) {
    return decision(comment, clamped, clamped, 'line_clamped', 'Clamped original range to the nearest new-side diff line.');
  }

  return decision(comment, comment.start_line, comment.end_line, 'fallback_original', 'No new-side line could be resolved; kept original range.');
}
