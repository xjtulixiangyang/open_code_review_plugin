import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function makeRun(): { runId: string } {
  const runId = `test-post-${process.pid}-${Date.now()}`;
  const runDir = join(process.cwd(), '.ocr-runs', runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, 'context.json'), JSON.stringify({
    runId,
    repoRoot: process.cwd(),
    range: 'workspace',
    background: '',
    files: [],
    changeFiles: [],
    meta: { generatedAt: '2026-07-10T00:00:00.000Z', pluginVersion: '0.1.0' },
  }));
  writeFileSync(join(runDir, 'comments.jsonl'), JSON.stringify({
    comment_id: 'c1',
    path: 'src/a.ts',
    start_line: 10,
    end_line: 12,
    content: 'Consider simplifying this branch.',
    suggestion_code: 'return value;',
  }) + '\n');
  return { runId };
}

function runPostComments(args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/post_comments.ts', ...args], {
    encoding: 'utf8',
  });
}

test('ocr-post-comments missing --runId exits with error message', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/post_comments.ts'], { encoding: 'utf8' });
  assert.ok(r.stderr.includes('missing --runId'), `stderr: ${r.stderr}`);
  assert.notEqual(r.status, 0);
});

test('ocr-post-comments github without --pr exits before reading run files', () => {
  const r = runPostComments(['--runId', 'nonexistent', '--provider', 'github']);
  assert.ok(r.stderr.includes('--pr required'), `stderr: ${r.stderr}`);
  assert.notEqual(r.status, 0);
});

test('ocr-post-comments unknown provider exits before reading run files', () => {
  const r = runPostComments(['--runId', 'nonexistent', '--provider', 'unknown', '--pr', '1']);
  assert.ok(r.stderr.includes('unknown provider'), `stderr: ${r.stderr}`);
  assert.notEqual(r.status, 0);
});

test('ocr-post-comments --dry-run previews comments without posting', () => {
  const { runId } = makeRun();
  const r = runPostComments([
    '--runId', runId,
    '--provider', 'github',
    '--pr', '42',
    '--dry-run',
  ]);

  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout) as { dryRun: boolean; count: number; comments: Array<{ path: string; line: string; content: string; suggestion_code?: string }> };
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.count, 1);
  assert.deepEqual(parsed.comments, [{
    path: 'src/a.ts',
    line: '10-12',
    content: 'Consider simplifying this branch.',
    suggestion_code: 'return value;',
  }]);
});
