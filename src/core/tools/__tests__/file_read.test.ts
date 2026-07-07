import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile as readOcrFile } from '../file_read.js';
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
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-file-read-'));
  await git(repo, ['init', '-q']);
  await git(repo, ['checkout', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.ts'), 'one\ntwo\nthree\nfour\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-q', '-m', 'first']);
  const first = await git(repo, ['rev-parse', 'HEAD']);
  await writeFile(join(repo, 'a.ts'), 'changed\n');
  return { repo, first };
}

test('readFile requires file_path', async () => {
  const out = await readOcrFile({}, ctx('/repo', 'workspace'));
  assert.equal(out, 'Error: file_path is required');
});

test('readFile formats requested line range', async () => {
  const { repo } = await setupRepo();
  try {
    const out = await readOcrFile({ file_path: 'a.ts', start_line: 2, end_line: 3 }, ctx(repo, 'workspace'));
    assert.match(out, /File: a\.ts \(Total lines: 2\)/);
    assert.match(out, /IS_TRUNCATED: false/);
    assert.match(out, /LINE_RANGE: 2-2/);
    assert.match(out, /2\|/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('readFile reads commit content instead of workspace content', async () => {
  const { repo, first } = await setupRepo();
  try {
    const out = await readOcrFile({ file_path: 'a.ts', start_line: 1, end_line: 2 }, ctx(repo, `commit:${first}`));
    assert.match(out, /1\|one/);
    assert.match(out, /2\|two/);
    assert.doesNotMatch(out, /changed/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('readFile truncates to 500 lines', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-file-read-truncate-'));
  try {
    const body = Array.from({ length: 550 }, (_, i) => `line-${i + 1}`).join('\n') + '\n';
    await writeFile(join(repo, 'big.ts'), body);
    const out = await readOcrFile({ file_path: 'big.ts' }, ctx(repo, 'workspace'));
    assert.match(out, /IS_TRUNCATED: true/);
    assert.match(out, /LINE_RANGE: 1-500/);
    assert.match(out, /500\|line-500/);
    assert.doesNotMatch(out, /501\|line-501/);
    assert.match(out, /Note: Results truncated to 500 lines/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
