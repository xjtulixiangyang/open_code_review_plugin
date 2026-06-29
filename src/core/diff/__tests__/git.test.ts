import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { gitDiff } from '../git.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

test('range diff uses merge-base semantics for diverged branches', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-git-'));
  try {
    await git(repo, ['init', '-q']);
    await git(repo, ['checkout', '-q', '-b', 'main']);
    await git(repo, ['config', 'user.email', 'test@example.com']);
    await git(repo, ['config', 'user.name', 'test']);
    await writeFile(join(repo, 'base.ts'), 'export const base = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'base']);

    await git(repo, ['checkout', '-q', '-b', 'feature']);
    await writeFile(join(repo, 'feature.ts'), 'export const feature = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'feature']);

    await git(repo, ['checkout', '-q', 'main']);
    await writeFile(join(repo, 'main.ts'), 'export const main = 1;\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-q', '-m', 'main']);

    const diff = await gitDiff({ repoRoot: repo, range: 'main..feature' });

    assert.match(diff, /feature\.ts/);
    assert.doesNotMatch(diff, /main\.ts/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
