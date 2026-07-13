import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../prepare.js';
import type { LaunchConfig } from '../../core/orchestrator/types.js';

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

test('ocr-prepare --preview succeeds and writes preview summary/context', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo });
    await writeFile(join(repo, 'custom.json'), JSON.stringify({ rules: [] }));
    const { stdout } = await runPrepare(repo, ['--preview']);
    const summary = JSON.parse(stdout);
    assert.equal(summary.preview, true);
    assert.equal(summary.dryRun, false);
    assert.equal(summary.rulesSource, 'system');
    assert.equal(typeof summary.excludedFileCount, 'number');
    const contextPath = join(repo, summary.contextPath);
    const ctx = JSON.parse(await readFile(contextPath, 'utf8'));
    assert.equal(ctx.preview, true);
    assert.equal(ctx.dryRun, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare --dry-run succeeds and writes dryRun summary/context', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo });
    await writeFile(join(repo, 'custom.json'), JSON.stringify({ rules: [] }));
    const { stdout } = await runPrepare(repo, ['--dry-run']);
    const summary = JSON.parse(stdout);
    assert.equal(summary.preview, false);
    assert.equal(summary.dryRun, true);
    assert.equal(summary.rulesSource, 'system');
    assert.equal(typeof summary.excludedFileCount, 'number');
    const contextPath = join(repo, summary.contextPath);
    const ctx = JSON.parse(await readFile(contextPath, 'utf8'));
    assert.equal(ctx.preview, false);
    assert.equal(ctx.dryRun, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('parseArgs accepts --plans and stores plansPath', () => {
  const args = parseArgs(['--plans', 'review-plans.md']);
  assert.equal(args.plansPath, 'review-plans.md');
});

test('ocr-prepare --plans writes custom plans guidance into context and summary', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo });
    await writeFile(join(repo, 'plans.md'), 'custom plan guidance');

    const { stdout } = await runPrepare(repo, ['--plans', 'plans.md']);
    const summary = JSON.parse(stdout);
    assert.equal(summary.plansGuidanceSource, 'plans.md');

    const contextPath = join(repo, summary.contextPath);
    const ctx = JSON.parse(await readFile(contextPath, 'utf8'));
    assert.equal(ctx.plansGuidanceSource, 'plans.md');
    assert.equal(ctx.plansGuidanceText, 'custom plan guidance');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare writes normalized launch.json with concurrency, leaseDurationMs, maxAttempts, no resumeRunId', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await execFileAsync('git', ['init'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'test@test'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo });
    await writeFile(join(repo, 'custom.json'), JSON.stringify({ rules: [] }));

    const { stdout } = await runPrepare(repo, ['--concurrency', '3']);
    const summary = JSON.parse(stdout);

    const launchPath = join(repo, '.ocr-runs', summary.runId, 'launch.json');
    const launch: LaunchConfig = JSON.parse(await readFile(launchPath, 'utf8'));

    assert.equal(launch.schemaVersion, 1);
    assert.equal(launch.concurrency, 3);
    assert.equal(launch.leaseDurationMs, 900_000);
    assert.equal(launch.maxAttempts, 2);
    assert.equal(launch.mode, 'workspace');
    // resumeRunId, preview, dryRun must not appear in launch config
    assert.equal((launch as Record<string, unknown>).resumeRunId, undefined);
    assert.equal((launch as Record<string, unknown>).preview, undefined);
    assert.equal((launch as Record<string, unknown>).dryRun, undefined);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

