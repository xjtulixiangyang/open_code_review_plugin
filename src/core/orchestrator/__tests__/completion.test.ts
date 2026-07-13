import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { Orchestrator } from '../orchestrator.js';
import type { RunRecord, TaskRecord, AttemptRecord, CompletionSubmission } from '../types.js';
import { sha256 } from '../fingerprint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'completion-test-'));
  return dir;
}

function cleanupRunDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

async function writeRunRecord(runDir: string, overrides?: Partial<RunRecord>): Promise<RunRecord> {
  const record: RunRecord = {
    schemaVersion: 1,
    runId: overrides?.runId ?? 'test-run',
    state: overrides?.state ?? 'active',
    manifestDigest: 'abc',
    repoIdentity: 'repo',
    argsFingerprint: 'args',
    diffFingerprint: 'diff',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  await writeFile(join(runDir, 'run.json'), JSON.stringify(record, null, 2));
  return record;
}

async function writeTaskRecord(
  runDir: string,
  overrides?: Partial<TaskRecord>,
): Promise<TaskRecord> {
  const taskId = overrides?.taskId ?? 'task-0';
  const record: TaskRecord = {
    runId: 'test-run',
    taskId,
    manifestIndex: 0,
    filePath: 'src/foo.ts',
    diffFingerprint: 'fp1',
    state: 'running',
    currentAttemptId: overrides?.currentAttemptId ?? 'attempt-1',
    attemptsUsed: 0,
    maxAttempts: 2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  await mkdir(join(runDir, 'tasks'), { recursive: true });
  await writeFile(join(runDir, 'tasks', `${taskId}.json`), JSON.stringify(record, null, 2));
  return record;
}

async function writeAttemptRecord(
  runDir: string,
  overrides?: Partial<AttemptRecord>,
): Promise<AttemptRecord> {
  const taskId = overrides?.taskId ?? 'task-0';
  const attemptId = overrides?.attemptId ?? 'attempt-1';
  const record: AttemptRecord = {
    runId: 'test-run',
    taskId,
    attemptId,
    state: 'running',
    leaseTokenDigest: overrides?.leaseTokenDigest ?? sha256('test-token'),
    leaseDeadline: overrides?.leaseDeadline ?? new Date(Date.now() + 900_000).toISOString(),
    stagedCommentCount: overrides?.stagedCommentCount ?? 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
  await mkdir(join(runDir, 'tasks'), { recursive: true });
  await writeFile(
    join(runDir, 'tasks', `${taskId}.${attemptId}.json`),
    JSON.stringify(record, null, 2),
  );
  return record;
}

function makeSubmission(overrides?: Partial<CompletionSubmission>): CompletionSubmission {
  return {
    runId: 'test-run',
    taskId: 'task-0',
    attemptId: 'attempt-1',
    leaseToken: 'test-token',
    filePath: 'src/foo.ts',
    diffFingerprint: 'fp1',
    outcome: 'findings',
    summary: 'Found 3 issues',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('acceptCompletion', () => {
  let runDir: string;
  let orchestrator: Orchestrator;
  let frozenNow: Date;

  before(() => {
    frozenNow = new Date('2026-07-13T12:00:00Z');
  });

  after(() => {
    if (runDir) cleanupRunDir(runDir);
  });

  async function setup(
    taskOverrides?: Partial<TaskRecord>,
    attemptOverrides?: Partial<AttemptRecord>,
    runOverrides?: Partial<RunRecord>,
  ): Promise<void> {
    runDir = makeRunDir();
    orchestrator = new Orchestrator(runDir, { now: () => frozenNow });
    await writeRunRecord(runDir, runOverrides);
    await writeTaskRecord(runDir, taskOverrides);
    await writeAttemptRecord(runDir, attemptOverrides);
  }

  // -----------------------------------------------------------------------
  // Basic success
  // -----------------------------------------------------------------------

  it('accepts a valid findings submission', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString() },
    );
    // Stage a comment so findings outcome is valid
    const commentsDir = join(runDir, 'attempt-comments');
    await mkdir(commentsDir, { recursive: true });
    await writeFile(join(commentsDir, 'attempt-1.jsonl'), JSON.stringify({ comment_id: 'c1' }) + '\n');

    const result = await orchestrator.acceptCompletion(makeSubmission());
    assert.deepEqual(result, { accepted: true, idempotent: false });
  });

  it('accepts a valid no_findings submission without comments', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString(), stagedCommentCount: 0 },
    );

    const result = await orchestrator.acceptCompletion(makeSubmission({ outcome: 'no_findings', summary: 'No issues found' }));
    assert.deepEqual(result, { accepted: true, idempotent: false });
  });

  // -----------------------------------------------------------------------
  // Idempotency
  // -----------------------------------------------------------------------

  it('identical completion is idempotent and conflicting completion is rejected', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString() },
    );
    const commentsDir = join(runDir, 'attempt-comments');
    await mkdir(commentsDir, { recursive: true });
    await writeFile(join(commentsDir, 'attempt-1.jsonl'), JSON.stringify({ comment_id: 'c1' }) + '\n');

    const cleanSubmission = makeSubmission();
    assert.deepEqual(await orchestrator.acceptCompletion(cleanSubmission), {
      accepted: true,
      idempotent: false,
    });
    assert.deepEqual(await orchestrator.acceptCompletion(cleanSubmission), {
      accepted: true,
      idempotent: true,
    });
    await assert.rejects(
      () => orchestrator.acceptCompletion({ ...cleanSubmission, summary: 'different' }),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  // -----------------------------------------------------------------------
  // Validation errors
  // -----------------------------------------------------------------------

  it('rejects findings outcome when no comments are staged', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString(), stagedCommentCount: 0 },
    );

    await assert.rejects(
      () => orchestrator.acceptCompletion(makeSubmission({ outcome: 'findings' })),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects no_findings outcome when comments are staged', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString(), stagedCommentCount: 1 },
    );
    // Create the JSONL file so countStagedCommentsLocked finds comments
    const commentsDir = join(runDir, 'attempt-comments');
    await mkdir(commentsDir, { recursive: true });
    await writeFile(join(commentsDir, 'attempt-1.jsonl'), JSON.stringify({ comment_id: 'c1' }) + '\n');

    await assert.rejects(
      () => orchestrator.acceptCompletion(makeSubmission({ outcome: 'no_findings' })),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects invalid outcome enum', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString() },
    );

    await assert.rejects(
      () => orchestrator.acceptCompletion(makeSubmission({ outcome: 'invalid' as any })),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects empty summary', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString() },
    );

    await assert.rejects(
      () => orchestrator.acceptCompletion(makeSubmission({ outcome: 'no_findings', summary: '' })),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects summary exceeding 500 Unicode code points', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString() },
    );

    const longSummary = 'x'.repeat(501);
    await assert.rejects(
      () => orchestrator.acceptCompletion(makeSubmission({ outcome: 'no_findings', summary: longSummary })),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  // -----------------------------------------------------------------------
  // Credential validation
  // -----------------------------------------------------------------------

  it('rejects submission when run is not active', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString() },
      { state: 'completed' },
    );

    await assert.rejects(
      () => orchestrator.acceptCompletion(makeSubmission()),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects submission when task is not running', async () => {
    await setup(
      { state: 'queued', currentAttemptId: undefined },
      { state: 'leased', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString() },
    );

    await assert.rejects(
      () => orchestrator.acceptCompletion(makeSubmission()),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects submission with wrong attempt ID', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString() },
    );

    await assert.rejects(
      () => orchestrator.acceptCompletion(makeSubmission({ attemptId: 'wrong-attempt' })),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects submission with wrong file path', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString() },
    );

    await assert.rejects(
      () => orchestrator.acceptCompletion(makeSubmission({ filePath: 'wrong/path.ts' })),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects submission with wrong diff fingerprint', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString() },
    );

    await assert.rejects(
      () => orchestrator.acceptCompletion(makeSubmission({ diffFingerprint: 'wrong-fp' })),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects submission with wrong lease token', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString() },
    );

    await assert.rejects(
      () => orchestrator.acceptCompletion(makeSubmission({ leaseToken: 'wrong-token' })),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects submission with expired lease', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() - 1).toISOString() },
    );

    await assert.rejects(
      () => orchestrator.acceptCompletion(makeSubmission()),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  // -----------------------------------------------------------------------
  // Late completion after retry
  // -----------------------------------------------------------------------

  it('rejects completion when task has been retried (currentAttemptId changed)', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-2' }, // current is now attempt-2
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString() },
    );

    // Submission references attempt-1 which is no longer current
    await assert.rejects(
      () => orchestrator.acceptCompletion(makeSubmission({ attemptId: 'attempt-1' })),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  // -----------------------------------------------------------------------
  // Exactly one accepted attempt per task
  // -----------------------------------------------------------------------

  it('rejects completion when task already has an acceptedAttemptId (different attempt)', async () => {
    await setup(
      { state: 'succeeded', currentAttemptId: undefined, acceptedAttemptId: 'attempt-1' },
      { state: 'succeeded', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString(), completionDigest: sha256('something') },
    );

    // Different attempt trying to complete
    await assert.rejects(
      () => orchestrator.acceptCompletion(makeSubmission({ attemptId: 'attempt-2' })),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  // -----------------------------------------------------------------------
  // Run state derivation after completion
  // -----------------------------------------------------------------------

  it('derives run state as completed when all tasks succeed', async () => {
    await setup(
      { state: 'running', currentAttemptId: 'attempt-1' },
      { state: 'running', leaseTokenDigest: sha256('test-token'), leaseDeadline: new Date(frozenNow.getTime() + 900_000).toISOString() },
    );
    const commentsDir = join(runDir, 'attempt-comments');
    await mkdir(commentsDir, { recursive: true });
    await writeFile(join(commentsDir, 'attempt-1.jsonl'), JSON.stringify({ comment_id: 'c1' }) + '\n');

    await orchestrator.acceptCompletion(makeSubmission());

    const status = await orchestrator.status();
    assert.equal(status.state, 'completed');
    assert.equal(status.taskCounts.succeeded, 1);
    assert.equal(status.taskCounts.queued, 0);
    assert.equal(status.taskCounts.leased, 0);
    assert.equal(status.taskCounts.running, 0);
    assert.equal(status.taskCounts.failed, 0);
  });
});
