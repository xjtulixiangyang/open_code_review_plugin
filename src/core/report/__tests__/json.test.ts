import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderJsonReport } from '../json.js';
import type { ReviewContext } from '../../model/request.js';
import type { CommentRecord } from '../../model/comment.js';

const CTX: ReviewContext = {
  runId: 'r1',
  repoRoot: '/repo',
  range: 'workspace',
  background: '',
  files: [
    { path: 'src/a.ts', status: 'modified', diff: '', truncated: false, hunks: [], rulesHit: [] },
    { path: 'src/b.ts', status: 'modified', diff: '', truncated: false, hunks: [], rulesHit: [] },
  ],
  changeFiles: ['src/a.ts', 'src/b.ts'],
  meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
};

const COMMENTS: CommentRecord[] = [
  { path: 'src/a.ts', start_line: 1, end_line: 1, content: 'issue', _meta: { subagent: 'r1', ts: 't1' } },
];

test('renderJsonReport uses success status when all files complete', () => {
  const json = JSON.parse(renderJsonReport(CTX, COMMENTS, { partialFiles: [], durationMs: 12 }));

  assert.equal(json.status, 'ok');
  assert.equal(json.summary.files_reviewed, 2);
  assert.equal(json.summary.comments, 1);
  assert.equal(json.summary.total_tokens, 0);
  assert.deepEqual(json.warnings, []);
});

test('renderJsonReport uses completed_with_warnings when files are partial', () => {
  const json = JSON.parse(renderJsonReport(CTX, [], { partialFiles: ['src/b.ts'], durationMs: 12 }));

  assert.equal(json.status, 'completed_with_warnings');
  assert.deepEqual(json.warnings, [{ path: 'src/b.ts', reason: 'subagent did not call task_done' }]);
});
