import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ReviewManifest, RunRecord } from '../../core/orchestrator/types.js';
import { buildManifest, manifestDigest, repositoryIdentity } from '../../core/orchestrator/fingerprint.js';
import { atomicWriteJson } from '../../core/orchestrator/storage.js';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX_LOADER = join(ROOT, 'node_modules/tsx/dist/loader.mjs');

async function runCli(cwd: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX_LOADER, join(ROOT, 'src/cli/orchestrator_start.ts'), ...args], { cwd });
}

const tempDirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'orc-start-'));
  tempDirs.push(d);
  return d;
}

async function initGitRepo(repoRoot: string): Promise<void> {
  await execFileAsync('git', ['init'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.email', 'test@test'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoRoot });
}

after(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// orchestrator_start CLI — fresh start
// ---------------------------------------------------------------------------

test('orchestrator_start CLI returns fresh start JSON', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);

    // Create candidate run directory with context and launch config
    const runDir = join(root, '.ocr-runs', 'candidate');
    await mkdir(runDir, { recursive: true });
    const ctx = {
      runId: 'candidate',
      repoRoot: root,
      range: 'workspace',
      background: '',
      files: [
        { path: 'src/a.ts', status: 'modified', diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n', truncated: false, hunks: [], rulesHit: [] },
      ],
      changeFiles: ['src/a.ts'],
      meta: { generatedAt: new Date().toISOString(), pluginVersion: '0.1.0' },
    };
    await writeFile(join(runDir, 'context.json'), JSON.stringify(ctx, null, 2), 'utf8');
    await writeFile(join(runDir, 'launch.json'), JSON.stringify({
      schemaVersion: 1,
      mode: 'workspace',
      concurrency: 2,
      leaseDurationMs: 900_000,
      maxAttempts: 2,
    }, null, 2), 'utf8');

    const { stdout } = await runCli(root, ['candidate']);
    const result = JSON.parse(stdout);

    assert.equal(result.candidateRunId, 'candidate');
    assert.equal(result.effectiveRunId, 'candidate');
    assert.equal(result.resumed, false);
    assert.equal(result.state, 'active');
    assert.ok(result.taskCounts);

    // Verify manifest was written
    const manifest = JSON.parse(await readFile(join(runDir, 'manifest.json'), 'utf8')) as ReviewManifest;
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.runId, 'candidate');
    assert.equal(manifest.files.length, 1);
    assert.equal(manifest.files[0].path, 'src/a.ts');

    // Verify run record was written
    const runRecord = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')) as RunRecord;
    assert.equal(runRecord.runId, 'candidate');
    assert.equal(runRecord.state, 'active');

    // Verify task was created
    const tasksDir = join(runDir, 'tasks');
    const taskFiles = await readdirSafe(tasksDir);
    assert.equal(taskFiles.length, 1);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// orchestrator_start CLI — resume
// ---------------------------------------------------------------------------

test('orchestrator_start CLI resumes compatible active run', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);

    // Create active run A
    const runADir = join(root, '.ocr-runs', 'active-a');
    await mkdir(runADir, { recursive: true });
    const ctxA = {
      runId: 'active-a',
      repoRoot: root,
      range: 'workspace',
      background: '',
      files: [
        { path: 'src/a.ts', status: 'modified', diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n', truncated: false, hunks: [], rulesHit: [] },
      ],
      changeFiles: ['src/a.ts'],
      meta: { generatedAt: new Date().toISOString(), pluginVersion: '0.1.0' },
    };
    await writeFile(join(runADir, 'context.json'), JSON.stringify(ctxA, null, 2), 'utf8');
    await writeFile(join(runADir, 'launch.json'), JSON.stringify({
      schemaVersion: 1,
      mode: 'workspace',
      concurrency: 2,
      leaseDurationMs: 900_000,
      maxAttempts: 2,
    }, null, 2), 'utf8');

    // Write manifest and run record for run A
    const repoId = await repositoryIdentity(root);
    const manifestA = buildManifest(ctxA, { schemaVersion: 1, mode: 'workspace', concurrency: 2, leaseDurationMs: 900_000, maxAttempts: 2 }, 'active-a', repoId);
    await atomicWriteJson(join(runADir, 'manifest.json'), manifestA);
    await atomicWriteJson(join(runADir, 'run.json'), {
      schemaVersion: 1,
      runId: 'active-a',
      state: 'active',
      manifestDigest: manifestDigest(manifestA),
      repoIdentity: repoId,
      argsFingerprint: manifestA.argsFingerprint,
      diffFingerprint: manifestA.diffFingerprint,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Write a succeeded task
    const tasksDirA = join(runADir, 'tasks');
    await mkdir(tasksDirA, { recursive: true });
    await atomicWriteJson(join(tasksDirA, 'task-1.json'), {
      runId: 'active-a',
      taskId: 'task-1',
      manifestIndex: 0,
      filePath: 'src/a.ts',
      diffFingerprint: manifestA.files[0].diffFingerprint,
      state: 'succeeded',
      attemptsUsed: 1,
      maxAttempts: 2,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Create candidate B with same context
    const candidateDir = join(root, '.ocr-runs', 'candidate-b');
    await mkdir(candidateDir, { recursive: true });
    const ctxB = {
      runId: 'candidate-b',
      repoRoot: root,
      range: 'workspace',
      background: '',
      files: [
        { path: 'src/a.ts', status: 'modified', diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n', truncated: false, hunks: [], rulesHit: [] },
      ],
      changeFiles: ['src/a.ts'],
      meta: { generatedAt: new Date().toISOString(), pluginVersion: '0.1.0' },
    };
    await writeFile(join(candidateDir, 'context.json'), JSON.stringify(ctxB, null, 2), 'utf8');
    await writeFile(join(candidateDir, 'launch.json'), JSON.stringify({
      schemaVersion: 1,
      mode: 'workspace',
      concurrency: 2,
      leaseDurationMs: 900_000,
      maxAttempts: 2,
    }, null, 2), 'utf8');

    const { stdout } = await runCli(root, ['candidate-b']);
    const result = JSON.parse(stdout);

    assert.equal(result.candidateRunId, 'candidate-b');
    assert.equal(result.effectiveRunId, 'active-a');
    assert.equal(result.resumed, true);
    assert.equal(result.state, 'active');
    assert.deepEqual(result.taskCounts, { queued: 0, leased: 0, running: 0, succeeded: 1, failed: 0 });
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// orchestrator_start CLI — supersede on changed diff
// ---------------------------------------------------------------------------

test('orchestrator_start CLI supersedes active run when diff changes', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);

    // Create active run A with one diff
    const runADir = join(root, '.ocr-runs', 'active-a');
    await mkdir(runADir, { recursive: true });
    const ctxA = {
      runId: 'active-a',
      repoRoot: root,
      range: 'workspace',
      background: '',
      files: [
        { path: 'src/a.ts', status: 'modified', diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old content\n+new content\n', truncated: false, hunks: [], rulesHit: [] },
      ],
      changeFiles: ['src/a.ts'],
      meta: { generatedAt: new Date().toISOString(), pluginVersion: '0.1.0' },
    };
    await writeFile(join(runADir, 'context.json'), JSON.stringify(ctxA, null, 2), 'utf8');
    await writeFile(join(runADir, 'launch.json'), JSON.stringify({
      schemaVersion: 1,
      mode: 'workspace',
      concurrency: 2,
      leaseDurationMs: 900_000,
      maxAttempts: 2,
    }, null, 2), 'utf8');

    const repoId = await repositoryIdentity(root);
    const manifestA = buildManifest(ctxA, { schemaVersion: 1, mode: 'workspace', concurrency: 2, leaseDurationMs: 900_000, maxAttempts: 2 }, 'active-a', repoId);
    await atomicWriteJson(join(runADir, 'manifest.json'), manifestA);
    await atomicWriteJson(join(runADir, 'run.json'), {
      schemaVersion: 1,
      runId: 'active-a',
      state: 'active',
      manifestDigest: manifestDigest(manifestA),
      repoIdentity: repoId,
      argsFingerprint: manifestA.argsFingerprint,
      diffFingerprint: manifestA.diffFingerprint,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Create candidate B with different diff
    const candidateDir = join(root, '.ocr-runs', 'candidate-b');
    await mkdir(candidateDir, { recursive: true });
    const ctxB = {
      runId: 'candidate-b',
      repoRoot: root,
      range: 'workspace',
      background: '',
      files: [
        { path: 'src/a.ts', status: 'modified', diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-different old\n+different new\n', truncated: false, hunks: [], rulesHit: [] },
      ],
      changeFiles: ['src/a.ts'],
      meta: { generatedAt: new Date().toISOString(), pluginVersion: '0.1.0' },
    };
    await writeFile(join(candidateDir, 'context.json'), JSON.stringify(ctxB, null, 2), 'utf8');
    await writeFile(join(candidateDir, 'launch.json'), JSON.stringify({
      schemaVersion: 1,
      mode: 'workspace',
      concurrency: 2,
      leaseDurationMs: 900_000,
      maxAttempts: 2,
    }, null, 2), 'utf8');

    const { stdout } = await runCli(root, ['candidate-b']);
    const result = JSON.parse(stdout);

    assert.equal(result.candidateRunId, 'candidate-b');
    assert.equal(result.effectiveRunId, 'candidate-b');
    assert.equal(result.resumed, false);
    assert.equal(result.state, 'active');

    // Verify run A is superseded
    const runARecord = JSON.parse(await readFile(join(runADir, 'run.json'), 'utf8'));
    assert.equal(runARecord.state, 'superseded');
    assert.equal(runARecord.supersededBy, 'candidate-b');
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
