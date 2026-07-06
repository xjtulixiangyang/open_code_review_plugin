import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendComment, writeContext } from '../../core/runs/store.js';
import type { ReviewContext } from '../../core/model/request.js';
import type { CommentRecord } from '../../core/model/comment.js';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX_LOADER = join(ROOT, 'node_modules/tsx/dist/loader.mjs');

const CTX: ReviewContext = {
  runId: 'run1',
  repoRoot: '/repo',
  range: 'workspace',
  background: '',
  files: [
    { path: 'src/a.ts', status: 'modified', diff: '', truncated: false, hunks: [], rulesHit: [] },
  ],
  changeFiles: ['src/a.ts'],
  meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
};

const COMMENT: CommentRecord = {
  comment_id: 'c-11111111-1111-4111-8111-111111111111',
  path: 'src/a.ts',
  start_line: 1,
  end_line: 1,
  content: 'issue',
};

async function runCli(cwd: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX_LOADER, join(ROOT, 'src/cli/filter_apply.ts'), ...args], { cwd });
}

async function setupRun(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-filter-apply-'));
  const oldCwd = process.cwd();
  process.chdir(dir);
  await writeContext('run1', CTX);
  await appendComment('run1', COMMENT);
  process.chdir(oldCwd);
  return dir;
}

test('filter_apply writes valid decisions and reports hiddenCount', async () => {
  const dir = await setupRun();
  try {
    const input = JSON.stringify({
      path: 'src/a.ts',
      decisions: [{ comment_id: COMMENT.comment_id, action: 'hide', reason: 'duplicate' }],
    });

    const { stdout } = await runCli(dir, ['--runId', 'run1', '--path', 'src/a.ts', '--input', input, '--subagent', 'filter-a']);
    const out = JSON.parse(stdout) as { hiddenCount: number; filterPath: string };
    assert.equal(out.hiddenCount, 1);
    assert.equal(out.filterPath, '.ocr-runs/run1/filters/src%2Fa.ts.json');

    const written = JSON.parse(await readFile(join(dir, '.ocr-runs/run1/filters/src%2Fa.ts.json'), 'utf8'));
    assert.equal(written.path, 'src/a.ts');
    assert.equal(written.decisions.length, 1);
    assert.equal(written._meta.source, 'review_filter_task');
    assert.equal(written._meta.subagent, 'filter-a');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('filter_apply rejects path outside review context', async () => {
  const dir = await setupRun();
  try {
    const input = JSON.stringify({ path: 'src/missing.ts', decisions: [] });
    await assert.rejects(
      runCli(dir, ['--runId', 'run1', '--path', 'src/missing.ts', '--input', input]),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /OCRP-FILTER-071/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('filter_apply rejects decisions without reason', async () => {
  const dir = await setupRun();
  try {
    const input = JSON.stringify({ path: 'src/a.ts', decisions: [{ comment_id: COMMENT.comment_id, action: 'hide', reason: '' }] });
    await assert.rejects(
      runCli(dir, ['--runId', 'run1', '--path', 'src/a.ts', '--input', input]),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /OCRP-FILTER-072/);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('filter_apply skips unknown comment ids without failing', async () => {
  const dir = await setupRun();
  try {
    const input = JSON.stringify({
      path: 'src/a.ts',
      decisions: [
        { comment_id: 'c-unknown', action: 'hide', reason: 'not found' },
        { comment_id: COMMENT.comment_id, action: 'hide', reason: 'real' },
      ],
    });

    const { stdout } = await runCli(dir, ['--runId', 'run1', '--path', 'src/a.ts', '--input', input]);
    const out = JSON.parse(stdout) as { hiddenCount: number };
    assert.equal(out.hiddenCount, 1);

    const written = JSON.parse(await readFile(join(dir, '.ocr-runs/run1/filters/src%2Fa.ts.json'), 'utf8'));
    assert.deepEqual(written.decisions.map((d: { comment_id: string }) => d.comment_id), [COMMENT.comment_id]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
