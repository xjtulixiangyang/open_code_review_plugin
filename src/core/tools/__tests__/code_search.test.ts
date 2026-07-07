import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCode } from '../code_search.js';
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
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-code-search-'));
  await git(repo, ['init', '-q']);
  await git(repo, ['checkout', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src', 'a.ts'), 'export const token = "OLD_TOKEN";\nexport const other = 1;\n');
  await writeFile(join(repo, 'src', 'b.ts'), 'export const token = "SECOND";\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'first']);
  const first = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(join(repo, 'src', 'a.ts'), 'export const token = "NEW_TOKEN";\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'second']);
  return { repo, first };
}

test('searchCode returns blank-search error', async () => {
  const out = await searchCode({}, ctx('/repo', 'workspace'));
  assert.equal(out, 'Error: search_text is blank');
});

test('searchCode searches workspace with fixed string by default', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await searchCode({ search_text: 'NEW_TOKEN' }, ctx(repo, 'workspace'));
    assert.match(out, /File: src\/a\.ts/);
    assert.match(out, /1\|export const token = "NEW_TOKEN";/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('searchCode searches historical commit when context has commit ref', async () => {
  const { repo, first } = await setupRepo();
  try {
    const out = await searchCode({ search_text: 'OLD_TOKEN' }, ctx(repo, `commit:${first}`));
    assert.match(out, /File: src\/a\.ts/);
    assert.match(out, /1\|export const token = "OLD_TOKEN";/);
    assert.doesNotMatch(out, /NEW_TOKEN/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('searchCode honors file_patterns pathspecs', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await searchCode({ search_text: 'token', file_patterns: ['src/b.ts'] }, ctx(repo, 'workspace'));
    assert.match(out, /File: src\/b\.ts/);
    assert.doesNotMatch(out, /File: src\/a\.ts/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('searchCode supports Perl regular expressions when requested', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await searchCode({ search_text: 'NEW_[A-Z]+', use_perl_regexp: true }, ctx(repo, 'workspace'));
    assert.match(out, /NEW_TOKEN/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('searchCode supports extended regexp as backward-compatible alias', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await searchCode({ search_text: 'NEW_[A-Z]+', use_extended_regexp: true }, ctx(repo, 'workspace'));
    assert.match(out, /NEW_TOKEN/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('searchCode returns no matches marker for empty result', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await searchCode({ search_text: 'DOES_NOT_EXIST' }, ctx(repo, 'workspace'));
    assert.equal(out, 'No matches found');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
