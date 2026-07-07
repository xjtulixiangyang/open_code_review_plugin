import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('ocr-post-comments missing --runId exits with error message', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/post_comments.ts'], { encoding: 'utf8' });
  assert.ok(r.stderr.includes('missing --runId'), `stderr: ${r.stderr}`);
  assert.notEqual(r.status, 0);
});
