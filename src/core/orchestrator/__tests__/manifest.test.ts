import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewContext } from '../../model/request.js';
import type { LaunchConfig, ReviewManifest, RunRecord, TaskRecord } from '../types.js';
import { ORCHESTRATOR_SCHEMA_VERSION } from '../types.js';
import { canonicalJson, sha256, repositoryIdentity, buildManifest, manifestDigest } from '../fingerprint.js';
import { selectEffectiveRun, startCandidate } from '../manifest.js';
import { atomicWriteJson } from '../storage.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'orc-manifest-'));
  tempDirs.push(d);
  return d;
}

async function initGitRepo(repoRoot: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  await execFileAsync('git', ['init'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.email', 'test@test'], { cwd: repoRoot });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
  await execFileAsync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoRoot });
}

function makeContext(repoRoot: string, overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    runId: 'candidate',
    repoRoot,
    range: 'workspace',
    background: '',
    files: [
      {
        path: 'src/a.ts',
        status: 'modified',
        diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n',
        truncated: false,
        hunks: [],
        rulesHit: [],
      },
    ],
    changeFiles: ['src/a.ts'],
    meta: { generatedAt: new Date().toISOString(), pluginVersion: '0.1.0' },
    ...overrides,
  };
}

function makeLaunchConfig(overrides: Partial<LaunchConfig> = {}): LaunchConfig {
  return {
    schemaVersion: 1,
    mode: 'workspace',
    concurrency: 2,
    leaseDurationMs: 900_000,
    maxAttempts: 2,
    ...overrides,
  };
}

async function writeManifest(runDir: string, manifest: ReviewManifest): Promise<void> {
  await atomicWriteJson(join(runDir, 'manifest.json'), manifest);
}

async function writeRunRecord(runDir: string, record: RunRecord): Promise<void> {
  await atomicWriteJson(join(runDir, 'run.json'), record);
}

async function writeTaskRecord(runDir: string, task: TaskRecord): Promise<void> {
  const tasksDir = join(runDir, 'tasks');
  await mkdir(tasksDir, { recursive: true });
  await atomicWriteJson(join(tasksDir, `${task.taskId}.json`), task);
}

async function writeTasksDir(runDir: string, tasks: TaskRecord[]): Promise<void> {
  for (const t of tasks) {
    await writeTaskRecord(runDir, t);
  }
}

after(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// canonicalJson
// ---------------------------------------------------------------------------

test('canonicalJson sorts keys recursively', () => {
  const a = canonicalJson({ b: 2, a: 1, c: { z: 9, y: 8 } });
  const b = canonicalJson({ a: 1, b: 2, c: { y: 8, z: 9 } });
  assert.equal(a, b);
  assert.equal(a, '{"a":1,"b":2,"c":{"y":8,"z":9}}');
});

test('canonicalJson preserves array order', () => {
  const a = canonicalJson([3, 1, 2]);
  const b = canonicalJson([3, 1, 2]);
  assert.equal(a, b);
  assert.notEqual(a, canonicalJson([1, 2, 3]));
});

test('canonicalJson handles nested arrays and objects', () => {
  const v = { items: [{ b: 2, a: 1 }, { d: 4, c: 3 }] };
  const s = canonicalJson(v);
  assert.equal(s, '{"items":[{"a":1,"b":2},{"c":3,"d":4}]}');
});

// ---------------------------------------------------------------------------
// sha256
// ---------------------------------------------------------------------------

test('sha256 produces hex digest', () => {
  const digest = sha256('hello');
  assert.equal(digest.length, 64);
  assert.match(digest, /^[a-f0-9]{64}$/);
});

test('sha256 is deterministic', () => {
  assert.equal(sha256('hello'), sha256('hello'));
  assert.notEqual(sha256('hello'), sha256('world'));
});

// ---------------------------------------------------------------------------
// repositoryIdentity
// ---------------------------------------------------------------------------

test('repositoryIdentity returns a stable hash for a git repo', async () => {
  const repo = await tmpDir();
  await initGitRepo(repo);
  const id1 = await repositoryIdentity(repo);
  const id2 = await repositoryIdentity(repo);
  assert.equal(id1, id2);
  assert.match(id1, /^[a-f0-9]{64}$/);
});

// ---------------------------------------------------------------------------
// buildManifest
// ---------------------------------------------------------------------------

test('buildManifest creates a stable manifest with correct fingerprints', async () => {
  const repo = await tmpDir();
  await initGitRepo(repo);
  const ctx = makeContext(repo);
  const launch = makeLaunchConfig();
  const repoId = await repositoryIdentity(repo);
  const manifest = buildManifest(ctx, launch, 'run-1', repoId);

  assert.equal(manifest.schemaVersion, ORCHESTRATOR_SCHEMA_VERSION);
  assert.equal(manifest.runId, 'run-1');
  assert.equal(manifest.repoIdentity, repoId);
  assert.match(manifest.argsFingerprint, /^[a-f0-9]{64}$/);
  assert.match(manifest.diffFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(manifest.files.length, 1);
  assert.equal(manifest.files[0].path, 'src/a.ts');
  assert.equal(manifest.files[0].manifestIndex, 0);
  assert.match(manifest.files[0].diffFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(manifest.files[0].changedLines, 2);
  assert.equal(manifest.files[0].status, 'modified');
  assert.ok(manifest.createdAt);
});

test('buildManifest file order matches context file order', async () => {
  const repo = await tmpDir();
  await initGitRepo(repo);
  const ctx = makeContext(repo, {
    files: [
      { path: 'src/b.ts', status: 'added', diff: 'diff --git a/src/b.ts b/src/b.ts\n@@ -0,0 +1 @@\n+new file\n', truncated: false, hunks: [], rulesHit: [] },
      { path: 'src/a.ts', status: 'modified', diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n', truncated: false, hunks: [], rulesHit: [] },
    ],
    changeFiles: ['src/b.ts', 'src/a.ts'],
  });
  const launch = makeLaunchConfig();
  const repoId = await repositoryIdentity(repo);
  const manifest = buildManifest(ctx, launch, 'run-1', repoId);

  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.files[0].path, 'src/b.ts');
  assert.equal(manifest.files[1].path, 'src/a.ts');
});

test('buildManifest diff fingerprint is sensitive to file content order', async () => {
  const repo = await tmpDir();
  await initGitRepo(repo);
  const repoId = await repositoryIdentity(repo);

  const ctxA = makeContext(repo, {
    files: [
      { path: 'src/a.ts', status: 'modified', diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n', truncated: false, hunks: [], rulesHit: [] },
      { path: 'src/b.ts', status: 'modified', diff: 'diff --git a/src/b.ts b/src/b.ts\n@@ -1 +1 @@\n-x\n+y\n', truncated: false, hunks: [], rulesHit: [] },
    ],
    changeFiles: ['src/a.ts', 'src/b.ts'],
  });

  const ctxB = makeContext(repo, {
    files: [
      { path: 'src/b.ts', status: 'modified', diff: 'diff --git a/src/b.ts b/src/b.ts\n@@ -1 +1 @@\n-x\n+y\n', truncated: false, hunks: [], rulesHit: [] },
      { path: 'src/a.ts', status: 'modified', diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n', truncated: false, hunks: [], rulesHit: [] },
    ],
    changeFiles: ['src/b.ts', 'src/a.ts'],
  });

  const m1 = buildManifest(ctxA, makeLaunchConfig(), 'run-1', repoId);
  const m2 = buildManifest(ctxB, makeLaunchConfig(), 'run-2', repoId);
  assert.notEqual(m1.diffFingerprint, m2.diffFingerprint);
});

test('buildManifest diff fingerprint is unambiguous across file boundaries', async () => {
  const repo = await tmpDir();
  await initGitRepo(repo);
  const repoId = await repositoryIdentity(repo);

  const ctxA = makeContext(repo, {
    files: [
      { path: 'src/a.ts', status: 'modified', diff: 'line1\nline2', truncated: false, hunks: [], rulesHit: [] },
      { path: 'src/b.ts', status: 'modified', diff: 'line3', truncated: false, hunks: [], rulesHit: [] },
    ],
    changeFiles: ['src/a.ts', 'src/b.ts'],
  });

  const ctxB = makeContext(repo, {
    files: [
      { path: 'src/a.ts', status: 'modified', diff: 'line1', truncated: false, hunks: [], rulesHit: [] },
      { path: 'src/b.ts', status: 'modified', diff: 'line2\nline3', truncated: false, hunks: [], rulesHit: [] },
    ],
    changeFiles: ['src/a.ts', 'src/b.ts'],
  });

  const m1 = buildManifest(ctxA, makeLaunchConfig(), 'run-1', repoId);
  const m2 = buildManifest(ctxB, makeLaunchConfig(), 'run-2', repoId);
  assert.notEqual(m1.diffFingerprint, m2.diffFingerprint);
});

// ---------------------------------------------------------------------------
// manifestDigest
// ---------------------------------------------------------------------------

test('manifestDigest returns a deterministic hash of the manifest', async () => {
  const repo = await tmpDir();
  await initGitRepo(repo);
  const ctx = makeContext(repo);
  const launch = makeLaunchConfig();
  const repoId = await repositoryIdentity(repo);
  const manifest = buildManifest(ctx, launch, 'run-1', repoId);
  const digest = manifestDigest(manifest);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, manifestDigest(manifest));
});

// ---------------------------------------------------------------------------
// selectEffectiveRun — fresh start
// ---------------------------------------------------------------------------

test('selectEffectiveRun returns candidate when no prior runs exist', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);

    const candidateDir = join(root, '.ocr-runs', 'candidate');
    await mkdir(candidateDir, { recursive: true });
    const ctx = makeContext(root, { runId: 'candidate' });
    await writeFile(join(candidateDir, 'context.json'), JSON.stringify(ctx, null, 2), 'utf8');
    await writeFile(join(candidateDir, 'launch.json'), JSON.stringify(makeLaunchConfig(), null, 2), 'utf8');

    const repoId = await repositoryIdentity(root);
    const manifest = buildManifest(ctx, makeLaunchConfig(), 'candidate', repoId);

    const result = await selectEffectiveRun('candidate', manifest, root);
    assert.equal(result.effectiveRunId, 'candidate');
    assert.equal(result.resumed, false);
    assert.equal(result.state, 'active');
    assert.deepEqual(result.taskCounts, { queued: 1, leased: 0, running: 0, succeeded: 0, failed: 0 });
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// selectEffectiveRun — resume
// ---------------------------------------------------------------------------

test('selectEffectiveRun resumes compatible active run', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);

    const runADir = join(root, '.ocr-runs', 'active-a');
    await mkdir(runADir, { recursive: true });
    const ctxA = makeContext(root, { runId: 'active-a' });
    await writeFile(join(runADir, 'context.json'), JSON.stringify(ctxA, null, 2), 'utf8');
    await writeFile(join(runADir, 'launch.json'), JSON.stringify(makeLaunchConfig(), null, 2), 'utf8');

    const repoId = await repositoryIdentity(root);
    const manifestA = buildManifest(ctxA, makeLaunchConfig(), 'active-a', repoId);
    await writeManifest(runADir, manifestA);

    await writeRunRecord(runADir, {
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

    await writeTasksDir(runADir, [{
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
    }]);

    const candidateDir = join(root, '.ocr-runs', 'candidate-b');
    await mkdir(candidateDir, { recursive: true });
    const ctxB = makeContext(root, { runId: 'candidate-b' });
    await writeFile(join(candidateDir, 'context.json'), JSON.stringify(ctxB, null, 2), 'utf8');
    await writeFile(join(candidateDir, 'launch.json'), JSON.stringify(makeLaunchConfig(), null, 2), 'utf8');

    const manifestB = buildManifest(ctxB, makeLaunchConfig(), 'candidate-b', repoId);

    const result = await selectEffectiveRun('candidate-b', manifestB, root);
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
// selectEffectiveRun — changed diff creates candidate (supersede)
// ---------------------------------------------------------------------------

test('selectEffectiveRun supersedes active run when diff changes', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);

    const runADir = join(root, '.ocr-runs', 'active-a');
    await mkdir(runADir, { recursive: true });
    const ctxA = makeContext(root, {
      runId: 'active-a',
      files: [
        { path: 'src/a.ts', status: 'modified', diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old content\n+new content\n', truncated: false, hunks: [], rulesHit: [] },
      ],
      changeFiles: ['src/a.ts'],
    });
    await writeFile(join(runADir, 'context.json'), JSON.stringify(ctxA, null, 2), 'utf8');
    await writeFile(join(runADir, 'launch.json'), JSON.stringify(makeLaunchConfig(), null, 2), 'utf8');

    const repoId = await repositoryIdentity(root);
    const manifestA = buildManifest(ctxA, makeLaunchConfig(), 'active-a', repoId);
    await writeManifest(runADir, manifestA);
    await writeRunRecord(runADir, {
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

    const candidateDir = join(root, '.ocr-runs', 'candidate-b');
    await mkdir(candidateDir, { recursive: true });
    const ctxB = makeContext(root, {
      runId: 'candidate-b',
      files: [
        { path: 'src/a.ts', status: 'modified', diff: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-different old\n+different new\n', truncated: false, hunks: [], rulesHit: [] },
      ],
      changeFiles: ['src/a.ts'],
    });
    await writeFile(join(candidateDir, 'context.json'), JSON.stringify(ctxB, null, 2), 'utf8');
    await writeFile(join(candidateDir, 'launch.json'), JSON.stringify(makeLaunchConfig(), null, 2), 'utf8');

    const manifestB = buildManifest(ctxB, makeLaunchConfig(), 'candidate-b', repoId);

    const result = await selectEffectiveRun('candidate-b', manifestB, root);
    assert.equal(result.effectiveRunId, 'candidate-b');
    assert.equal(result.resumed, false);
    assert.equal(result.state, 'active');

    const runARecord = JSON.parse(await readFile(join(runADir, 'run.json'), 'utf8')) as RunRecord;
    assert.equal(runARecord.state, 'superseded');
    assert.equal(runARecord.supersededBy, 'candidate-b');
    assert.ok(runARecord.supersededAt);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// selectEffectiveRun — never resume old-schema runs
// ---------------------------------------------------------------------------

test('selectEffectiveRun never resumes a run without schema-1 manifest', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);

    const runADir = join(root, '.ocr-runs', 'old-a');
    await mkdir(runADir, { recursive: true });
    const ctxA = makeContext(root, { runId: 'old-a' });
    await writeFile(join(runADir, 'context.json'), JSON.stringify(ctxA, null, 2), 'utf8');
    await writeFile(join(runADir, 'launch.json'), JSON.stringify(makeLaunchConfig(), null, 2), 'utf8');

    const repoId = await repositoryIdentity(root);
    const manifestA = buildManifest(ctxA, makeLaunchConfig(), 'old-a', repoId);
    await writeRunRecord(runADir, {
      schemaVersion: 1,
      runId: 'old-a',
      state: 'active',
      manifestDigest: manifestDigest(manifestA),
      repoIdentity: repoId,
      argsFingerprint: manifestA.argsFingerprint,
      diffFingerprint: manifestA.diffFingerprint,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const candidateDir = join(root, '.ocr-runs', 'candidate-b');
    await mkdir(candidateDir, { recursive: true });
    const ctxB = makeContext(root, { runId: 'candidate-b' });
    await writeFile(join(candidateDir, 'context.json'), JSON.stringify(ctxB, null, 2), 'utf8');
    await writeFile(join(candidateDir, 'launch.json'), JSON.stringify(makeLaunchConfig(), null, 2), 'utf8');

    const manifestB = buildManifest(ctxB, makeLaunchConfig(), 'candidate-b', repoId);

    const result = await selectEffectiveRun('candidate-b', manifestB, root);
    assert.equal(result.effectiveRunId, 'candidate-b');
    assert.equal(result.resumed, false);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// selectEffectiveRun — resume only active runs
// ---------------------------------------------------------------------------

test('selectEffectiveRun does not resume completed or failed runs', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);

    const runADir = join(root, '.ocr-runs', 'completed-a');
    await mkdir(runADir, { recursive: true });
    const ctxA = makeContext(root, { runId: 'completed-a' });
    await writeFile(join(runADir, 'context.json'), JSON.stringify(ctxA, null, 2), 'utf8');
    await writeFile(join(runADir, 'launch.json'), JSON.stringify(makeLaunchConfig(), null, 2), 'utf8');

    const repoId = await repositoryIdentity(root);
    const manifestA = buildManifest(ctxA, makeLaunchConfig(), 'completed-a', repoId);
    await writeManifest(runADir, manifestA);
    await writeRunRecord(runADir, {
      schemaVersion: 1,
      runId: 'completed-a',
      state: 'completed',
      manifestDigest: manifestDigest(manifestA),
      repoIdentity: repoId,
      argsFingerprint: manifestA.argsFingerprint,
      diffFingerprint: manifestA.diffFingerprint,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });

    const candidateDir = join(root, '.ocr-runs', 'candidate-b');
    await mkdir(candidateDir, { recursive: true });
    const ctxB = makeContext(root, { runId: 'candidate-b' });
    await writeFile(join(candidateDir, 'context.json'), JSON.stringify(ctxB, null, 2), 'utf8');
    await writeFile(join(candidateDir, 'launch.json'), JSON.stringify(makeLaunchConfig(), null, 2), 'utf8');

    const manifestB = buildManifest(ctxB, makeLaunchConfig(), 'candidate-b', repoId);

    const result = await selectEffectiveRun('candidate-b', manifestB, root);
    assert.equal(result.effectiveRunId, 'candidate-b');
    assert.equal(result.resumed, false);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// startCandidate — the high-level API from the brief
// ---------------------------------------------------------------------------

test('startCandidate returns the compatible active run instead of the candidate', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);

    const runADir = join(root, '.ocr-runs', 'active-a');
    await mkdir(runADir, { recursive: true });
    const ctxA = makeContext(root, { runId: 'active-a' });
    await writeFile(join(runADir, 'context.json'), JSON.stringify(ctxA, null, 2), 'utf8');
    await writeFile(join(runADir, 'launch.json'), JSON.stringify(makeLaunchConfig(), null, 2), 'utf8');

    const repoId = await repositoryIdentity(root);
    const manifestA = buildManifest(ctxA, makeLaunchConfig(), 'active-a', repoId);
    await writeManifest(runADir, manifestA);
    await writeRunRecord(runADir, {
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

    await writeTasksDir(runADir, [{
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
    }]);

    const candidateDir = join(root, '.ocr-runs', 'candidate-b');
    await mkdir(candidateDir, { recursive: true });
    const ctxB = makeContext(root, { runId: 'candidate-b' });
    await writeFile(join(candidateDir, 'context.json'), JSON.stringify(ctxB, null, 2), 'utf8');
    await writeFile(join(candidateDir, 'launch.json'), JSON.stringify(makeLaunchConfig(), null, 2), 'utf8');

    const result = await startCandidate('candidate-b');
    assert.deepEqual(result, {
      candidateRunId: 'candidate-b',
      effectiveRunId: 'active-a',
      resumed: true,
      state: 'active',
      taskCounts: { queued: 0, leased: 0, running: 0, succeeded: 1, failed: 0 },
    });
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});
