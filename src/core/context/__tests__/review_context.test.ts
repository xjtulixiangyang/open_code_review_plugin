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

test('buildReviewContext reports OCRP-RUN-010 outside a git repository', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-not-git-'));
  try {
    await assert.rejects(
      buildReviewContext({ repoRoot: dir, mode: 'workspace' }),
      /OCRP-RUN-010: Not a git repository/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function initRepo(repo: string): Promise<void> {
  await git(repo, ['init', '-q']);
  await git(repo, ['checkout', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'init']);
}

test('buildReviewContext applies .code-review.yaml rule text to rulesHit', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-ctx-'));
  try {
    await initRepo(repo);
    await writeFile(join(repo, '.code-review.yaml'),
      'rules:\n  - path: "**/*.ts"\n    rule: "custom rule text"\n');
    await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n');

    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace' });
    assert.equal(ctx.rulesSource, '.code-review.yaml');
    assert.equal(ctx.files[0].rulesHit[0].message, 'custom rule text');
    assert.equal(ctx.files[0].rulesHit[0].docPath, undefined);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('buildReviewContext records excludedFiles with reason for test file', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-ctx-'));
  try {
    await initRepo(repo);
    await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n');
    await writeFile(join(repo, 'a.test.ts'), 'export const t = 1;\n');

    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace' });
    const excluded = ctx.excludedFiles ?? [];
    assert.ok(excluded.some((e) => e.path.endsWith('a.test.ts') && e.reason === 'default-exclude'),
      'a.test.ts should be default-excluded');
    assert.ok(!ctx.changeFiles.some((p) => p.endsWith('a.test.ts')));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('buildReviewContext include limits scope and excluded reason is not-in-include', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-ctx-'));
  try {
    await initRepo(repo);
    await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n');
    await writeFile(join(repo, 'b.ts'), 'export const b = 2;\n');
    await writeFile(join(repo, '.code-review.yaml'),
      'include:\n  - "a.ts"\n');

    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace' });
    assert.deepEqual(ctx.changeFiles.sort(), ['a.ts']);
    assert.ok((ctx.excludedFiles ?? []).some((e) => e.path === 'b.ts' && e.reason === 'not-in-include'));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('buildReviewContext without config preserves system rule docPath', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-ctx-'));
  try {
    await initRepo(repo);
    await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n');

    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace' });
    assert.equal(ctx.rulesSource, 'system');
    assert.equal(ctx.files[0].rulesHit[0].docPath, 'ts_js_tsx_jsx.md');
    assert.equal(ctx.excludedFiles, undefined);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
