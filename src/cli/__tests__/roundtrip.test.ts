import { mkdtemp, rm, readFile } from 'node:fs/promises';
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

/** tsx 加载器绝对路径，确保子进程从任意 cwd 都能加载 ts 文件 */
const TSX_LOADER = join(ROOT, 'node_modules/tsx/dist/loader.mjs');

async function runCli(cwd: string, file: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX_LOADER, join(ROOT, 'src/cli', file), ...args], { cwd });
}

const CTX: ReviewContext = {
  runId: 'run1',
  repoRoot: '/repo',
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
    {
      path: 'src/b.ts',
      status: 'modified',
      diff: 'diff --git a/src/b.ts b/src/b.ts\n@@ -1 +1 @@\n-export const b = 1;\n+export const b = 2;\n',
      truncated: false,
      hunks: [],
      rulesHit: [],
    },
  ],
  changeFiles: ['src/a.ts', 'src/b.ts'],
  meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
};

test('CLI tools write comments, done markers, file diffs, and aggregate reports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-roundtrip-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run1', CTX);
    process.chdir(oldCwd);

    await runCli(dir, 'code_comment.ts', [
      '--runId', 'run1',
      '--path', 'src/a.ts',
      '--start', '1',
      '--end', '1',
      '--content', 'Use a clearer value',
      '--subagent', 'reviewer-0',
    ]);
    await runCli(dir, 'task_done.ts', ['--runId', 'run1', '--subagent', 'reviewer-0', '--file', 'src/a.ts']);

    const diff = await runCli(dir, 'file_read_diff.ts', ['--runId', 'run1', '--path', 'src/b.ts']);
    assert.match(diff.stdout, /src\/b\.ts/);

    const aggregate = await runCli(dir, 'aggregate.ts', ['--runId', 'run1', '--format', 'both']);
    const summary = JSON.parse(aggregate.stdout) as { partial: boolean; partialFiles: string[]; commentCount: number };

    assert.equal(summary.partial, true);
    assert.deepEqual(summary.partialFiles, ['src/b.ts']);
    assert.equal(summary.commentCount, 1);

    const reportMd = await readFile(join(dir, '.ocr-runs/run1/report.md'), 'utf8');
    const reportJson = JSON.parse(await readFile(join(dir, '.ocr-runs/run1/report.json'), 'utf8'));

    assert.match(reportMd, /Use a clearer value/);
    assert.equal(reportJson.status, 'completed_with_warnings');
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
