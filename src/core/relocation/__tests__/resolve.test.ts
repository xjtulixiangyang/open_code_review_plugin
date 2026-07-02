import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveCommentLocation } from '../resolve.js';
import type { FileChange } from '../../model/request.js';
import type { CommentRecord } from '../../model/comment.js';

const FILE: FileChange = {
  path: 'src/a.ts',
  status: 'modified',
  diff: '',
  truncated: false,
  rulesHit: [],
  hunks: [
    {
      id: 'h1',
      oldStart: 10,
      oldLines: 3,
      newStart: 20,
      newLines: 4,
      lines: [
        { kind: ' ', oldLineNo: 10, newLineNo: 20, text: 'const keep = true;' },
        { kind: '-', oldLineNo: 11, newLineNo: 0, text: 'const oldValue = 1;' },
        { kind: '+', oldLineNo: 0, newLineNo: 21, text: 'const newValue = compute();' },
        { kind: '+', oldLineNo: 0, newLineNo: 22, text: 'return newValue;' },
        { kind: ' ', oldLineNo: 12, newLineNo: 23, text: '}' },
      ],
    },
  ],
};

function comment(partial: Partial<CommentRecord>): CommentRecord {
  return {
    comment_id: partial.comment_id ?? 'c-1',
    path: partial.path ?? 'src/a.ts',
    start_line: partial.start_line ?? 1,
    end_line: partial.end_line ?? partial.start_line ?? 1,
    content: partial.content ?? 'issue',
    existing_code: partial.existing_code,
  };
}

test('keeps line range unchanged when it already points to added lines', () => {
  const result = resolveCommentLocation(FILE, comment({ start_line: 21, end_line: 22 }));

  assert.equal(result.source, 'unchanged');
  assert.equal(result.resolved_start_line, 21);
  assert.equal(result.resolved_end_line, 22);
});

test('relocates by matching existing_code against diff new-side lines', () => {
  const result = resolveCommentLocation(FILE, comment({
    start_line: 99,
    end_line: 99,
    existing_code: 'const newValue = compute();\nreturn newValue;',
  }));

  assert.equal(result.source, 'existing_code_diff');
  assert.equal(result.resolved_start_line, 21);
  assert.equal(result.resolved_end_line, 22);
});

test('relocates by matching existing_code against new file text', () => {
  const result = resolveCommentLocation(FILE, comment({
    start_line: 99,
    end_line: 99,
    existing_code: 'function outside() {\n  return true;\n}',
  }), 'const keep = true;\nfunction outside() {\n  return true;\n}\n');

  assert.equal(result.source, 'existing_code_file');
  assert.equal(result.resolved_start_line, 2);
  assert.equal(result.resolved_end_line, 4);
});

test('clamps an invalid line to the nearest new-side hunk line', () => {
  const result = resolveCommentLocation(FILE, comment({ start_line: 999, end_line: 999 }));

  assert.equal(result.source, 'line_clamped');
  assert.equal(result.resolved_start_line, 23);
  assert.equal(result.resolved_end_line, 23);
});


test('matches existing_code with blank lines against diff new-side lines', () => {
  const file: FileChange = {
    ...FILE,
    hunks: [{
      ...FILE.hunks[0],
      lines: [
        { kind: '+', oldLineNo: 0, newLineNo: 30, text: 'if (ready) {' },
        { kind: '+', oldLineNo: 0, newLineNo: 31, text: '' },
        { kind: '+', oldLineNo: 0, newLineNo: 32, text: '  run();' },
        { kind: '+', oldLineNo: 0, newLineNo: 33, text: '}' },
      ],
    }],
  };

  const result = resolveCommentLocation(file, comment({
    start_line: 99,
    end_line: 99,
    existing_code: 'if (ready) {\n\n  run();\n}',
  }));

  assert.equal(result.source, 'existing_code_diff');
  assert.equal(result.resolved_start_line, 30);
  assert.equal(result.resolved_end_line, 33);
});

test('falls back to original line when no new-side lines exist', () => {
  const deletedFile: FileChange = { ...FILE, hunks: [{ ...FILE.hunks[0], lines: [{ kind: '-', oldLineNo: 1, newLineNo: 0, text: 'gone' }] }] };
  const result = resolveCommentLocation(deletedFile, comment({ start_line: 7, end_line: 8 }));

  assert.equal(result.source, 'fallback_original');
  assert.equal(result.resolved_start_line, 7);
  assert.equal(result.resolved_end_line, 8);
});
