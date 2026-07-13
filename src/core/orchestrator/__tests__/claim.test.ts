import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Orchestrator } from '../orchestrator.js';
import type { RunRecord, TaskRecord, ReviewManifest, ManifestFile } from '../types.js';
import { ORCHESTRATOR_SCHEMA_VERSION } from '../types.js';
import { sha256, manifestDigest } from '../fingerprint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = '/tmp/orchestrator-claim-test';

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Orchestrator claim and dispatch', () => {
  describe('claim()', () => {
    it('rejects capacity less than 1', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 3);
      const orchestrator = new Orchestrator(runDir);

      await assert.rejects(
        () => orchestrator.claim(0),
        { message: /capacity/i },
      );
      await assert.rejects(
        () => orchestrator.claim(-1),
        { message: /capacity/i },
      );

      await cleanup(runDir);
    });

    it('rejects capacity greater than 8', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 3);
      const orchestrator = new Orchestrator(runDir);

      await assert.rejects(
        () => orchestrator.claim(9),
        { message: /capacity/i },
      );

      await cleanup(runDir);
    });

    it('returns tasks in manifest order', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 5);
      const orchestrator = new Orchestrator(runDir);

      const results = await orchestrator.claim(3);
      assert.equal(results.length, 3);
      assert.equal(results[0].taskId, 'task-0');
      assert.equal(results[1].taskId, 'task-1');
      assert.equal(results[2].taskId, 'task-2');

      await cleanup(runDir);
    });

    it('returns unique high-entropy lease tokens', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 4);
      const orchestrator = new Orchestrator(runDir);

      const results = await orchestrator.claim(4);
      assert.equal(results.length, 4);

      // All tokens should be unique
      const tokens = results.map((r) => r.leaseToken);
      assert.equal(new Set(tokens).size, 4);

      // Each token should be a base64url string (no + / or =)
      for (const token of tokens) {
        assert(token.length > 32);
        assert(/^[A-Za-z0-9_-]+$/.test(token));
      }

      await cleanup(runDir);
    });

    it('persists only SHA-256 digest of lease token, never plaintext', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 2);
      const orchestrator = new Orchestrator(runDir);

      const results = await orchestrator.claim(2);

      // Read back the attempt records
      const tasksDir = join(runDir, 'tasks');
      const files = await readdir(tasksDir);
      const allContent = await Promise.all(
        files
          .filter((f) => f.endsWith('.json'))
          .map((f) => readFile(join(tasksDir, f), 'utf8')),
      );

      for (const content of allContent) {
        const parsed = JSON.parse(content);
        // If it's an attempt record, check it
        if (parsed.attemptId) {
          // Plaintext token must NOT appear in persisted files
          for (const result of results) {
            assert.ok(
              !content.includes(result.leaseToken),
              `Plaintext lease token found in persisted file: ${result.leaseToken}`,
            );
          }
          // Must have a leaseTokenDigest field
          assert.ok(parsed.leaseTokenDigest);
          assert.equal(parsed.leaseTokenDigest.length, 64); // SHA-256 hex
        }
      }

      await cleanup(runDir);
    });

    it('concurrent claims never lease the same logical task twice', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 6);
      const orchestrator = new Orchestrator(runDir);

      const batches = await Promise.all([
        orchestrator.claim(3),
        orchestrator.claim(3),
      ]);
      const taskIds = batches.flat().map((claim) => claim.taskId);
      assert.equal(new Set(taskIds).size, taskIds.length);

      await cleanup(runDir);
    });

    it('does not exceed capacity across repeated claims while leases are live', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 4);
      const orchestrator = new Orchestrator(runDir);

      const first = await orchestrator.claim(2);
      assert.equal(first.length, 2);
      const second = await orchestrator.claim(2);
      assert.deepEqual(second, []);

      const status = await orchestrator.status();
      assert.equal(status.taskCounts.leased, 2);
      assert.equal(status.taskCounts.queued, 2);
      await cleanup(runDir);
    });

    it('returns empty array when no queued tasks remain', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 2, { taskState: 'succeeded' });
      const orchestrator = new Orchestrator(runDir);

      const results = await orchestrator.claim(2);
      assert.equal(results.length, 0);

      await cleanup(runDir);
    });

    it('returns fewer tasks than capacity if not enough queued', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      const results = await orchestrator.claim(3);
      assert.equal(results.length, 1);

      await cleanup(runDir);
    });

    it('emits audit events for accepted claims', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 2);
      const orchestrator = new Orchestrator(runDir);

      const results = await orchestrator.claim(2);
      assert.equal(results.length, 2);

      // Check audit log exists
      const auditFile = join(runDir, 'audit.jsonl');
      const content = await readFile(auditFile, 'utf8');
      const lines = content.trim().split('\n');

      // Should have at least 2 claim events
      const claimEvents = lines.filter((l) => JSON.parse(l).type === 'claim.accepted');
      assert.equal(claimEvents.length, 2);

      // Events must not contain plaintext lease tokens
      for (const line of lines) {
        for (const result of results) {
          assert.ok(
            !line.includes(result.leaseToken),
            'Audit event contains plaintext lease token',
          );
        }
      }

      await cleanup(runDir);
    });

    it('emits audit events for rejected claims', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      // Claim the only task
      await orchestrator.claim(2);

      // Try again — should be rejected
      const results = await orchestrator.claim(2);
      assert.equal(results.length, 0);

      // Check audit log for rejection events
      const auditFile = join(runDir, 'audit.jsonl');
      const content = await readFile(auditFile, 'utf8');
      const lines = content.trim().split('\n');
      const rejectEvents = lines.filter((l) => JSON.parse(l).type === 'claim.rejected');
      assert.ok(rejectEvents.length > 0);

      await cleanup(runDir);
    });
  });

  describe('acknowledgeDispatch()', () => {
    it('transitions task from leased to running', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      const [claim] = await orchestrator.claim(1);
      assert.ok(claim);

      await orchestrator.acknowledgeDispatch(claim.taskId, claim.attemptId);

      // Verify task state
      const tasksDir = join(runDir, 'tasks');
      const taskContent = await readFile(join(tasksDir, `${claim.taskId}.json`), 'utf8');
      const task = JSON.parse(taskContent) as TaskRecord;
      assert.equal(task.state, 'running');
      // currentAttemptId is preserved (still points to the accepted attempt)
      assert.equal(task.currentAttemptId, claim.attemptId);
      // acceptedAttemptId is NOT set by acknowledgeDispatch (only by Task 7 completion)
      assert.equal(task.acceptedAttemptId, undefined);

      await cleanup(runDir);
    });

    it('rejects acknowledgement for non-existent task', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      await assert.rejects(
        () => orchestrator.acknowledgeDispatch('task-999', 'attempt-xxx'),
        { message: /task.*not found/i },
      );

      await cleanup(runDir);
    });

    it('rejects acknowledgement with wrong attempt ID', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      await orchestrator.claim(1);

      await assert.rejects(
        () => orchestrator.acknowledgeDispatch('task-0', 'wrong-attempt-id'),
        { message: /attempt.*mismatch/i },
      );

      await cleanup(runDir);
    });

    it('rejects acknowledgement for non-leased task', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      // Task is still queued, not leased
      await assert.rejects(
        () => orchestrator.acknowledgeDispatch('task-0', 'some-attempt'),
        { message: /not.*leased/i },
      );

      await cleanup(runDir);
    });

    it('emits audit event on dispatch acknowledgement', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      const [claim] = await orchestrator.claim(1);
      await orchestrator.acknowledgeDispatch(claim.taskId, claim.attemptId);

      const auditFile = join(runDir, 'audit.jsonl');
      const content = await readFile(auditFile, 'utf8');
      const lines = content.trim().split('\n');
      const ackEvents = lines.filter((l) => JSON.parse(l).type === 'dispatch.acknowledged');
      assert.equal(ackEvents.length, 1);

      const event = JSON.parse(ackEvents[0]);
      assert.equal(event.taskId, claim.taskId);
      assert.equal(event.attemptId, claim.attemptId);
      // Must not contain plaintext lease token
      assert.ok(!event.leaseToken);

      await cleanup(runDir);
    });
  });

  describe('reportDispatchFailure()', () => {
    it('consumes an attempt and retries (re-queues the task)', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      const [claim] = await orchestrator.claim(1);
      const result = await orchestrator.reportDispatchFailure(claim.taskId, claim.attemptId);

      // Task should be back to queued with attemptsUsed=1
      const tasksDir = join(runDir, 'tasks');
      const taskContent = await readFile(join(tasksDir, `${claim.taskId}.json`), 'utf8');
      const task = JSON.parse(taskContent) as TaskRecord;
      assert.equal(task.state, 'queued');
      assert.equal(task.attemptsUsed, 1);
      assert.equal(task.failureReason, 'dispatch_failure');

      // ReconcileResult should indicate run is still active
      assert.equal(result.state, 'active');
      assert.ok(result.canClaim);

      await cleanup(runDir);
    });

    it('exhausts attempts after second dispatch failure', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      // First claim and fail
      const [claim1] = await orchestrator.claim(1);
      await orchestrator.reportDispatchFailure(claim1.taskId, claim1.attemptId);

      // Second claim and fail
      const [claim2] = await orchestrator.claim(1);
      const result = await orchestrator.reportDispatchFailure(claim2.taskId, claim2.attemptId);

      // Task should be failed
      const tasksDir = join(runDir, 'tasks');
      const taskContent = await readFile(join(tasksDir, `${claim2.taskId}.json`), 'utf8');
      const task = JSON.parse(taskContent) as TaskRecord;
      assert.equal(task.state, 'failed');
      assert.equal(task.attemptsUsed, 2);
      assert.equal(task.failureReason, 'retry_exhausted');

      // Run should be failed since the only task has exhausted its attempts
      assert.equal(result.state, 'failed');

      await cleanup(runDir);
    });

    it('rejects failure report for non-existent task', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      await assert.rejects(
        () => orchestrator.reportDispatchFailure('task-999', 'attempt-xxx'),
        { message: /task.*not found/i },
      );

      await cleanup(runDir);
    });

    it('rejects failure report with wrong attempt ID', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      const [claim] = await orchestrator.claim(1);

      await assert.rejects(
        () => orchestrator.reportDispatchFailure(claim.taskId, 'wrong-attempt'),
        { message: /attempt.*mismatch/i },
      );

      await cleanup(runDir);
    });

    it('rejects failure report for running (already acknowledged) task', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      const [claim] = await orchestrator.claim(1);
      await orchestrator.acknowledgeDispatch(claim.taskId, claim.attemptId);

      // Read task and attempt bytes before the rejected call
      const tasksDir = join(runDir, 'tasks');
      const taskBefore = await readFile(join(tasksDir, `${claim.taskId}.json`), 'utf8');
      let attemptBefore = '';
      try {
        attemptBefore = await readFile(join(tasksDir, `${claim.taskId}.${claim.attemptId}.json`), 'utf8');
      } catch { /* attempt file may not exist in this test */ }

      await assert.rejects(
        () => orchestrator.reportDispatchFailure(claim.taskId, claim.attemptId),
        { message: /not.*leased/i },
      );

      // Task bytes must be unchanged
      const taskAfter = await readFile(join(tasksDir, `${claim.taskId}.json`), 'utf8');
      assert.equal(taskBefore, taskAfter);

      // Attempt bytes must be unchanged
      if (attemptBefore) {
        const attemptAfter = await readFile(join(tasksDir, `${claim.taskId}.${claim.attemptId}.json`), 'utf8');
        assert.equal(attemptBefore, attemptAfter);
      }

      await cleanup(runDir);
    });

    it('emits audit events for dispatch failure and retry', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      const [claim] = await orchestrator.claim(1);
      await orchestrator.reportDispatchFailure(claim.taskId, claim.attemptId);

      const auditFile = join(runDir, 'audit.jsonl');
      const content = await readFile(auditFile, 'utf8');
      const lines = content.trim().split('\n');

      const failureEvents = lines.filter((l) => JSON.parse(l).type === 'dispatch.failed');
      assert.equal(failureEvents.length, 1);

      const retryEvents = lines.filter((l) => JSON.parse(l).type === 'task.retry');
      assert.equal(retryEvents.length, 1);

      await cleanup(runDir);
    });

    it('emits audit event for terminal task failure', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      const [claim1] = await orchestrator.claim(1);
      await orchestrator.reportDispatchFailure(claim1.taskId, claim1.attemptId);

      const [claim2] = await orchestrator.claim(1);
      await orchestrator.reportDispatchFailure(claim2.taskId, claim2.attemptId);

      const auditFile = join(runDir, 'audit.jsonl');
      const content = await readFile(auditFile, 'utf8');
      const lines = content.trim().split('\n');

      const taskFailedEvents = lines.filter((l) => JSON.parse(l).type === 'task.failed');
      assert.equal(taskFailedEvents.length, 1);

      await cleanup(runDir);
    });
  });

  describe('run state derivation from tasks', () => {
    it('run is active when some tasks remain queued', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 3);
      const orchestrator = new Orchestrator(runDir);

      // Claim and succeed one task
      const [claim] = await orchestrator.claim(1);
      await orchestrator.acknowledgeDispatch(claim.taskId, claim.attemptId);

      // Run should still be active
      const runRecord = JSON.parse(
        await readFile(join(runDir, 'run.json'), 'utf8'),
      );
      assert.equal(runRecord.state, 'active');

      await cleanup(runDir);
    });
  });

  describe('rejected transitions do not mutate state', () => {
    it('invalid acknowledgeDispatch does not change task state', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      // Read initial task state
      const tasksDir = join(runDir, 'tasks');
      const initialContent = await readFile(join(tasksDir, 'task-0.json'), 'utf8');

      // Attempt invalid acknowledgement
      await assert.rejects(
        () => orchestrator.acknowledgeDispatch('task-0', 'nonexistent'),
      );

      // Task state should be unchanged
      const afterContent = await readFile(join(tasksDir, 'task-0.json'), 'utf8');
      assert.equal(initialContent, afterContent);

      await cleanup(runDir);
    });

    it('invalid reportDispatchFailure does not change task state', async () => {
      const runDir = await tmpDir();
      await createRunDir(runDir, 1);
      const orchestrator = new Orchestrator(runDir);

      // Read initial task state
      const tasksDir = join(runDir, 'tasks');
      const initialContent = await readFile(join(tasksDir, 'task-0.json'), 'utf8');

      // Attempt invalid failure report
      await assert.rejects(
        () => orchestrator.reportDispatchFailure('task-0', 'nonexistent'),
      );

      // Task state should be unchanged
      const afterContent = await readFile(join(tasksDir, 'task-0.json'), 'utf8');
      assert.equal(initialContent, afterContent);

      await cleanup(runDir);
    });
  });
});
