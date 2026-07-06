import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
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

async function mkGitRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-context-'));
  await git(dir, ['init', '-q']);
  await git(dir, ['checkout', '-q', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'Test User']);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'keep.ts'), 'export const keep = 1;\n');
  await writeFile(join(dir, 'src', 'skip.ts'), 'export const skip = 1;\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-q', '-m', 'init']);
  await writeFile(join(dir, 'src', 'keep.ts'), 'export const keep = 2;\n');
  await writeFile(join(dir, 'src', 'skip.ts'), 'export const skip = 2;\n');
  return dir;
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

test('buildReviewContext applies custom include/exclude and custom rule text', async () => {
  const repo = await mkGitRepo();
  try {
    await writeFile(join(repo, '.code-review.yaml'), [
      'include:',
      '  - "src/**/*.ts"',
      'exclude:',
      '  - "src/skip.ts"',
      'rules:',
      '  - path: "src/keep.ts"',
      '    rule: "custom keep rule"',
      '',
    ].join('\n'));

    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace' });

    assert.equal(ctx.rulesSource, '.code-review.yaml');
    assert.deepEqual(ctx.changeFiles, ['src/keep.ts']);
    assert.ok(ctx.excludedFiles?.some((f) => f.path === 'src/skip.ts' && f.reason === 'user-exclude'));

    const hit = ctx.files[0].rulesHit[0];
    assert.equal(hit.ruleId, 'custom:src/keep.ts');
    assert.equal(hit.source, 'custom');
    assert.equal(hit.message, 'custom keep rule');
    assert.equal(hit.text, 'custom keep rule');
    assert.equal(hit.docPath, undefined);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('buildReviewContext falls back to system rule when no custom rule matches', async () => {
  const repo = await mkGitRepo();
  try {
    await writeFile(join(repo, '.code-review.yaml'), [
      'rules:',
      '  - path: "docs/**"',
      '    rule: "docs only"',
      '',
    ].join('\n'));

    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace' });
    const hit = ctx.files.find((f) => f.path === 'src/keep.ts')!.rulesHit[0];

    assert.equal(ctx.rulesSource, '.code-review.yaml');
    assert.equal(hit.source, 'system');
    assert.equal(hit.docPath, 'ts_js_tsx_jsx.md');
    assert.ok(hit.text && hit.text.length > 50);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('buildReviewContext persists preview flag', async () => {
  const repo = await mkGitRepo();
  try {
    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace', preview: true });
    assert.equal(ctx.preview, true);
    assert.equal(ctx.dryRun, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('buildReviewContext persists dryRun flag', async () => {
  const repo = await mkGitRepo();
  try {
    const ctx = await buildReviewContext({ repoRoot: repo, mode: 'workspace', dryRun: true });
    assert.equal(ctx.preview, false);
    assert.equal(ctx.dryRun, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
