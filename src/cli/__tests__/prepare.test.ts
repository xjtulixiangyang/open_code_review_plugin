import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

async function runPrepare(cwd: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX, join(ROOT, 'src/cli/prepare.ts'), ...args], {
    cwd,
  });
}

async function initGitRepo(repo: string): Promise<void> {
  const git = (args: string[]) => execFileAsync('git', args, { cwd: repo });
  await git(['init', '-q']);
  await git(['checkout', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'test']);
  await writeFile(join(repo, 'a.ts'), 'export const a = 1;\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'init']);
  await writeFile(join(repo, 'a.ts'), 'export const a = 2;\n');
}

test('ocr-prepare accepts --rules and --rule alias', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await initGitRepo(repo);
    await writeFile(join(repo, 'custom.yaml'), 'rules:\n  - path: "**/*.ts"\n    rule: "x"\n');
    for (const flag of ['--rules', '--rule']) {
      const { stdout } = await runPrepare(repo, [flag, 'custom.yaml']);
      const j = JSON.parse(stdout);
      assert.equal(j.rulesSource, 'custom.yaml');
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare rejects missing --rules path with OCRP-RUN-011', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await assert.rejects(
      runPrepare(repo, ['--rules']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /OCRP-RUN-011/);
        return true;
      },
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare --preview returns preview:true and no contextPath', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await initGitRepo(repo);
    const { stdout } = await runPrepare(repo, ['--preview']);
    const j = JSON.parse(stdout);
    assert.equal(j.preview, true);
    assert.equal(j.contextPath, null);
    assert.ok(j.fileCount >= 1);
    assert.ok(Array.isArray(j.files));
    assert.ok(Array.isArray(j.excludedFiles));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare -p is an alias for --preview', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await initGitRepo(repo);
    const { stdout } = await runPrepare(repo, ['-p']);
    const j = JSON.parse(stdout);
    assert.equal(j.preview, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare --dry-run writes context.json and preview.json', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await initGitRepo(repo);
    const { stdout } = await runPrepare(repo, ['--dry-run']);
    const j = JSON.parse(stdout);
    assert.equal(j.dryRun, true);
    assert.ok(j.contextPath, 'contextPath should be set');
    assert.ok(j.previewPath, 'previewPath should be set');
    const ctx = await readFile(join(repo, j.contextPath), 'utf8');
    assert.ok(JSON.parse(ctx).files.length >= 1);
    const prev = await readFile(join(repo, j.previewPath), 'utf8');
    assert.equal(JSON.parse(prev).dryRun, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare rejects --preview --dry-run with OCRP-RUN-011', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await initGitRepo(repo);
    await assert.rejects(
      runPrepare(repo, ['--preview', '--dry-run']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /OCRP-RUN-011/);
        return true;
      },
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
