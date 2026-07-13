import { randomBytes, randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
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
} from './types.js';
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
