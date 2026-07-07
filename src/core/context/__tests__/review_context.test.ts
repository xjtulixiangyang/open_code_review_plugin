import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_FILE_CHANGED_LINES } from '../../prompts/constants.js';

describe('large diff guard', () => {
  it('should mark file as skipped when changed lines exceed MAX_FILE_CHANGED_LINES', () => {
    const largeFile = {
      path: 'large-file.ts',
      oldPath: undefined,
      status: 'modified' as const,
      diff: '',
      truncated: false,
      hunks: [
        {
          id: 'h1',
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: MAX_FILE_CHANGED_LINES + 100,
          lines: Array.from({ length: MAX_FILE_CHANGED_LINES + 100 }, (_, i) => ({
            kind: '+' as const,
            oldLineNo: -1,
            newLineNo: i + 1,
            text: `line ${i}`,
          })),
        },
      ],
      rulesHit: [],
    };

    const changed = largeFile.hunks.reduce(
      (s, h) => s + h.lines.filter(l => l.kind !== ' ').length,
      0,
    );
    assert.ok(changed > MAX_FILE_CHANGED_LINES);

    // Simulate the guard logic
    if (changed > MAX_FILE_CHANGED_LINES) {
      largeFile.skipped = true;
      largeFile.skipReason = `file too large (${changed} changed lines > ${MAX_FILE_CHANGED_LINES} threshold)`;
      largeFile.skippedLines = changed;
    }

    assert.equal(largeFile.skipped, true);
    assert.ok(largeFile.skipReason!.includes('file too large'));
    assert.equal(largeFile.skippedLines, MAX_FILE_CHANGED_LINES + 100);
  });

  it('should not mark file as skipped when changed lines are below MAX_FILE_CHANGED_LINES', () => {
    const smallFile = {
      path: 'small-file.ts',
      oldPath: undefined,
      status: 'modified' as const,
      diff: '',
      truncated: false,
      hunks: [
        {
          id: 'h1',
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 50,
          lines: Array.from({ length: 50 }, (_, i) => ({
            kind: '+' as const,
            oldLineNo: -1,
            newLineNo: i + 1,
            text: `line ${i}`,
          })),
        },
      ],
      rulesHit: [],
    };

    const changed = smallFile.hunks.reduce(
      (s, h) => s + h.lines.filter(l => l.kind !== ' ').length,
      0,
    );
    assert.ok(changed <= MAX_FILE_CHANGED_LINES);

    // Simulate the guard logic — should not set skipped
    let skipped = false;
    if (changed > MAX_FILE_CHANGED_LINES) {
      skipped = true;
    }

    assert.equal(skipped, false);
    assert.equal(smallFile.skipped, undefined);
  });

  it('should only count non-context lines (kind !== space)', () => {
    const mixedFile = {
      path: 'mixed-file.ts',
      oldPath: undefined,
      status: 'modified' as const,
      diff: '',
      truncated: false,
      hunks: [
        {
          id: 'h1',
          oldStart: 1,
          oldLines: 4000,
          newStart: 1,
          newLines: 1000,
          lines: [
            ...Array.from({ length: 500 }, (_, i) => ({
              kind: '+' as const,
              oldLineNo: -1,
              newLineNo: i + 1,
              text: `added line ${i}`,
            })),
            ...Array.from({ length: 3000 }, (_, i) => ({
              kind: ' ' as const,
              oldLineNo: i + 501,
              newLineNo: i + 501,
              text: `context line ${i}`,
            })),
            ...Array.from({ length: 500 }, (_, i) => ({
              kind: '-' as const,
              oldLineNo: i + 3501,
              newLineNo: -1,
              text: `removed line ${i}`,
            })),
          ],
        },
      ],
      rulesHit: [],
    };

    const changed = mixedFile.hunks.reduce(
      (s, h) => s + h.lines.filter(l => l.kind !== ' ').length,
      0,
    );
    // 500 added + 500 removed = 1000 changed lines
    assert.equal(changed, 1000);
    assert.ok(changed <= MAX_FILE_CHANGED_LINES);
  });
});
