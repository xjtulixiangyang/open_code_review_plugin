import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveContextRef } from '../context_ref.js';
import { readContextFile, readContextFileLines } from '../context_file_reader.js';
import type { ReviewContext } from '../../model/request.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

function ctx(repoRoot: string, range: string): ReviewContext {
  return {
    runId: 'run1',
    repoRoot,
    range,
    background: '',
    files: [],
    changeFiles: [],
    meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
  };
}

async function setupRepo(): Promise<{ repo: string; first: string; second: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-context-reader-'));
  await git(repo, ['init', '-q']);
  await git(repo, ['checkout', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.ts'), 'export const value = 1;\nline2\n');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'nested.ts'), 'nested-v1\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'first']);
  const first = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(join(repo, 'a.ts'), 'export const value = 2;\nline2\nline3\n');
  await writeFile(join(repo, 'src', 'nested.ts'), 'nested-v2\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'second']);
  const second = await git(repo, ['rev-parse', 'HEAD']);
  return { repo, first, second };
}

test('resolveContextRef returns undefined for workspace and staged ranges', () => {
  assert.equal(resolveContextRef(ctx('/repo', 'workspace')), undefined);
  assert.equal(resolveContextRef(ctx('/repo', 'staged')), undefined);
});

test('resolveContextRef returns commit hash for commit range', () => {
  assert.equal(resolveContextRef(ctx('/repo', 'commit:abc123')), 'abc123');
});

test('resolveContextRef returns right side for two-dot range', () => {
  assert.equal(resolveContextRef(ctx('/repo', 'main..feature')), 'feature');
});

test('readContextFile reads workspace content when range has no ref', async () => {
  const { repo } = await setupRepo();
  try {
    await writeFile(join(repo, 'a.ts'), 'workspace-version\n');
    const out = await readContextFile(ctx(repo, 'workspace'), 'a.ts');
    assert.equal(out, 'workspace-version\n');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('readContextFile reads historical commit content when range is commit', async () => {
  const { repo, first } = await setupRepo();
  try {
    const out = await readContextFile(ctx(repo, `commit:${first}`), 'a.ts');
    assert.equal(out, 'export const value = 1;\nline2\n');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('readContextFile reads range right-side content for from..to reviews', async () => {
  const { repo, first, second } = await setupRepo();
  try {
    const out = await readContextFile(ctx(repo, `${first}..${second}`), 'src/nested.ts');
    assert.equal(out, 'nested-v2\n');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('readContextFileLines preserves trailing empty line and line windows', async () => {
  const { repo, first } = await setupRepo();
  try {
    const result = await readContextFileLines(ctx(repo, `commit:${first}`), 'a.ts', 1, 10);
    assert.deepEqual(result.lines, ['export const value = 1;', 'line2', '']);
    assert.equal(result.totalLines, 3);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('readContextFile rejects paths outside the repository in workspace mode', async () => {
  const { repo } = await setupRepo();
  try {
    await assert.rejects(readContextFile(ctx(repo, 'workspace'), '../secret.txt'), /outside repository/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
