export const ORCHESTRATOR_SCHEMA_VERSION = 1;
export const DEFAULT_LEASE_DURATION_MS = 900_000;
export const DEFAULT_MAX_ATTEMPTS = 2;

/**
 * Predicate to distinguish a task record filename from an attempt record
 * filename in the tasks/ directory.
 *
 * Task records follow the pattern `<taskId>.json` (e.g. `task-0.json`).
 * Attempt records follow the pattern `<taskId>.<attemptId>.json` (e.g.
 * `task-0.attempt-uuid.json`).  The distinguishing feature is that a task
 * record's stem (filename minus `.json`) contains no dot, while an attempt
 * record's stem contains at least one dot.
 */
export function isTaskFilename(name: string): boolean {
  if (!name.endsWith('.json')) return false;
  const stem = name.slice(0, -5); // remove '.json'
  return !stem.includes('.');
}

export type RunState = 'active' | 'completed' | 'failed' | 'superseded';
export type TaskState = 'queued' | 'leased' | 'running' | 'succeeded' | 'failed';
export type AttemptState = 'leased' | 'running' | 'succeeded' | 'failed' | 'expired';
export type CompletionOutcome = 'findings' | 'no_findings';
export type FailureReason = 'dispatch_failure' | 'lease_expired' | 'retry_exhausted';

export interface LaunchConfig {
  schemaVersion: 1;
  mode: 'workspace' | 'staged' | 'commit' | 'range';
  commit?: string;
  from?: string;
  to?: string;
  paths?: string[];
  background?: string;
  rulesPath?: string;
  plansPath?: string;
  format?: 'markdown' | 'json' | 'both';
  concurrency: number;
  leaseDurationMs: number;
  maxAttempts: number;
}

export interface ManifestFile {
  manifestIndex: number;
  path: string;
  diffFingerprint: string;
  changedLines: number;
  status: string;
}

export interface ReviewManifest {
  schemaVersion: 1;
  runId: string;
  repoIdentity: string;
  argsFingerprint: string;
  diffFingerprint: string;
  files: ManifestFile[];
  excludedFiles: Array<{ path: string; reason: string }>;
  createdAt: string;
}

export interface RunRecord {
  schemaVersion: 1;
  runId: string;
  state: RunState;
  manifestDigest: string;
  repoIdentity: string;
  argsFingerprint: string;
  diffFingerprint: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  supersededBy?: string;
  supersededAt?: string;
}

export interface TaskRecord {
  runId: string;
  taskId: string;
  manifestIndex: number;
  filePath: string;
  diffFingerprint: string;
  state: TaskState;
  currentAttemptId?: string;
  acceptedAttemptId?: string;
  attemptsUsed: number;
  maxAttempts: number;
  failureReason?: FailureReason;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptRecord {
  runId: string;
  taskId: string;
  attemptId: string;
  state: AttemptState;
  leaseTokenDigest: string;
  leaseDeadline: string;
  stagedCommentCount: number;
  completionDigest?: string;
  outcome?: CompletionOutcome;
  summary?: string;
  failureReason?: FailureReason;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimResult {
  runId: string;
  taskId: string;
  attemptId: string;
  leaseToken: string;
  leaseDeadline: string;
  filePath: string;
  diffFingerprint: string;
}

export interface CompletionSubmission extends Omit<ClaimResult, 'leaseDeadline'> {
  outcome: CompletionOutcome;
  summary: string;
}

export interface TaskCounts {
  queued: number;
  leased: number;
  running: number;
  succeeded: number;
  failed: number;
}

export interface ReconcileResult {
  runId: string;
  state: RunState;
  taskCounts: TaskCounts;
  canClaim: boolean;
  nextLeaseDeadline?: string;
  strictAggregationAllowed: boolean;
}

export interface AttemptCredentials {
  taskId: string;
  attemptId: string;
  leaseToken: string;
  filePath: string;
  diffFingerprint: string;
}

export interface CodeCommentInput {
  taskId: string;
  attemptId: string;
  leaseToken: string;
  filePath: string;
  diffFingerprint: string;
  comment: unknown;
}

export interface AuditEvent {
  schemaVersion: 1;
  eventId: string;
  type: string;
  ts: string;
  runId: string;
  taskId?: string;
  attemptId?: string;
  reason?: string;
  data?: unknown;
}
