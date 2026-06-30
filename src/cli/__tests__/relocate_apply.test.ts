import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendComment, writeContext, writeFilterResult } from '../../core/runs/store.js';
import type { ReviewContext } from '../../core/model/request.js';
import type { CommentRecord } from '../../core/model/comment.js';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX_LOADER = join(ROOT, 'node_modules/tsx/dist/loader.mjs');

const CTX: ReviewContext = {
  runId: 'run1',
  repoRoot: '',
  range: 'workspace',
  background: '',
  files: [{
    path: 'src/a.ts',
    status: 'modified',
    diff: '',
    truncated: false,
    rulesHit: [],
    hunks: [{
      id: 'h1', oldStart: 1, oldLines: 1, newStart: 10, newLines: 2,
      lines: [
        { kind: '+', oldLineNo: 0, newLineNo: 10, text: 'const value = compute();' },
        { kind: '+', oldLineNo: 0, newLineNo: 11, text: 'return value;' },
      ],
    }],
  }],
  changeFiles: ['src/a.ts'],
  meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
};

const COMMENT: CommentRecord = {
  comment_id: 'c-11111111-1111-4111-8111-111111111111',
  path: 'src/a.ts',
  start_line: 99,
  end_line: 99,
  content: 'wrong line',
  existing_code: 'const value = compute();\nreturn value;',
};

async function runCli(cwd: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX_LOADER, join(ROOT, 'src/cli/relocate_apply.ts'), ...args], { cwd });
}

async function setupRun(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-relocate-apply-'));
  const oldCwd = process.cwd();
  process.chdir(dir);
  await writeContext('run1', { ...CTX, repoRoot: dir });
  await appendComment('run1', COMMENT);
  await mkdir(dirname(join(dir, 'src/a.ts')), { recursive: true });
  await writeFile(join(dir, 'src/a.ts'), 'const value = compute();\nreturn value;\n', 'utf8');
  process.chdir(oldCwd);
  return dir;
}

test('relocate_apply writes relocation decisions for visible comments', async () => {
  const dir = await setupRun();
  try {
    const { stdout } = await runCli(dir, ['--runId', 'run1', '--path', 'src/a.ts']);
    const out = JSON.parse(stdout) as { relocatedCount: number; unchangedCount: number; fallbackCount: number; relocationPath: string };
    assert.equal(out.relocatedCount, 1);
    assert.equal(out.unchangedCount, 0);
    assert.equal(out.fallbackCount, 0);
    assert.equal(out.relocationPath, '.ocr-runs/run1/relocations/src%2Fa.ts.json');

    const written = JSON.parse(await readFile(join(dir, '.ocr-runs/run1/relocations/src%2Fa.ts.json'), 'utf8'));
    assert.equal(written.decisions[0].comment_id, COMMENT.comment_id);
    assert.equal(written.decisions[0].resolved_start_line, 10);
    assert.equal(written.decisions[0].resolved_end_line, 11);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('relocate_apply skips filtered comments', async () => {
  const dir = await setupRun();
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeFilterResult('run1', { path: 'src/a.ts', decisions: [{ comment_id: COMMENT.comment_id, action: 'hide', reason: 'hide' }] });
    process.chdir(oldCwd);
    const { stdout } = await runCli(dir, ['--runId', 'run1', '--path', 'src/a.ts']);
    const out = JSON.parse(stdout) as { relocatedCount: number };
    assert.equal(out.relocatedCount, 0);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('relocate_apply rejects path outside context', async () => {
  const dir = await setupRun();
  try {
    await assert.rejects(runCli(dir, ['--runId', 'run1', '--path', 'src/missing.ts']), (err: unknown) => {
      const e = err as { code?: number; stderr?: string };
      assert.equal(e.code, 2);
      assert.match(e.stderr ?? '', /OCRP-RELOCATE-081/);
      return true;
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
