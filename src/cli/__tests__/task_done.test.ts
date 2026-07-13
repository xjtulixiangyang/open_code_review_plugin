import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
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

function makeCtx(repoRoot: string): ReviewContext {
  return {
    runId: 'run1',
    repoRoot,
    range: 'workspace',
    background: '',
    files: [],
    changeFiles: [],
    meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
  };
}

test('task_done writes done marker and outputs ok', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-task-done-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run1', makeCtx(dir));
    process.chdir(oldCwd);

    const { stdout } = await runCli(dir, 'task_done.ts', [
      '--runId', 'run1',
      '--subagent', 'reviewer-x',
      '--file', 'src/a.ts',
    ]);

    const out = JSON.parse(stdout) as { ok: boolean; subagent: string; file: string };
    assert.equal(out.ok, true);
    assert.equal(out.subagent, 'reviewer-x');
    assert.equal(out.file, 'src/a.ts');

    const doneBody = await readFile(join(dir, '.ocr-runs/run1/done/reviewer-x.json'), 'utf8');
    const done = JSON.parse(doneBody);
    assert.equal(done.subagent, 'reviewer-x');
    assert.equal(done.file, 'src/a.ts');
    assert.ok(done.ts);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('task_done exits 2 when missing required flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-task-done-miss-'));
  try {
    try {
      await runCli(dir, 'task_done.ts', ['--runId', 'run1']);
      assert.fail('expected error');
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string };
      assert.equal(e.code, 2);
      assert.match(e.stderr ?? '', /missing --subagent/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
