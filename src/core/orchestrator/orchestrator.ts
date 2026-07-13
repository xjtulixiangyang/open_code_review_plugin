import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readdir, readFile, appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { withRunLock } from './lock.js';
import { atomicWriteJson, appendAuditEvent, readJson } from './storage.js';
import { sha256 } from './fingerprint.js';
import type {
  RunRecord,
  TaskRecord,
  AttemptRecord,
  ClaimResult,
  ReconcileResult,
  TaskCounts,
  RunState,
  AuditEvent,
  CompletionSubmission,
  CompletionOutcome,
} from './types.js';
import type { CommentRecord } from '../model/comment.js';
import type { AttemptCredentials } from './types.js';
import { ORCHESTRATOR_SCHEMA_VERSION, DEFAULT_MAX_ATTEMPTS, isTaskFilename } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RUN_RECORD_FILE = 'run.json';
const TASKS_DIR = 'tasks';
const AUDIT_FILE = 'audit.jsonl';

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Core orchestrator for claiming, dispatching, and tracking review tasks.
 *
 * All public methods acquire the run lock to ensure mutual exclusion.
 * Internal `*Locked` methods operate under the assumption the lock is held.
 */
export interface OrchestratorOptions {
  now?: () => Date;
}

export class Orchestrator {
  private readonly _now: () => Date;

  constructor(readonly runDir: string, options?: OrchestratorOptions) {
    this._now = options?.now ?? (() => new Date());
  }

  private now(): Date {
    return this._now();
  }

  // -----------------------------------------------------------------------
  // Public API (locked)
  // -----------------------------------------------------------------------

  /**
   * Claim up to `capacity` queued tasks, leasing them atomically.
   *
   * Returns claimed tasks in manifest order. Each claim includes a unique
   * high-entropy lease token whose SHA-256 digest is persisted; the plaintext
   * token is returned only in the ClaimResult.
   *
   * Capacity must be between 1 and 8 inclusive.
   */
  claim(capacity: number): Promise<ClaimResult[]> {
    return withRunLock(this.runDir, () => this.claimLocked(capacity));
  }

  /**
   * Acknowledge that a leased task has been dispatched to a reviewer.
   *
   * Transitions the task from `leased` to `running` and records the accepted
   * attempt ID. Rejects if the task does not exist, is not in `leased` state,
   * or the attempt ID does not match.
   */
  acknowledgeDispatch(taskId: string, attemptId: string): Promise<void> {
    return withRunLock(this.runDir, () =>
      this.acknowledgeDispatchLocked(taskId, attemptId),
    );
  }

  /**
   * Report that a dispatch attempt failed.
   *
   * Consumes one attempt. If attempts remain, the task is re-queued for retry.
   * If all attempts are exhausted, the task transitions to `failed`.
   * Returns the reconciled run state.
   */
  reportDispatchFailure(
    taskId: string,
    attemptId: string,
  ): Promise<ReconcileResult> {
    return withRunLock(this.runDir, async () => {
      await this.failAttemptLocked(taskId, attemptId, 'dispatch_failure');
      return this.recomputeRunLocked();
    });
  }

  /**
   * Reconcile lease deadlines — expire any leased or running tasks whose
   * lease deadline has passed, then recompute run state.
   *
   * Idempotent: calling multiple times with no clock change produces the
   * same result.
   */
  reconcile(): Promise<ReconcileResult> {
    return withRunLock(this.runDir, async () => {
      for (const task of await this.listTasksLocked()) {
        if (
          (task.state === 'leased' || task.state === 'running') &&
          task.currentAttemptId
        ) {
          const attempt = await this.readAttemptLocked(
            task.taskId,
            task.currentAttemptId,
          );
          if (
            attempt &&
            Date.parse(attempt.leaseDeadline) <= this.now().getTime()
          ) {
            await this.failAttemptLocked(
              task.taskId,
              task.currentAttemptId,
              'lease_expired',
            );
          }
        }
      }
      return this.recomputeRunLocked();
    });
  }

  /**
   * Return the current run state without expiring any leases.
   *
   * Acquires the lock to ensure a consistent read, then recomputes run
   * state from task records. Does NOT mutate any task or attempt records.
   */
  status(): Promise<ReconcileResult> {
    return withRunLock(this.runDir, async () => {
      return this.recomputeRunLocked();
    });
  }

  /**
   * Stage code comments under a valid lease.
   *
   * Validates once under one withRunLock: run active, task running,
   * attempt match, file path match, diff fingerprint match,
   * SHA-256 lease token digest, unexpired lease deadline.
   * Then appends all CommentRecords to attempt-comments/<attemptId>.jsonl,
   * preserving their existing comment_id values.
   * Returns the comment_ids of all staged records.
   */
  stageComments(credentials: AttemptCredentials, records: CommentRecord[]): Promise<string[]> {
    return withRunLock(this.runDir, () =>
      this.stageCommentsLocked(credentials, records),
    );
  }

  /**
   * Accept a structured, idempotent completion submission.
   *
   * Under the run lock, first reads the task and accepted attempt. If the
   * task already succeeded and the accepted attempt has the same completion
   * digest, returns idempotent success even though the run may now be
   * completed. If a completion digest exists but differs, rejects.
   *
   * Otherwise validates active/current/running credentials and
   * outcome/comment-count consistency, writes attempt success, then task
   * success, and derives run terminal state from all tasks.
   */
  acceptCompletion(submission: CompletionSubmission): Promise<{ accepted: true; idempotent: boolean }> {
    return withRunLock(this.runDir, () =>
      this.acceptCompletionLocked(submission),
    );
  }

  // -----------------------------------------------------------------------
  // Locked internals
  // -----------------------------------------------------------------------

  private async claimLocked(capacity: number): Promise<ClaimResult[]> {
    // Validate capacity
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8) {
      throw new Error(
        `capacity must be an integer between 1 and 8, got ${capacity}`,
      );
    }

    const tasks = await this.listTasksLocked();
    const queued = tasks
      .filter((t) => t.state === 'queued')
      .sort((a, b) => a.manifestIndex - b.manifestIndex);

    const toClaim = queued.slice(0, capacity);
    if (toClaim.length === 0) {
      // Emit rejection event
      await this.emitAuditEventLocked({
        type: 'claim.rejected',
        runId: await this.getRunIdLocked(),
        reason: 'no_queued_tasks',
      });
      return [];
    }

    const results: ClaimResult[] = [];
    const now = this.now().toISOString();

    for (const task of toClaim) {
      const attemptId = `attempt-${randomUUID()}`;
      const leaseToken = randomBytes(32).toString('base64url');
      const leaseTokenDigest = sha256(leaseToken);
      const leaseDeadline = new Date(
        this.now().getTime() + 900_000,
      ).toISOString(); // 15 min default

      // Update task record
      task.state = 'leased';
      task.currentAttemptId = attemptId;
      task.updatedAt = now;
      await this.writeTaskLocked(task);

      // Create attempt record
      const attempt: AttemptRecord = {
        runId: task.runId,
        taskId: task.taskId,
        attemptId,
        state: 'leased',
        leaseTokenDigest,
        leaseDeadline,
        stagedCommentCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      await this.writeAttemptLocked(attempt);

      results.push({
        runId: task.runId,
        taskId: task.taskId,
        attemptId,
        leaseToken,
        leaseDeadline,
        filePath: task.filePath,
        diffFingerprint: task.diffFingerprint,
      });

      // Emit audit event (no plaintext lease token)
      await this.emitAuditEventLocked({
        type: 'claim.accepted',
        runId: task.runId,
        taskId: task.taskId,
        attemptId,
        data: { leaseDeadline },
      });
    }

    return results;
  }

  private async acknowledgeDispatchLocked(
    taskId: string,
    attemptId: string,
  ): Promise<void> {
    const task = await this.readTaskLocked(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (task.state !== 'leased') {
      throw new Error(
        `Task ${taskId} is not in leased state (state=${task.state})`,
      );
    }
    if (task.currentAttemptId !== attemptId) {
      throw new Error(
        `Attempt ID mismatch for task ${taskId}: expected ${task.currentAttemptId}, got ${attemptId}`,
      );
    }

    const now = this.now().toISOString();
    task.state = 'running';
    // currentAttemptId is preserved (still points to the accepted attempt)
    // acceptedAttemptId is NOT set here — that field is for successful completion (Task 7)
    task.updatedAt = now;
    await this.writeTaskLocked(task);

    // Update attempt record
    const attempt = await this.readAttemptLocked(taskId, attemptId);
    if (attempt) {
      attempt.state = 'running';
      attempt.updatedAt = now;
      await this.writeAttemptLocked(attempt);
    }

    await this.emitAuditEventLocked({
      type: 'dispatch.acknowledged',
      runId: task.runId,
      taskId: task.taskId,
      attemptId,
    });
  }

  private async failAttemptLocked(
    taskId: string,
    attemptId: string,
    reason: 'dispatch_failure' | 'lease_expired',
  ): Promise<void> {
    const task = await this.readTaskLocked(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    if (reason === 'dispatch_failure' && task.state !== 'leased') {
      throw new Error(
        `Task ${taskId} is not in leased state (state=${task.state})`,
      );
    }
    if (
      reason === 'lease_expired' &&
      task.state !== 'leased' &&
      task.state !== 'running'
    ) {
      throw new Error(
        `Task ${taskId} is not in leased or running state (state=${task.state})`,
      );
    }
    if (task.currentAttemptId !== attemptId) {
      throw new Error(
        `Attempt ID mismatch for task ${taskId}: expected ${task.currentAttemptId}, got ${attemptId}`,
      );
    }

    const now = this.now().toISOString();

    // Update attempt record
    const attempt = await this.readAttemptLocked(taskId, attemptId);
    if (attempt) {
      attempt.state = reason === 'lease_expired' ? 'expired' : 'failed';
      attempt.failureReason = reason;
      attempt.updatedAt = now;
      await this.writeAttemptLocked(attempt);
    }

    // Consume one attempt
    task.attemptsUsed += 1;
    task.currentAttemptId = undefined;
    task.failureReason = reason;
    task.updatedAt = now;

    if (task.attemptsUsed >= (task.maxAttempts || DEFAULT_MAX_ATTEMPTS)) {
      // Exhausted — terminal failure
      task.state = 'failed';
      task.failureReason = 'retry_exhausted';
      await this.writeTaskLocked(task);

      await this.emitAuditEventLocked({
        type: 'task.failed',
        runId: task.runId,
        taskId: task.taskId,
        attemptId,
        reason: 'retry_exhausted',
      });
    } else {
      // Retry — re-queue
      task.state = 'queued';
      await this.writeTaskLocked(task);

      if (reason === 'dispatch_failure') {
        await this.emitAuditEventLocked({
          type: 'dispatch.failed',
          runId: task.runId,
          taskId: task.taskId,
          attemptId,
          reason: 'dispatch_failure',
        });
      }

      await this.emitAuditEventLocked({
        type: 'task.retry',
        runId: task.runId,
        taskId: task.taskId,
        attemptId,
        reason,
        data: { attemptsUsed: task.attemptsUsed, maxAttempts: task.maxAttempts },
      });
    }
  }

  // -----------------------------------------------------------------------
  // Completion
  // -----------------------------------------------------------------------

  private async acceptCompletionLocked(
    submission: CompletionSubmission,
  ): Promise<{ accepted: true; idempotent: boolean }> {
    const { runId, taskId, attemptId, leaseToken, filePath, diffFingerprint, outcome, summary } = submission;

    // 0. Validate submission fields
    const VALID_OUTCOMES: ReadonlySet<string> = new Set(['findings', 'no_findings']);
    if (!VALID_OUTCOMES.has(outcome)) {
      throw new Error(
        `[OCRP-ORCH-INVALID-COMPLETION] Invalid outcome "${outcome}": must be "findings" or "no_findings"`,
      );
    }
    if (summary.length === 0) {
      throw new Error('[OCRP-ORCH-INVALID-COMPLETION] Summary must not be empty');
    }
    const MAX_SUMMARY_CODEPOINTS = 500;
    if ([...summary].length > MAX_SUMMARY_CODEPOINTS) {
      throw new Error(
        `[OCRP-ORCH-INVALID-COMPLETION] Summary exceeds ${MAX_SUMMARY_CODEPOINTS} Unicode code points`,
      );
    }

    // 1. Read task record (before run check for idempotency)
    const task = await this.readTaskLocked(taskId);
    if (!task) {
      throw new Error(`[OCRP-ORCH-INVALID-COMPLETION] Task ${taskId} not found`);
    }

    // 2. Compute completion digest from submission
    const tokenDigest = createHash('sha256').update(leaseToken).digest('hex');
    const digestPayload: Record<string, string> = {
      runId,
      taskId,
      attemptId,
      tokenDigest,
      filePath,
      diffFingerprint,
      outcome,
      summary,
    };
    const completionDigest = createHash('sha256')
      .update(JSON.stringify(digestPayload, Object.keys(digestPayload).sort()))
      .digest('hex');

    // 3. Idempotency check BEFORE active/current checks: if task already
    //    succeeded and accepted attempt has the same completion digest,
    //    return idempotent success even if the run is now completed.
    if (task.state === 'succeeded' && task.acceptedAttemptId) {
      const acceptedAttempt = await this.readAttemptLocked(taskId, task.acceptedAttemptId);
      if (acceptedAttempt && acceptedAttempt.completionDigest) {
        if (acceptedAttempt.completionDigest === completionDigest) {
          return { accepted: true, idempotent: true };
        }
        // Conflicting digest — different completion for same task
        throw new Error(
          `[OCRP-ORCH-INVALID-COMPLETION] Task ${taskId} already completed with different completion digest`,
        );
      }
    }

    // 4. Read run record — validate active (after idempotency check)
    const runRecord = await this.readRunRecordLocked();
    if (!runRecord || runRecord.state !== 'active') {
      throw new Error(
        `[OCRP-ORCH-INVALID-COMPLETION] Run is not active (state=${runRecord?.state ?? 'missing'})`,
      );
    }

    // 5. Validate task is running
    if (task.state !== 'running') {
      throw new Error(
        `[OCRP-ORCH-INVALID-COMPLETION] Task ${taskId} is not running (state=${task.state})`,
      );
    }

    // 6. Validate attempt ID matches task.currentAttemptId
    if (attemptId !== task.currentAttemptId) {
      throw new Error(
        `[OCRP-ORCH-INVALID-COMPLETION] Attempt ID mismatch: ${attemptId} !== ${task.currentAttemptId}`,
      );
    }

    // 7. Validate file path matches task.filePath
    if (filePath !== task.filePath) {
      throw new Error(
        `[OCRP-ORCH-INVALID-COMPLETION] File path mismatch: ${filePath} !== ${task.filePath}`,
      );
    }

    // 8. Validate diff fingerprint matches task.diffFingerprint
    if (diffFingerprint !== task.diffFingerprint) {
      throw new Error(
        `[OCRP-ORCH-INVALID-COMPLETION] Diff fingerprint mismatch: ${diffFingerprint} !== ${task.diffFingerprint}`,
      );
    }

    // 9. Read attempt record
    const attempt = await this.readAttemptLocked(taskId, attemptId);
    if (!attempt) {
      throw new Error(
        `[OCRP-ORCH-INVALID-COMPLETION] Attempt ${attemptId} not found for task ${taskId}`,
      );
    }

    // 10. Validate lease token SHA-256 digest matches attempt.leaseTokenDigest
    if (tokenDigest !== attempt.leaseTokenDigest) {
      throw new Error(`[OCRP-ORCH-INVALID-COMPLETION] Lease token digest mismatch`);
    }

    // 11. Validate lease not expired
    if (Date.parse(attempt.leaseDeadline) <= this.now().getTime()) {
      throw new Error(`[OCRP-ORCH-INVALID-COMPLETION] Lease has expired`);
    }

    // 12. Validate outcome/comment-count consistency
    const actualCommentCount = await this.countStagedCommentsLocked(attemptId);
    if (outcome === 'findings' && actualCommentCount === 0) {
      throw new Error(
        `[OCRP-ORCH-INVALID-COMPLETION] Outcome "findings" requires at least 1 staged comment, but found 0`,
      );
    }
    if (outcome === 'no_findings' && actualCommentCount > 0) {
      throw new Error(
        `[OCRP-ORCH-INVALID-COMPLETION] Outcome "no_findings" requires 0 staged comments, but found ${actualCommentCount}`,
      );
    }

    const now = this.now().toISOString();

    // 13. Write attempt success
    attempt.state = 'succeeded';
    attempt.outcome = outcome;
    attempt.summary = summary;
    attempt.completionDigest = completionDigest;
    attempt.updatedAt = now;
    await this.writeAttemptLocked(attempt);

    // 14. Write task success
    task.state = 'succeeded';
    task.acceptedAttemptId = attemptId;
    task.currentAttemptId = undefined;
    task.updatedAt = now;
    await this.writeTaskLocked(task);

    // 15. Derive run terminal state from all tasks
    await this.recomputeRunLocked();

    // 16. Emit audit event
    await this.emitAuditEventLocked({
      type: 'task.completed',
      runId,
      taskId,
      attemptId,
      data: { outcome, summary, completionDigest },
    });

    return { accepted: true, idempotent: false };
  }

  /**
   * Count staged comments for an attempt by reading the JSONL file.
   */
  private async countStagedCommentsLocked(attemptId: string): Promise<number> {
    const commentsPath = join(this.runDir, 'attempt-comments', `${attemptId}.jsonl`);
    try {
      const content = await readFile(commentsPath, 'utf-8');
      return content.split('\n').filter((l) => l.trim().length > 0).length;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return 0;
      }
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Run state derivation
  // -----------------------------------------------------------------------

  /**
   * Read all task records from the run directory.
   */
  private async listTasksLocked(): Promise<TaskRecord[]> {
    const tasksDir = join(this.runDir, TASKS_DIR);
    let names: string[];
    try {
      names = await readdir(tasksDir);
    } catch {
      return [];
    }
    const tasks: TaskRecord[] = [];
    for (const name of names) {
      if (!isTaskFilename(name)) continue;
      try {
        const task = await readJson<TaskRecord>(join(tasksDir, name));
        tasks.push(task);
      } catch {
        // Skip unparseable task files
      }
    }
    return tasks;
  }

  /**
   * Derive run state and counts from all task records.
   *
   * Terminal state is derived from the authoritative task set:
   * - All succeeded => completed
   * - All terminal with any failed => failed
   * - Otherwise => active
   */
  private async recomputeRunLocked(): Promise<ReconcileResult> {
    const tasks = await this.listTasksLocked();
    const taskCounts = this.computeTaskCounts(tasks);

    // Derive run state from tasks
    const totalTasks = tasks.length;
    const terminalTasks = taskCounts.succeeded + taskCounts.failed;
    let state: RunState;
    if (terminalTasks === totalTasks && totalTasks > 0) {
      state = taskCounts.failed > 0 ? 'failed' : 'completed';
    } else {
      state = 'active';
    }

    // Compute next lease deadline: earliest lease deadline among live
    // (non-expired) leased/running tasks
    let nextLeaseDeadline: string | undefined;
    for (const task of tasks) {
      if (
        (task.state === 'leased' || task.state === 'running') &&
        task.currentAttemptId
      ) {
        const attempt = await this.readAttemptLocked(
          task.taskId,
          task.currentAttemptId,
        );
        if (attempt) {
          const deadline = attempt.leaseDeadline;
          if (
            nextLeaseDeadline === undefined ||
            deadline < nextLeaseDeadline
          ) {
            nextLeaseDeadline = deadline;
          }
        }
      }
    }

    // Update run record
    const runRecord = await this.readRunRecordLocked();
    if (runRecord) {
      runRecord.state = state;
      runRecord.updatedAt = this.now().toISOString();
      if (state === 'completed' || state === 'failed') {
        runRecord.completedAt = runRecord.updatedAt;
      }
      await atomicWriteJson(join(this.runDir, RUN_RECORD_FILE), runRecord);
    }

    return {
      runId: runRecord?.runId ?? '',
      state,
      taskCounts,
      canClaim: taskCounts.queued > 0,
      nextLeaseDeadline,
      strictAggregationAllowed: state === 'completed',
    };
  }

  // -----------------------------------------------------------------------
  // Task counts
  // -----------------------------------------------------------------------

  private computeTaskCounts(tasks: TaskRecord[]): TaskCounts {
    const counts: TaskCounts = {
      queued: 0,
      leased: 0,
      running: 0,
      succeeded: 0,
      failed: 0,
    };
    for (const t of tasks) {
      switch (t.state) {
        case 'queued':
          counts.queued++;
          break;
        case 'leased':
          counts.leased++;
          break;
        case 'running':
          counts.running++;
          break;
        case 'succeeded':
          counts.succeeded++;
          break;
        case 'failed':
          counts.failed++;
          break;
      }
    }
    return counts;
  }

  // -----------------------------------------------------------------------
  // Code comment staging
  // -----------------------------------------------------------------------

  private async stageCommentsLocked(
    credentials: AttemptCredentials,
    records: CommentRecord[],
  ): Promise<string[]> {
    // 1. Validate run is active
    const runRecord = await this.readRunRecordLocked();
    if (!runRecord || runRecord.state !== 'active') {
      throw new Error(`Run is not active (state=${runRecord?.state ?? 'missing'})`);
    }

    // 2. Read task via credentials.taskId
    const task = await this.readTaskLocked(credentials.taskId);
    if (!task) {
      throw new Error(`Task ${credentials.taskId} not found`);
    }

    // 3. Validate task is running
    if (task.state !== 'running') {
      throw new Error(`Task ${credentials.taskId} is not running (state=${task.state})`);
    }

    // 4. Validate attempt ID matches task.currentAttemptId
    if (credentials.attemptId !== task.currentAttemptId) {
      throw new Error(
        `Attempt ID mismatch: ${credentials.attemptId} !== ${task.currentAttemptId}`,
      );
    }

    // 5. Validate file path matches task.filePath
    if (credentials.filePath !== task.filePath) {
      throw new Error(
        `File path mismatch: ${credentials.filePath} !== ${task.filePath}`,
      );
    }

    // 6. Validate diff fingerprint matches task.diffFingerprint
    if (credentials.diffFingerprint !== task.diffFingerprint) {
      throw new Error(
        `Diff fingerprint mismatch: ${credentials.diffFingerprint} !== ${task.diffFingerprint}`,
      );
    }

    // 7. Read attempt record
    const attempt = await this.readAttemptLocked(credentials.taskId, credentials.attemptId);
    if (!attempt) {
      throw new Error(`Attempt ${credentials.attemptId} not found for task ${credentials.taskId}`);
    }

    // 8. Validate lease token SHA-256 digest matches attempt.leaseTokenDigest
    const tokenDigest = createHash('sha256').update(credentials.leaseToken).digest('hex');
    if (tokenDigest !== attempt.leaseTokenDigest) {
      throw new Error('Lease token digest mismatch');
    }

    // 9. Validate lease not expired
    if (Date.parse(attempt.leaseDeadline) <= this.now().getTime()) {
      throw new Error('Lease has expired');
    }

    // 10. Read existing JSONL from attempt-comments/<attemptId>.jsonl
    const commentsPath = join(this.runDir, 'attempt-comments', `${credentials.attemptId}.jsonl`);
    let recoveredCount = 0;
    try {
      const existingContent = await readFile(commentsPath, 'utf-8');
      const lines = existingContent.split('\n').filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          JSON.parse(line);
        } catch {
          throw new Error(`Malformed JSONL line in ${commentsPath}: ${line}`);
        }
      }
      recoveredCount = lines.length;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // No existing file, that's fine
      } else {
        throw err;
      }
    }

    // 11. Ensure attempt-comments dir exists
    await mkdir(join(this.runDir, 'attempt-comments'), { recursive: true });

    // 12. Append each record as a JSONL line
    const jsonlLines = records.map((r) => JSON.stringify(r));
    await appendFile(commentsPath, jsonlLines.join('\n') + '\n', { encoding: 'utf-8', flag: 'a' });

    // 13. Update attempt.stagedCommentCount
    const newCount = recoveredCount + records.length;
    attempt.stagedCommentCount = newCount;
    attempt.updatedAt = this.now().toISOString();
    await this.writeAttemptLocked(attempt);

    // 14. Emit audit event
    await this.emitAuditEventLocked({
      type: 'comment.staged',
      runId: runRecord.runId,
      taskId: credentials.taskId,
      attemptId: credentials.attemptId,
      data: { count: records.length, stagedCommentCount: newCount },
    });

    // 15. Return the comment_ids array
    return records.map((r) => r.comment_id);
  }

  // -----------------------------------------------------------------------
  // Read / write helpers
  // -----------------------------------------------------------------------

  private async getRunIdLocked(): Promise<string> {
    const record = await this.readRunRecordLocked();
    return record?.runId ?? '';
  }

  private async readRunRecordLocked(): Promise<RunRecord | null> {
    try {
      return await readJson<RunRecord>(join(this.runDir, RUN_RECORD_FILE));
    } catch {
      return null;
    }
  }

  private async readTaskLocked(taskId: string): Promise<TaskRecord | null> {
    try {
      return await readJson<TaskRecord>(
        join(this.runDir, TASKS_DIR, `${taskId}.json`),
      );
    } catch {
      return null;
    }
  }

  private async writeTaskLocked(task: TaskRecord): Promise<void> {
    await atomicWriteJson(
      join(this.runDir, TASKS_DIR, `${task.taskId}.json`),
      task,
    );
  }

  private async readAttemptLocked(
    taskId: string,
    attemptId: string,
  ): Promise<AttemptRecord | null> {
    try {
      return await readJson<AttemptRecord>(
        join(this.runDir, TASKS_DIR, `${taskId}.${attemptId}.json`),
      );
    } catch {
      return null;
    }
  }

  private async writeAttemptLocked(attempt: AttemptRecord): Promise<void> {
    await atomicWriteJson(
      join(this.runDir, TASKS_DIR, `${attempt.taskId}.${attempt.attemptId}.json`),
      attempt,
    );
  }

  private async emitAuditEventLocked(
    partial: Omit<AuditEvent, 'schemaVersion' | 'eventId' | 'ts'>,
  ): Promise<void> {
    const event: AuditEvent = {
      schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
      eventId: randomUUID(),
      ts: this.now().toISOString(),
      ...partial,
    };
    await appendAuditEvent(join(this.runDir, AUDIT_FILE), event);
  }
}
