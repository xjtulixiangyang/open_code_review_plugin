import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { findFiles } from '../file_find.js';
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

async function setupRepo(): Promise<{ repo: string; first: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-file-find-'));
  await git(repo, ['init', '-q']);
  await git(repo, ['checkout', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'AlphaService.ts'), 'export const a = 1;\n');
  await writeFile(join(repo, 'src', 'beta-service.ts'), 'export const b = 1;\n');
  await writeFile(join(repo, 'README.md'), '# readme\n');
  await writeFile(join(repo, 'no_extension'), 'skip me\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'first']);
  const first = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(join(repo, 'src', 'NewService.ts'), 'export const n = 1;\n');
  return { repo, first };
}

test('findFiles returns not-found marker for blank query_name', async () => {
  const out = await findFiles({}, ctx('/repo', 'workspace'));
  assert.equal(out, '// The file was not found');
});

test('findFiles searches workspace tracked and untracked files case-insensitively', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await findFiles({ query_name: 'service' }, ctx(repo, 'workspace'));
    assert.match(out, /src\/AlphaService\.ts/);
    assert.match(out, /src\/beta-service\.ts/);
    assert.match(out, /src\/NewService\.ts/);
    assert.doesNotMatch(out, /no_extension/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('findFiles honors case_sensitive', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await findFiles({ query_name: 'Service', case_sensitive: true }, ctx(repo, 'workspace'));
    assert.match(out, /src\/AlphaService\.ts/);
    assert.match(out, /src\/NewService\.ts/);
    assert.doesNotMatch(out, /src\/beta-service\.ts/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('findFiles uses commit tree when range has a commit ref', async () => {
  const { repo, first } = await setupRepo();
  try {
    const out = await findFiles({ query_name: 'Service' }, ctx(repo, `commit:${first}`));
    assert.match(out, /src\/AlphaService\.ts/);
    assert.match(out, /src\/beta-service\.ts/);
    assert.doesNotMatch(out, /src\/NewService\.ts/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('findFiles returns not-found marker when no file matches', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await findFiles({ query_name: 'Missing' }, ctx(repo, 'workspace'));
    assert.equal(out, '// The file was not found');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
