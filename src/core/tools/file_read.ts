import { readContextFileLines } from './context_file_reader.js';
import type { ReviewContext } from '../model/request.js';

const FILE_READ_MAX_LINES = 500;

function asPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

export async function readFile(args: Record<string, unknown>, ctx: ReviewContext): Promise<string> {
  const filePath = typeof args['file_path'] === 'string' ? args['file_path'] : '';
  if (filePath === '') return 'Error: file_path is required';

  const startLine = asPositiveInteger(args['start_line'], 1);
  const endLineRaw = asPositiveInteger(args['end_line'], 0);
  let maxLines = FILE_READ_MAX_LINES;

  if (endLineRaw > 0) {
    const requested = endLineRaw - startLine + 1;
    if (requested <= 0) {
      throw new Error(`invalid line range: start_line ${startLine} is greater than end_line ${endLineRaw}`);
    }
    if (requested < maxLines) maxLines = requested;
  }

  let result: { lines: string[]; totalLines: number };
  try {
    result = await readContextFileLines(ctx, filePath, startLine, maxLines);
  } catch (err) {
    throw new Error(`file ${JSON.stringify(filePath)} not found: ${(err as Error).message}`);
  }

  if (result.totalLines > 0 && startLine - 1 >= result.totalLines) {
    throw new Error(`file ${JSON.stringify(filePath)} has only ${result.totalLines} lines, requested range ${startLine}-${endLineRaw}`);
  }

  let effectiveEnd = result.totalLines;
  if (endLineRaw > 0 && endLineRaw < effectiveEnd) effectiveEnd = endLineRaw;
  const fullRange = effectiveEnd - (startLine - 1);
  const truncated = fullRange > FILE_READ_MAX_LINES;
  const displayEnd = startLine - 1 + result.lines.length;

  let out = '';
  out += `File: ${filePath} (Total lines: ${result.totalLines})\n`;
  out += `IS_TRUNCATED: ${truncated}\n`;
  out += `LINE_RANGE: ${startLine}-${displayEnd}\n`;
  for (let i = 0; i < result.lines.length; i++) {
    out += `${startLine + i}|${result.lines[i]}\n`;
  }
  if (truncated) {
    out += `\nNote: Results truncated to ${FILE_READ_MAX_LINES} lines. Please narrow your line range.\n`;
  }
  return out;
}
