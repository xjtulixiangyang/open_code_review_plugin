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
      '--path', 'src/a.ts',
      '--start', '1',
      '--end', '1',
      '--content', 'first',
      '--subagent', 'reviewer-a',
    ]);
    const second = await runCodeComment(dir, [
      '--runId', 'run1',
      '--path', 'src/a.ts',
      '--start', '2',
      '--end', '2',
      '--content', 'second',
      '--subagent', 'reviewer-a',
    ]);

    const firstOut = JSON.parse(first.stdout) as { ok: boolean; path: string };
    const secondOut = JSON.parse(second.stdout) as { ok: boolean; path: string };
    assert.equal(firstOut.ok, true);
    assert.equal(secondOut.ok, true);

    const body = await readFile(join(dir, '.ocr-runs/run1/comments.jsonl'), 'utf8');
    const lines = body.trim().split('\n').map((line) => JSON.parse(line) as { comment_id: string; content: string });
    assert.equal(lines.length, 2);
    assert.match(lines[0].comment_id, /^c-[0-9a-f-]{36}$/);
    assert.match(lines[1].comment_id, /^c-[0-9a-f-]{36}$/);
    assert.notEqual(lines[0].comment_id, lines[1].comment_id);
    assert.equal(lines[0].content, 'first');
    assert.equal(lines[1].content, 'second');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
