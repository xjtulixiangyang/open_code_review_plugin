import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewContext } from '../review_context.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

test('workspace mode returns no files when paths filter matches nothing', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-context-'));
  try {
    await git(repo, ['init', '-q']);
    await git(repo, ['checkout', '-q', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'test']);
    await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'init']);

    await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n');
    await writeFile(join(repo, 'new.ts'), 'export const n = 1;\n');

    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace', paths: ['missing.ts'] });

    assert.deepEqual(ctx.changeFiles, []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('workspace mode honors multiple paths across tracked and untracked files', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-context-'));
  try {
    await git(repo, ['init', '-q']);
    await git(repo, ['checkout', '-q', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'test']);
    await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(repo, 'b.ts'), 'export const b = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'init']);

    await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n');
    await writeFile(join(repo, 'b.ts'), 'export const b = 2;\n');
    await writeFile(join(repo, 'c.ts'), 'export const c = 1;\n');

    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace', paths: ['a.ts', 'c.ts'] });

    assert.deepEqual(ctx.changeFiles.sort(), ['a.ts', 'c.ts']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
