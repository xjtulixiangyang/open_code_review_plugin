import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import type { CommentRecord } from '../../core/model/comment.js';
import type { ReviewContext } from '../../core/model/request.js';
import { gitlabPostComments } from '../gitlab_post.js';

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
];

test('gitlabPostComments dryRun returns all comments as skipped', async () => {
  const r = await gitlabPostComments(sampleComments, ctx, '42', 'fake-token', '12345', { dryRun: true });
  assert.equal(r.posted, 0);
  assert.equal(r.failed, 0);
  assert.equal(r.skipped, 1);
  assert.deepEqual(r.details, [
    { path: 'src/a.ts', line: 15, ok: false, fallbackLevel: 0 },
  ]);
});

test('gitlabPostComments empty comments returns zeros', async () => {
  const r = await gitlabPostComments([], ctx, '42', 'fake-token', '12345');
  assert.deepEqual(r, { posted: 0, failed: 0, skipped: 0, details: [] });
});

test('gitlabPostComments treats HTTP error bodies from curl as failed posts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-fake-curl-'));
  const fakeCurl = join(dir, 'curl');
  await writeFile(fakeCurl, `#!/bin/sh
case "$*" in
  *versions*)
    printf '[{"base_commit_sha":"base","start_commit_sha":"start","head_commit_sha":"head"}]'
    exit 0
    ;;
  *--fail-with-body*)
    printf '{"message":"400 Bad request"}'
    exit 22
    ;;
  *)
    printf '{"message":"400 Bad request"}'
    exit 0
    ;;
esac
`, 'utf8');
  await chmod(fakeCurl, 0o755);

  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${oldPath ?? ''}`;
  try {
    const r = await gitlabPostComments(sampleComments, ctx, '42', 'fake-token', '12345', { retry: 0 });
    assert.equal(r.posted, 0);
    assert.equal(r.failed, 1);
    assert.equal(r.details[0].ok, false);
  } finally {
    process.env.PATH = oldPath;
  }
});
