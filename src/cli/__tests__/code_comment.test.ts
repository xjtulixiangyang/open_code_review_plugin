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
    files: [
      {
        path: 'src/a.ts',
        status: 'modified',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n',
        truncated: false,
        hunks: [],
        rulesHit: [],
      },
    ],
    changeFiles: ['src/a.ts'],
    meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
  };
}

test('code_comment writes comment to jsonl and outputs ok', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-code-comment-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run1', makeCtx(dir));
    process.chdir(oldCwd);

    const { stdout } = await runCli(dir, 'code_comment.ts', [
      '--runId', 'run1',
      '--path', 'src/a.ts',
      '--start', '1',
      '--end', '1',
      '--content', 'Use a clearer value',
      '--subagent', 'reviewer-x',
    ]);

    const out = JSON.parse(stdout) as { ok: boolean; path: string; start: number; end: number };
    assert.equal(out.ok, true);
    assert.equal(out.path, 'src/a.ts');
    assert.equal(out.start, 1);
    assert.equal(out.end, 1);

    const body = await readFile(join(dir, '.ocr-runs/run1/comments.jsonl'), 'utf8');
    const lines = body.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].path, 'src/a.ts');
    assert.equal(lines[0].start_line, 1);
    assert.equal(lines[0].end_line, 1);
    assert.equal(lines[0].content, 'Use a clearer value');
    assert.equal(lines[0]._meta.subagent, 'reviewer-x');
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('code_comment accepts optional fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-code-comment-opt-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run1', makeCtx(dir));
    process.chdir(oldCwd);

    await runCli(dir, 'code_comment.ts', [
      '--runId', 'run1',
      '--path', 'src/a.ts',
      '--start', '1',
      '--end', '3',
      '--content', 'refactor this',
      '--suggestion-code', 'const b = 2;',
      '--existing-code', 'const a = 1;',
      '--thinking', 'this could be cleaner',
    ]);

    const body = await readFile(join(dir, '.ocr-runs/run1/comments.jsonl'), 'utf8');
    const rec = JSON.parse(body.trim());
    assert.equal(rec.suggestion_code, 'const b = 2;');
    assert.equal(rec.existing_code, 'const a = 1;');
    assert.equal(rec.thinking, 'this could be cleaner');
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('code_comment exits 2 when missing required flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-code-comment-miss-'));
  try {
    try {
      await runCli(dir, 'code_comment.ts', ['--runId', 'run1', '--path', 'src/a.ts']);
      assert.fail('expected error');
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string };
      assert.equal(e.code, 2);
      assert.match(e.stderr ?? '', /missing --start/);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
