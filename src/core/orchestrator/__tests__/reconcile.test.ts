import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Orchestrator } from '../orchestrator.js';
import type { RunRecord, TaskRecord, ReviewManifest, ManifestFile, AttemptRecord } from '../types.js';
import { ORCHESTRATOR_SCHEMA_VERSION } from '../types.js';
import { sha256, manifestDigest } from '../fingerprint.js';

// ---------------------------------------------------------------------------
// FakeClock — deterministic time for testing
// ---------------------------------------------------------------------------

class FakeClock {
  private _now: number;

  constructor(iso: string) {
    this._now = Date.parse(iso);
  }

  now(): Date {
    return new Date(this._now);
  }

  advance(ms: number): void {
    this._now += ms;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = '/tmp/orchestrator-reconcile-test';

async function tmpDir(): Promise<string> {
  const dir = join(TMP_ROOT, `run-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * Create a minimal valid run directory with N queued tasks.
 */
async function createRunDir(
  runDir: string,
  fileCount: number,
  overrides?: Partial<{
    runState: string;
    taskState: string;
    attemptsUsed: number;
    maxAttempts: number;
  }>,
): Promise<{ runId: string; manifest: ReviewManifest }> {
  const runId = `test-run-${randomUUID().slice(0, 8)}`;
  const createdAt = new Date().toISOString();

  // Build manifest files
  const files: ManifestFile[] = [];
  for (let i = 0; i < fileCount; i++) {
    files.push({
      manifestIndex: i,
      path: `src/file${i}.ts`,
      diffFingerprint: sha256(`diff-${i}`),
      changedLines: i + 1,
      status: 'modified',
    });
  }

  const manifest: ReviewManifest = {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    runId,
    repoIdentity: 'test-repo',
    argsFingerprint: sha256('test-args'),
    diffFingerprint: sha256('test-diff'),
    files,
    excludedFiles: [],
    createdAt,
  };

  const runRecord: RunRecord = {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    runId,
    state: (overrides?.runState as any) ?? 'active',
    manifestDigest: manifestDigest(manifest),
    repoIdentity: 'test-repo',
    argsFingerprint: sha256('test-args'),
    diffFingerprint: sha256('test-diff'),
    createdAt,
    updatedAt: createdAt,
  };

  // Write manifest
  await writeFile(
    join(runDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  // Write run record
  await writeFile(
    join(runDir, 'run.json'),
    JSON.stringify(runRecord, null, 2) + '\n',
  );

  // Write tasks
  const tasksDir = join(runDir, 'tasks');
  await mkdir(tasksDir, { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    const taskId = `task-${i}`;
    const task: TaskRecord = {
      runId,
      taskId,
      manifestIndex: i,
      filePath: `src/file${i}.ts`,
      diffFingerprint: sha256(`diff-${i}`),
      state: (overrides?.taskState as any) ?? 'queued',
      attemptsUsed: overrides?.attemptsUsed ?? 0,
      maxAttempts: overrides?.maxAttempts ?? 2,
      createdAt,
      updatedAt: createdAt,
    };
    await writeFile(
      join(tasksDir, `${taskId}.json`),
      JSON.stringify(task, null, 2) + '\n',
    );
  }

  return { runId, manifest };
}

/**
 * Write an attempt record for a task.
 */
async function writeAttempt(
  runDir: string,
  taskId: string,
  attempt: AttemptRecord,
): Promise<void> {
  const tasksDir = join(runDir, 'tasks');
  await writeFile(
    join(tasksDir, `${taskId}.${attempt.attemptId}.json`),
    JSON.stringify(attempt, null, 2) + '\n',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Orchestrator reconcile and status', () => {
  describe('reconcile()', () => {
    it('expires a leased task whose lease deadline has passed', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const clock = new FakeClock('2026-07-13T00:00:00.000Z');
      const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });

      // Claim a task (lease deadline will be ~900s from now)
      const [claim] = await orchestrator.claim(1);
      assert.ok(claim);

      // Advance clock past the lease deadline
      clock.advance(900_001);

      // Reconcile — should expire the lease
      const result = await orchestrator.reconcile();

      // Task should be back to queued with currentAttemptId cleared
      const tasksDir = join(runDir, 'tasks');
      const taskContent = await readFile(join(tasksDir, `${claim.taskId}.json`), 'utf8');
      const task = JSON.parse(taskContent) as TaskRecord;
      assert.equal(task.state, 'queued');
      assert.equal(task.currentAttemptId, undefined);
      assert.equal(task.failureReason, 'lease_expired');
      assert.equal(task.attemptsUsed, 1);

      // Attempt should be expired
      const attemptContent = await readFile(
        join(tasksDir, `${claim.taskId}.${claim.attemptId}.json`),
        'utf8',
      );
      const attempt = JSON.parse(attemptContent) as AttemptRecord;
      assert.equal(attempt.state, 'expired');
      assert.equal(attempt.failureReason, 'lease_expired');

      // Run should still be active
      assert.equal(result.state, 'active');
      assert.equal(result.taskCounts.queued, 1);
      assert.equal(result.taskCounts.leased, 0);

      await cleanup(runDir);
    });

    it('expires a running task whose lease deadline has passed', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const clock = new FakeClock('2026-07-13T00:00:00.000Z');
      const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });

      // Claim and acknowledge (task becomes running)
      const [claim] = await orchestrator.claim(1);
      await orchestrator.acknowledgeDispatch(claim.taskId, claim.attemptId);

      // Advance clock past the lease deadline
      clock.advance(900_001);

      // Reconcile — should expire the lease even for running tasks
      const result = await orchestrator.reconcile();

      // Task should be back to queued
      const tasksDir = join(runDir, 'tasks');
      const taskContent = await readFile(join(tasksDir, `${claim.taskId}.json`), 'utf8');
      const task = JSON.parse(taskContent) as TaskRecord;
      assert.equal(task.state, 'queued');
      assert.equal(task.currentAttemptId, undefined);
      assert.equal(task.failureReason, 'lease_expired');
      assert.equal(task.attemptsUsed, 1);

      // Run should still be active
      assert.equal(result.state, 'active');

      await cleanup(runDir);
    });

    it('retries task after lease expiry when attempts remain', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const clock = new FakeClock('2026-07-13T00:00:00.000Z');
      const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });

      // Claim a task
      const [claim] = await orchestrator.claim(1);
      clock.advance(900_001);

      // First reconcile — lease expired, task re-queued
      await orchestrator.reconcile();

      // Task should be queued with attemptsUsed=1
      const tasksDir = join(runDir, 'tasks');
      const taskContent = await readFile(join(tasksDir, `${claim.taskId}.json`), 'utf8');
      const task = JSON.parse(taskContent) as TaskRecord;
      assert.equal(task.state, 'queued');
      assert.equal(task.attemptsUsed, 1);

      // Claim again (second attempt)
      const [claim2] = await orchestrator.claim(1);
      assert.ok(claim2);
      clock.advance(900_001);

      // Second reconcile — lease expired again, task exhausted
      const result = await orchestrator.reconcile();

      const taskContent2 = await readFile(join(tasksDir, `${claim.taskId}.json`), 'utf8');
      const task2 = JSON.parse(taskContent2) as TaskRecord;
      assert.equal(task2.state, 'failed');
      assert.equal(task2.failureReason, 'retry_exhausted');
      assert.equal(task2.attemptsUsed, 2);

      // Run should be failed since the only task has exhausted
      assert.equal(result.state, 'failed');

      await cleanup(runDir);
    });

    it('does not expire a leased task whose lease is still valid', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const clock = new FakeClock('2026-07-13T00:00:00.000Z');
      const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });

      const [claim] = await orchestrator.claim(1);

      // Advance clock slightly but not past deadline
      clock.advance(100);

      const result = await orchestrator.reconcile();

      // Task should still be leased
      const tasksDir = join(runDir, 'tasks');
      const taskContent = await readFile(join(tasksDir, `${claim.taskId}.json`), 'utf8');
      const task = JSON.parse(taskContent) as TaskRecord;
      assert.equal(task.state, 'leased');
      assert.equal(task.currentAttemptId, claim.attemptId);

      // Run should be active
      assert.equal(result.state, 'active');

      await cleanup(runDir);
    });

    it('is idempotent — second call returns same counts', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const clock = new FakeClock('2026-07-13T00:00:00.000Z');
      const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });

      const [claim] = await orchestrator.claim(1);
      clock.advance(900_001);

      const first = await orchestrator.reconcile();
      const second = await orchestrator.reconcile();

      assert.deepEqual(second.taskCounts, first.taskCounts);
      assert.equal(second.state, first.state);

      await cleanup(runDir);
    });

    it('sets nextLeaseDeadline to the earliest live lease', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 3);
      const clock = new FakeClock('2026-07-13T00:00:00.000Z');
      const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });

      // Claim 2 tasks
      const claims = await orchestrator.claim(2);
      assert.equal(claims.length, 2);

      // Acknowledge one so it's running
      await orchestrator.acknowledgeDispatch(claims[0].taskId, claims[0].attemptId);

      // Advance a bit but not past deadline
      clock.advance(100);

      const result = await orchestrator.reconcile();

      // nextLeaseDeadline should be set (the earliest of the two live leases)
      assert.ok(result.nextLeaseDeadline);
      // The deadline should be in the future relative to now
      assert.ok(Date.parse(result.nextLeaseDeadline) > clock.now().getTime());

      await cleanup(runDir);
    });

    it('sets nextLeaseDeadline to undefined when no live leases remain', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const clock = new FakeClock('2026-07-13T00:00:00.000Z');
      const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });

      await orchestrator.claim(1);
      clock.advance(900_001);

      const result = await orchestrator.reconcile();

      // After expiry, no live leases remain
      assert.equal(result.nextLeaseDeadline, undefined);

      await cleanup(runDir);
    });

    it('derives run.json terminal state from task records', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const clock = new FakeClock('2026-07-13T00:00:00.000Z');
      const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });

      // Exhaust the task through lease expiry
      const [claim] = await orchestrator.claim(1);
      clock.advance(900_001);
      await orchestrator.reconcile();

      // Claim again (second attempt)
      const [claim2] = await orchestrator.claim(1);
      clock.advance(900_001);
      await orchestrator.reconcile();

      // Read run.json
      const runRecord = JSON.parse(
        await readFile(join(runDir, 'run.json'), 'utf8'),
      ) as RunRecord;
      assert.equal(runRecord.state, 'failed');
      assert.ok(runRecord.completedAt);
      assert.equal(runRecord.completedAt, runRecord.updatedAt);

      await cleanup(runDir);
    });
  });

  describe('status()', () => {
    it('returns current state without expiring leases', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const clock = new FakeClock('2026-07-13T00:00:00.000Z');
      const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });

      const [claim] = await orchestrator.claim(1);
      clock.advance(900_001);

      // status() should NOT expire the lease
      const result = await orchestrator.status();

      const tasksDir = join(runDir, 'tasks');
      const taskContent = await readFile(join(tasksDir, `${claim.taskId}.json`), 'utf8');
      const task = JSON.parse(taskContent) as TaskRecord;
      // Task should still be leased — status() does not expire
      assert.equal(task.state, 'leased');

      // But result should reflect current state
      assert.equal(result.state, 'active');
      assert.equal(result.taskCounts.leased, 1);

      await cleanup(runDir);
    });
  });

  describe('audit events respect injected clock', () => {
    it('uses injected time for audit event timestamps', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const clock = new FakeClock('2026-07-13T12:30:00.000Z');
      const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });

      // Claim emits audit events — timestamp should match injected clock
      const [claim] = await orchestrator.claim(1);
      const auditFile = join(runDir, 'audit.jsonl');
      const content = await readFile(auditFile, 'utf8');
      const lines = content.trim().split('\n');

      for (const line of lines) {
        const event = JSON.parse(line);
        // The injected time is 2026-07-13T12:30:00.000Z
        assert.equal(event.ts, '2026-07-13T12:30:00.000Z');
      }

      await cleanup(runDir);
    });
  });

  describe('reconcile with mixed states', () => {
    it('only expires tasks with currentAttemptId set', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 3);
      const clock = new FakeClock('2026-07-13T00:00:00.000Z');
      const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });

      // Claim 2 tasks
      const claims = await orchestrator.claim(2);
      // Acknowledge the first
      await orchestrator.acknowledgeDispatch(claims[0].taskId, claims[0].attemptId);

      clock.advance(900_001);

      const result = await orchestrator.reconcile();

      // Both claimed tasks should have been expired
      const tasksDir = join(runDir, 'tasks');
      for (const claim of claims) {
        const taskContent = await readFile(join(tasksDir, `${claim.taskId}.json`), 'utf8');
        const task = JSON.parse(taskContent) as TaskRecord;
        assert.equal(task.state, 'queued');
      }

      // The third task (never claimed) should still be queued
      const task2Content = await readFile(join(tasksDir, 'task-2.json'), 'utf8');
      const task2 = JSON.parse(task2Content) as TaskRecord;
      assert.equal(task2.state, 'queued');

      assert.equal(result.taskCounts.queued, 3);

      await cleanup(runDir);
    });

    it('handles completed tasks without interference', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 2);
      const clock = new FakeClock('2026-07-13T00:00:00.000Z');
      const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });

      // Set task-0 to succeeded manually
      const tasksDir = join(runDir, 'tasks');
      const task0 = JSON.parse(
        await readFile(join(tasksDir, 'task-0.json'), 'utf8'),
      ) as TaskRecord;
      task0.state = 'succeeded';
      task0.attemptsUsed = 1;
      await writeFile(join(tasksDir, 'task-0.json'), JSON.stringify(task0, null, 2) + '\n');

      // Claim task-1
      const [claim] = await orchestrator.claim(1);
      clock.advance(900_001);

      const result = await orchestrator.reconcile();

      // task-0 should remain succeeded
      const task0After = JSON.parse(
        await readFile(join(tasksDir, 'task-0.json'), 'utf8'),
      ) as TaskRecord;
      assert.equal(task0After.state, 'succeeded');

      // task-1 should be re-queued
      const task1After = JSON.parse(
        await readFile(join(tasksDir, 'task-1.json'), 'utf8'),
      ) as TaskRecord;
      assert.equal(task1After.state, 'queued');

      await cleanup(runDir);
    });
  });
});
