import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX_LOADER = join(ROOT, 'node_modules/tsx/dist/loader.mjs');

async function runCli(cwd: string, file: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX_LOADER, join(ROOT, 'src/cli', file), ...args], { cwd });
}

test('code_comment rejects legacy per-field flags (missing --args)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-legacy-'));
  try {
    await assert.rejects(
      runCli(dir, 'code_comment.ts', ['--runId', 'r', '--path', 'a.ts', '--start', '1', '--end', '1', '--content', 'x']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /missing --args/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('file_read_diff rejects legacy --path (missing --args)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-legacy-'));
  try {
    await assert.rejects(
      runCli(dir, 'file_read_diff.ts', ['--runId', 'r', '--path', 'a.ts']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /missing --args/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('task_done rejects legacy per-field flags (missing --args)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-legacy-'));
  try {
    await assert.rejects(
      runCli(dir, 'task_done.ts', ['--runId', 'r', '--subagent', 'reviewer-a', '--file', 'a.ts']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /missing --args/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
