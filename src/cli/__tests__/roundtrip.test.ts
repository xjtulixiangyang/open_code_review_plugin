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

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** tsx 加载器绝对路径，确保子进程从任意 cwd 都能加载 ts 文件 */
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
}

test('CLI tools write comments, done markers, file diffs, and aggregate reports', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-roundtrip-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await mkdir(join(dir, 'src'));
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    await writeFile(join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
    await git(dir, ['init', '-q']);
    await git(dir, ['checkout', '-q', '-b', 'main']);
    await git(dir, ['config', 'user.email', 'test@example.com']);
    await git(dir, ['config', 'user.name', 'test']);
    await git(dir, ['add', '.']);
    await git(dir, ['commit', '-q', '-m', 'init']);
    await writeContext('run1', makeCtx(dir));
    process.chdir(oldCwd);

    await runCli(dir, 'code_comment.ts', [
      '--runId', 'run1',
      '--args', JSON.stringify({
        path: 'src/a.ts',
        subagent: 'reviewer-0',
        comments: [{ start_line: 1, end_line: 1, content: 'Use a clearer value' }],
      }),
    ]);
    await runCli(dir, 'task_done.ts', [
      '--runId', 'run1',
      '--args', JSON.stringify({ subagent: 'reviewer-0', file: 'src/a.ts' }),
    ]);

    const diff = await runCli(dir, 'file_read_diff.ts', [
      '--runId', 'run1',
      '--args', JSON.stringify({ path_array: ['src/b.ts'] }),
    ]);
    assert.match(diff.stdout, /==== FILE: src\/b\.ts ====/);

    const read = await runCli(dir, 'file_read.ts', [
      '--runId', 'run1',
      '--args', JSON.stringify({ file_path: 'src/a.ts', start_line: 1, end_line: 2 }),
    ]);
    assert.match(read.stdout, /File: src\/a\.ts/);

    const found = await runCli(dir, 'file_find.ts', [
      '--runId', 'run1',
      '--args', JSON.stringify({ query_name: 'a.ts' }),
    ]);
    assert.match(found.stdout, /src\/a\.ts/);

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
