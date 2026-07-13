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

async function invoke(stem: string, args: string[], cwd?: string) {
  return execFileAsync('node', ['--import', TSX_LOADER, join(ROOT, `src/cli/${stem}.ts`), ...args], { cwd });
}

const tempDirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'orc-proto-'));
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
// Helpers
// ---------------------------------------------------------------------------

async function createRunWithTasks(root: string, runId: string, taskCount: number): Promise<void> {
  const runDir = join(root, '.ocr-runs', runId);
  await mkdir(runDir, { recursive: true });

  const ctx = {
    runId,
    repoRoot: root,
    range: 'workspace',
    background: '',
    files: Array.from({ length: taskCount }, (_, i) => ({
      path: `src/file${i}.ts`,
      status: 'modified',
      diff: `diff --git a/src/file${i}.ts b/src/file${i}.ts\n@@ -1 +1 @@\n-old${i}\n+new${i}\n`,
      truncated: false,
      hunks: [],
      rulesHit: [],
    })),
    changeFiles: Array.from({ length: taskCount }, (_, i) => `src/file${i}.ts`),
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

  // Run orchestrator_start to create the run with tasks
  await invoke('orchestrator_start', [runId], root);
}

async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Malformed args — exit 2 with stable stderr prefix
// ---------------------------------------------------------------------------

test('orchestrator_claim exits 2 with stderr prefix for missing args', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await assert.rejects(
      () => invoke('orchestrator_claim', []),
      (err: any) => {
        assert.equal(err.code, 2);
        assert.ok(err.stderr.includes('[orchestrator_claim]'), `stderr missing prefix: ${err.stderr}`);
        return true;
      },
    );
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test('orchestrator_ack exits 2 with stderr prefix for missing args', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await assert.rejects(
      () => invoke('orchestrator_ack', ['--runId', 'test']),
      (err: any) => {
        assert.equal(err.code, 2);
        assert.ok(err.stderr.includes('[orchestrator_ack]'), `stderr missing prefix: ${err.stderr}`);
        return true;
      },
    );
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test('orchestrator_dispatch_fail exits 2 with stderr prefix for missing args', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await assert.rejects(
      () => invoke('orchestrator_dispatch_fail', []),
      (err: any) => {
        assert.equal(err.code, 2);
        assert.ok(err.stderr.includes('[orchestrator_dispatch_fail]'), `stderr missing prefix: ${err.stderr}`);
        return true;
      },
    );
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test('orchestrator_reconcile exits 2 with stderr prefix for missing args', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await assert.rejects(
      () => invoke('orchestrator_reconcile', []),
      (err: any) => {
        assert.equal(err.code, 2);
        assert.ok(err.stderr.includes('[orchestrator_reconcile]'), `stderr missing prefix: ${err.stderr}`);
        return true;
      },
    );
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test('orchestrator_status exits 2 with stderr prefix for missing args', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await assert.rejects(
      () => invoke('orchestrator_status', []),
      (err: any) => {
        assert.equal(err.code, 2);
        assert.ok(err.stderr.includes('[orchestrator_status]'), `stderr missing prefix: ${err.stderr}`);
        return true;
      },
    );
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Claim — capacity validation through core
// ---------------------------------------------------------------------------

test('orchestrator_claim rejects invalid capacity through core', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);
    await createRunWithTasks(root, 'test-run', 3);

    // capacity=0 should fail
    await assert.rejects(
      () => invoke('orchestrator_claim', ['--runId', 'test-run', '--capacity', '0']),
      (err: any) => {
        assert.equal(err.code, 2);
        assert.ok(err.stderr.includes('capacity'), `stderr missing capacity error: ${err.stderr}`);
        return true;
      },
    );

    // capacity=9 should fail
    await assert.rejects(
      () => invoke('orchestrator_claim', ['--runId', 'test-run', '--capacity', '9']),
      (err: any) => {
        assert.equal(err.code, 2);
        assert.ok(err.stderr.includes('capacity'), `stderr missing capacity error: ${err.stderr}`);
        return true;
      },
    );
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Claim — returns JSON array of credentials
// ---------------------------------------------------------------------------

test('orchestrator_claim returns JSON array', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);
    await createRunWithTasks(root, 'test-run', 3);

    const { stdout, stderr } = await invoke('orchestrator_claim', ['--runId', 'test-run', '--capacity', '2']);
    assert.equal(stderr, '', `unexpected stderr: ${stderr}`);

    const claims = JSON.parse(stdout);
    assert.ok(Array.isArray(claims));
    assert.equal(claims.length, 2);
    assert.ok(claims[0].taskId);
    assert.ok(claims[0].attemptId);
    assert.ok(claims[0].leaseToken);
    assert.ok(claims[0].filePath);
    assert.ok(claims[0].diffFingerprint);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Ack — acknowledges a leased task
// ---------------------------------------------------------------------------

test('orchestrator_ack acknowledges a leased task', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);
    await createRunWithTasks(root, 'test-run', 1);

    const claimOut = await invoke('orchestrator_claim', ['--runId', 'test-run', '--capacity', '1']);
    const [claim] = JSON.parse(claimOut.stdout);

    const { stdout, stderr } = await invoke('orchestrator_ack', [
      '--runId', 'test-run',
      '--taskId', claim.taskId,
      '--attemptId', claim.attemptId,
    ]);
    assert.equal(stderr, '', `unexpected stderr: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.deepEqual(result, { ok: true });
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Dispatch fail — reports a dispatch failure
// ---------------------------------------------------------------------------

test('orchestrator_dispatch_fail reports failure and returns ReconcileResult', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);
    await createRunWithTasks(root, 'test-run', 1);

    const claimOut = await invoke('orchestrator_claim', ['--runId', 'test-run', '--capacity', '1']);
    const [claim] = JSON.parse(claimOut.stdout);

    const { stdout, stderr } = await invoke('orchestrator_dispatch_fail', [
      '--runId', 'test-run',
      '--taskId', claim.taskId,
      '--attemptId', claim.attemptId,
    ]);
    assert.equal(stderr, '', `unexpected stderr: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.runId, 'test-run');
    assert.equal(result.state, 'active');
    assert.ok(result.canClaim);
    assert.ok(result.taskCounts);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Reconcile — handles lease expiry
// ---------------------------------------------------------------------------

test('orchestrator_reconcile returns ReconcileResult', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);
    await createRunWithTasks(root, 'test-run', 1);

    const { stdout, stderr } = await invoke('orchestrator_reconcile', ['--runId', 'test-run']);
    assert.equal(stderr, '', `unexpected stderr: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.runId, 'test-run');
    assert.ok(result.taskCounts);
    assert.equal(typeof result.canClaim, 'boolean');
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Status — returns current run state
// ---------------------------------------------------------------------------

test('orchestrator_status returns current run state', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);
    await createRunWithTasks(root, 'test-run', 2);

    const { stdout, stderr } = await invoke('orchestrator_status', ['--runId', 'test-run']);
    assert.equal(stderr, '', `unexpected stderr: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.runId, 'test-run');
    assert.equal(result.state, 'active');
    assert.equal(result.taskCounts.queued, 2);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration: claim + status round-trip
// ---------------------------------------------------------------------------

test('claim emits credentials and status reports the same leased task', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    await initGitRepo(root);
    await createRunWithTasks(root, 'test-run', 3);

    const claims = JSON.parse((await invoke('orchestrator_claim', ['--runId', 'test-run', '--capacity', '1'])).stdout);
    assert.equal(claims.length, 1);

    const status = JSON.parse((await invoke('orchestrator_status', ['--runId', 'test-run'])).stdout);
    assert.equal(status.taskCounts.leased, 1);
    assert.equal(status.taskCounts.queued, 2);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Run not found — exits 2 with stderr prefix
// ---------------------------------------------------------------------------

test('all CLIs exit 2 with stderr prefix when run not found', async () => {
  const root = await tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    for (const [stem, args] of [
      ['orchestrator_claim', ['--runId', 'nonexistent', '--capacity', '1']],
      ['orchestrator_ack', ['--runId', 'nonexistent', '--taskId', 't', '--attemptId', 'a']],
      ['orchestrator_dispatch_fail', ['--runId', 'nonexistent', '--taskId', 't', '--attemptId', 'a']],
      ['orchestrator_reconcile', ['--runId', 'nonexistent']],
      ['orchestrator_status', ['--runId', 'nonexistent']],
    ] as [string, string[]][]) {
      await assert.rejects(
        () => invoke(stem, args),
        (err: any) => {
          assert.equal(err.code, 2, `${stem} should exit 2`);
          assert.ok(err.stderr.includes(`[${stem}]`), `${stem} stderr missing prefix: ${err.stderr}`);
          return true;
        },
      );
    }
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});
