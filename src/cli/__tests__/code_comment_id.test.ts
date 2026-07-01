import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX_LOADER = join(ROOT, 'node_modules/tsx/dist/loader.mjs');

async function runCodeComment(cwd: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX_LOADER, join(ROOT, 'src/cli/code_comment.ts'), ...args], { cwd });
}

test('code_comment generates stable comment_id in stdout and jsonl', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-comment-id-'));
  try {
    const first = await runCodeComment(dir, [
      '--runId', 'run1',
      '--args', JSON.stringify({
        path: 'src/a.ts', subagent: 'reviewer-a',
        comments: [{ start_line: 1, end_line: 1, content: 'first' }],
      }),
    ]);
    const second = await runCodeComment(dir, [
      '--runId', 'run1',
      '--args', JSON.stringify({
        path: 'src/a.ts', subagent: 'reviewer-a',
        comments: [{ start_line: 2, end_line: 2, content: 'second' }],
      }),
    ]);

    const firstOut = JSON.parse(first.stdout) as { comment_ids: string[] };
    const secondOut = JSON.parse(second.stdout) as { comment_ids: string[] };

    assert.equal(firstOut.comment_ids.length, 1);
    assert.match(firstOut.comment_ids[0], /^c-[0-9a-f-]{36}$/);
    assert.match(secondOut.comment_ids[0], /^c-[0-9a-f-]{36}$/);
    assert.notEqual(firstOut.comment_ids[0], secondOut.comment_ids[0]);

    const body = await readFile(join(dir, '.ocr-runs/run1/comments.jsonl'), 'utf8');
    const lines = body.trim().split('\n').map((line) => JSON.parse(line) as { comment_id: string; content: string });
    assert.equal(lines.length, 2);
    assert.equal(lines[0].comment_id, firstOut.comment_ids[0]);
    assert.equal(lines[1].comment_id, secondOut.comment_ids[0]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
