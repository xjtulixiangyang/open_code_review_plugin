import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CommentRecord } from '../../core/model/comment.js';
import type { ReviewContext } from '../../core/model/request.js';
import { githubPostComments } from '../github_post.js';

const ctx: ReviewContext = {
  runId: 'test-1234',
  repoRoot: '/tmp/repo',
  range: 'workspace',
  background: '',
  files: [],
  changeFiles: [],
  excludedFiles: [],
  rulesSource: 'system',
  meta: { generatedAt: '2026-07-10T00:00:00.000Z', pluginVersion: '0.1.0' },
};

const sampleComments: CommentRecord[] = [
  {
    comment_id: 'c1',
    path: 'src/a.ts',
    start_line: 10,
    end_line: 15,
    content: 'Consider using const.',
  },
  {
    comment_id: 'c2',
    path: 'src/b.ts',
    start_line: 20,
    end_line: 22,
    content: 'Typo in variable name.',
    suggestion_code: 'const fixed = true;',
  },
];

test('githubPostComments dryRun returns all comments as skipped', async () => {
  const r = await githubPostComments(sampleComments, ctx, '42', { dryRun: true });
  assert.equal(r.posted, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.skipped, 2);
  assert.deepEqual(r.details, [
    { path: 'src/a.ts', line: 15, ok: false, fallbackLevel: 0 },
    { path: 'src/b.ts', line: 22, ok: false, fallbackLevel: 0 },
  ]);
});

test('githubPostComments empty comments returns zeros', async () => {
  const r = await githubPostComments([], ctx, '42');
  assert.deepEqual(r, { posted: 0, failed: 0, skipped: 0, details: [] });
});
