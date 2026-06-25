import { createHash } from 'node:crypto';

export function hashHunk(
  filePath: string,
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
): string {
  return createHash('sha1')
    .update(`${filePath}:${oldStart}-${oldLines}:${newStart}-${newLines}`)
    .digest('hex')
    .slice(0, 12);
}
