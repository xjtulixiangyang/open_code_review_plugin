import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Orchestrator } from '../orchestrator.js';
import type { RunRecord, TaskRecord, AttemptRecord, ReviewManifest, ManifestFile } from '../types.js';
import { ORCHESTRATOR_SCHEMA_VERSION } from '../types.js';
import { sha256, manifestDigest } from '../fingerprint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = '/tmp/orchestrator-code-comment-test';

function sha256hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

async function tmpDir(): Promise<string> {
  const dir = join(TMP_ROOT, `run-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

interface RunDirResult {
  runId: string;
  taskId: string;
  attemptId: string;
  leaseToken: string;
  filePath: string;
  diffFingerprint: string;
}

/**
 * Create a run directory with one claimed (leased) task, ready for
 * acknowledgeDispatch and then code_comment.
 */
async function createRunDirWithClaimedTask(
  runDir: string,
  schemaVersion?: number,
): Promise<RunDirResult> {
  const runId = `test-run-${randomUUID().slice(0, 8)}`;
  const taskId = `task-0`;
  const createdAt = new Date().toISOString();
  const filePath = 'src/foo.ts';
  const diffFp = sha256('test-diff');

  const files: ManifestFile[] = [{
    manifestIndex: 0,
    path: filePath,
    diffFingerprint: diffFp,
    changedLines: 5,
    status: 'modified',
  }];

  const manifest: ReviewManifest = {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    runId,
    repoIdentity: 'test-repo',
    argsFingerprint: sha256('test-args'),
    diffFingerprint: diffFp,
    files,
    excludedFiles: [],
    createdAt,
  };

  const runRecord: RunRecord = {
    schemaVersion: schemaVersion ?? ORCHESTRATOR_SCHEMA_VERSION,
    runId,
    state: 'active',
    manifestDigest: manifestDigest(manifest),
    repoIdentity: 'test-repo',
    argsFingerprint: sha256('test-args'),
    diffFingerprint: diffFp,
    createdAt,
    updatedAt: createdAt,
  };

  // Write manifest
  await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // Write run record
  await writeFile(join(runDir, 'run.json'), JSON.stringify(runRecord, null, 2) + '\n');

  // Write task
  const tasksDir = join(runDir, 'tasks');
  await mkdir(tasksDir, { recursive: true });

  const task: TaskRecord = {
    runId,
    taskId,
    manifestIndex: 0,
    filePath,
    diffFingerprint: diffFp,
    state: 'queued',
    attemptsUsed: 0,
    maxAttempts: 2,
    createdAt,
    updatedAt: createdAt,
  };
  await writeFile(join(tasksDir, `${taskId}.json`), JSON.stringify(task, null, 2) + '\n');

  // Claim the task to get a lease
  const orchestrator = new Orchestrator(runDir);
  const claimResults = await orchestrator.claim(1);
  const claim = claimResults[0];

  // Acknowledge dispatch to move to running state
  await orchestrator.acknowledgeDispatch(claim.taskId, claim.attemptId);

  return {
    runId,
    taskId: claim.taskId,
    attemptId: claim.attemptId,
    leaseToken: claim.leaseToken,
    filePath: claim.filePath,
    diffFingerprint: claim.diffFingerprint,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Orchestrator codeComment', () => {
  describe('validation', () => {
    it('rejects when run is not active', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      // Manually set run state to completed
      const runPath = join(runDir, 'run.json');
      const runData = JSON.parse(await readFile(runPath, 'utf-8'));
      runData.state = 'completed';
      await writeFile(runPath, JSON.stringify(runData, null, 2) + '\n');

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.codeComment({
          taskId,
          attemptId,
          leaseToken,
          filePath,
          diffFingerprint,
          comment: 'test',
        }),
        { message: /run.*not active/i },
      );

      await cleanup(runDir);
    });

    it('rejects when task is not running', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      // Manually set task state back to queued
      const tasksDir = join(runDir, 'tasks');
      const taskPath = join(tasksDir, `${taskId}.json`);
      const taskData = JSON.parse(await readFile(taskPath, 'utf-8'));
      taskData.state = 'queued';
      await writeFile(taskPath, JSON.stringify(taskData, null, 2) + '\n');

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.codeComment({
          taskId,
          attemptId,
          leaseToken,
          filePath,
          diffFingerprint,
          comment: 'test',
        }),
        { message: /task.*not running/i },
      );

      await cleanup(runDir);
    });

    it('rejects when attempt ID does not match current attempt', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.codeComment({
          taskId,
          attemptId: 'wrong-attempt',
          leaseToken,
          filePath,
          diffFingerprint,
          comment: 'test',
        }),
        { message: /attempt.*mismatch/i },
      );

      await cleanup(runDir);
    });

    it('rejects when file path does not match', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.codeComment({
          taskId,
          attemptId,
          leaseToken,
          filePath: 'wrong/path.ts',
          diffFingerprint,
          comment: 'test',
        }),
        { message: /file path.*mismatch/i },
      );

      await cleanup(runDir);
    });

    it('rejects when diff fingerprint does not match', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath } =
        await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.codeComment({
          taskId,
          attemptId,
          leaseToken,
          filePath,
          diffFingerprint: 'wrong-fingerprint',
          comment: 'test',
        }),
        { message: /diff.*mismatch/i },
      );

      await cleanup(runDir);
    });

    it('rejects invalid lease token (wrong SHA-256)', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.codeComment({
          taskId,
          attemptId,
          leaseToken: 'invalid-token',
          filePath,
          diffFingerprint,
          comment: 'test',
        }),
        { message: /invalid.*lease.*token/i },
      );

      await cleanup(runDir);
    });

    it('rejects expired lease', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      // Advance clock past lease deadline
      const clock = new FakeClock(Date.now() + 1_800_000); // 30 min later
      const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });

      await assert.rejects(
        () => orchestrator.codeComment({
          taskId,
          attemptId,
          leaseToken,
          filePath,
          diffFingerprint,
          comment: 'test',
        }),
        { message: /lease.*expired/i },
      );

      await cleanup(runDir);
    });
  });

  describe('successful comment staging', () => {
    it('appends a comment and updates stagedCommentCount', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      const result = await orchestrator.codeComment({
        taskId,
        attemptId,
        leaseToken,
        filePath,
        diffFingerprint,
        comment: 'first comment',
      });

      assert.ok(result.commentId);
      assert.equal(result.stagedCommentCount, 1);

      // Verify attempt record has updated count
      const tasksDir = join(runDir, 'tasks');
      const attemptPath = join(tasksDir, `${taskId}.${attemptId}.json`);
      const attemptData = JSON.parse(await readFile(attemptPath, 'utf-8')) as AttemptRecord;
      assert.equal(attemptData.stagedCommentCount, 1);

      await cleanup(runDir);
    });

    it('appends multiple comments and increments count', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);

      const r1 = await orchestrator.codeComment({
        taskId, attemptId, leaseToken, filePath, diffFingerprint,
        comment: 'first',
      });
      assert.equal(r1.stagedCommentCount, 1);

      const r2 = await orchestrator.codeComment({
        taskId, attemptId, leaseToken, filePath, diffFingerprint,
        comment: 'second',
      });
      assert.equal(r2.stagedCommentCount, 2);

      const r3 = await orchestrator.codeComment({
        taskId, attemptId, leaseToken, filePath, diffFingerprint,
        comment: 'third',
      });
      assert.equal(r3.stagedCommentCount, 3);

      // Verify JSONL file has 3 entries
      const commentsPath = join(runDir, 'tasks', `${taskId}.${attemptId}.comments.jsonl`);
      const content = await readFile(commentsPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      assert.equal(lines.length, 3);

      // Verify attempt record
      const attemptPath = join(runDir, 'tasks', `${taskId}.${attemptId}.json`);
      const attemptData = JSON.parse(await readFile(attemptPath, 'utf-8')) as AttemptRecord;
      assert.equal(attemptData.stagedCommentCount, 3);

      await cleanup(runDir);
    });

    it('returns unique comment IDs for each call', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);

      const r1 = await orchestrator.codeComment({
        taskId, attemptId, leaseToken, filePath, diffFingerprint,
        comment: 'first',
      });
      const r2 = await orchestrator.codeComment({
        taskId, attemptId, leaseToken, filePath, diffFingerprint,
        comment: 'second',
      });

      assert.notEqual(r1.commentId, r2.commentId);

      await cleanup(runDir);
    });
  });

  describe('JSONL recovery', () => {
    it('recovers stagedCommentCount from existing valid JSONL', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      // Pre-populate JSONL with 2 entries
      const tasksDir = join(runDir, 'tasks');
      const commentsPath = join(tasksDir, `${taskId}.${attemptId}.comments.jsonl`);
      const existingEntry = JSON.stringify({ commentId: 'existing-1', text: 'existing' });
      await writeFile(commentsPath, existingEntry + '\n');

      const orchestrator = new Orchestrator(runDir);
      const result = await orchestrator.codeComment({
        taskId, attemptId, leaseToken, filePath, diffFingerprint,
        comment: 'new',
      });

      // 1 existing + 1 new = 2
      assert.equal(result.stagedCommentCount, 2);

      await cleanup(runDir);
    });

    it('recovers count from multiple existing JSONL lines', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      // Pre-populate JSONL with 3 entries
      const tasksDir = join(runDir, 'tasks');
      const commentsPath = join(tasksDir, `${taskId}.${attemptId}.comments.jsonl`);
      const lines = [
        JSON.stringify({ commentId: 'c1' }),
        JSON.stringify({ commentId: 'c2' }),
        JSON.stringify({ commentId: 'c3' }),
      ].join('\n');
      await writeFile(commentsPath, lines + '\n');

      const orchestrator = new Orchestrator(runDir);
      const result = await orchestrator.codeComment({
        taskId, attemptId, leaseToken, filePath, diffFingerprint,
        comment: 'new',
      });

      assert.equal(result.stagedCommentCount, 4); // 3 + 1

      await cleanup(runDir);
    });

    it('fails closed on malformed JSONL', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      // Write malformed JSONL
      const tasksDir = join(runDir, 'tasks');
      const commentsPath = join(tasksDir, `${taskId}.${attemptId}.comments.jsonl`);
      await writeFile(commentsPath, 'not-json\n');

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.codeComment({
          taskId, attemptId, leaseToken, filePath, diffFingerprint,
          comment: 'test',
        }),
        { message: /malformed/i },
      );

      await cleanup(runDir);
    });

    it('fails closed when any line in JSONL is malformed', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      const tasksDir = join(runDir, 'tasks');
      const commentsPath = join(tasksDir, `${taskId}.${attemptId}.comments.jsonl`);
      const lines = [
        JSON.stringify({ commentId: 'c1' }),
        'bad-json-line',
        JSON.stringify({ commentId: 'c3' }),
      ].join('\n');
      await writeFile(commentsPath, lines + '\n');

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.codeComment({
          taskId, attemptId, leaseToken, filePath, diffFingerprint,
          comment: 'test',
        }),
        { message: /malformed/i },
      );

      await cleanup(runDir);
    });
  });

  describe('token and event non-leakage', () => {
    it('does not leak plaintext lease token in stored JSONL', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      await orchestrator.codeComment({
        taskId, attemptId, leaseToken, filePath, diffFingerprint,
        comment: 'test',
      });

      // Read the JSONL file - should not contain the lease token
      const tasksDir = join(runDir, 'tasks');
      const commentsPath = join(tasksDir, `${taskId}.${attemptId}.comments.jsonl`);
      const content = await readFile(commentsPath, 'utf-8');
      const parsed = JSON.parse(content.trim().split('\n')[0]);

      assert.equal(parsed.leaseToken, undefined);
      assert.equal(parsed.leaseTokenDigest, undefined);

      await cleanup(runDir);
    });

    it('does not leak plaintext lease token in result', async () => {
      const runDir = await tmpDir();
      const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint } =
        await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      const result = await orchestrator.codeComment({
        taskId, attemptId, leaseToken, filePath, diffFingerprint,
        comment: 'test',
      });

      // Result should only contain commentId and stagedCommentCount
      assert.ok(result.commentId);
      assert.equal(typeof result.stagedCommentCount, 'number');
      assert.equal(Object.keys(result).length, 2);

      await cleanup(runDir);
    });
  });

  describe('legacy compatibility', () => {
    // Legacy mode applies only to old-schema runs (schemaVersion undefined/0)
    // without a taskId. Since this orchestrator always creates schemaVersion: 1
    // runs, legacy mode is not exercised here. The credential validation is
    // always enforced.
  });
});

// ---------------------------------------------------------------------------
// FakeClock
// ---------------------------------------------------------------------------

class FakeClock {
  private _now: number;

  constructor(isoOrMs: number | string) {
    this._now = typeof isoOrMs === 'string' ? Date.parse(isoOrMs) : isoOrMs;
  }

  now(): Date {
    return new Date(this._now);
  }

  advance(ms: number): void {
    this._now += ms;
  }
}
