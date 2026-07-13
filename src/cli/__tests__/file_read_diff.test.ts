import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeContext } from '../../core/runs/store.js';
import type { ReviewContext } from '../../core/model/request.js';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX_LOADER = join(ROOT, 'node_modules/tsx/dist/loader.mjs');

async function runCli(cwd: string, file: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX_LOADER, join(ROOT, 'src/cli', file), ...args], { cwd });
}

const SAMPLE_DIFF = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n';

function makeCtx(repoRoot: string): ReviewContext {
  return {
    runId: 'run1',
    repoRoot,
    range: 'workspace',
    background: '',
    files: [
      {
        path: 'src/a.ts',
        status: 'modified',
        diff: SAMPLE_DIFF,
        truncated: false,
        hunks: [],
        rulesHit: [],
      },
    ],
    changeFiles: ['src/a.ts'],
    meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
  };
}

test('file_read_diff outputs diff for existing path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-file-read-diff-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run1', makeCtx(dir));
    process.chdir(oldCwd);

    const { stdout } = await runCli(dir, 'file_read_diff.ts', [
      '--runId', 'run1',
      '--path', 'src/a.ts',
    ]);

    assert.match(stdout, /export const a = 2/);
    assert.doesNotMatch(stdout, /truncated/);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('file_read_diff appends truncated marker when file is truncated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-file-read-diff-trunc-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    const ctx = makeCtx(dir);
    ctx.files[0].truncated = true;
    await writeContext('run1', ctx);
    process.chdir(oldCwd);

    const { stdout } = await runCli(dir, 'file_read_diff.ts', [
      '--runId', 'run1',
      '--path', 'src/a.ts',
    ]);

    assert.match(stdout, /\.\.\. \(truncated\)/);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('file_read_diff exits 3 when path not in context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-file-read-diff-miss-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run1', makeCtx(dir));
    process.chdir(oldCwd);

    try {
      await runCli(dir, 'file_read_diff.ts', [
        '--runId', 'run1',
        '--path', 'nonexistent.ts',
      ]);
      assert.fail('expected error');
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string };
      assert.equal(e.code, 3);
      assert.match(e.stderr ?? '', /path not in context/);
    }
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('file_read_diff exits 2 when missing required flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-file-read-diff-miss2-'));
  try {
    try {
      await runCli(dir, 'file_read_diff.ts', ['--runId', 'run1']);
      assert.fail('expected error');
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string };
      assert.equal(e.code, 2);
      assert.match(e.stderr ?? '', /missing --path/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
