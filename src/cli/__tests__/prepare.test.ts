import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('ocr-prepare accepts --rules and stores rulesPath', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    // Init a minimal git repo so buildReviewContext doesn't throw OCRP-RUN-010
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo });
    // Create a valid rule file so buildReviewContext doesn't throw OCRP-RULES-090
    await writeFile(join(repo, 'custom.json'), JSON.stringify({ rules: [] }));
    const { stdout } = await runPrepare(repo, ['--rules', 'custom.json']);
    const summary = JSON.parse(stdout);
    assert.ok(summary.runId);
    assert.equal(typeof summary.runId, 'string');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare accepts preview and dry-run flags', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo });
    await writeFile(join(repo, 'custom.json'), JSON.stringify({ rules: [] }));
    for (const flag of ['--preview', '-p', '--dry-run']) {
      const { stdout } = await runPrepare(repo, [flag]);
      const summary = JSON.parse(stdout);
      assert.ok(summary.runId);
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
