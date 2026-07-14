import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { ReviewContext } from '../model/request.js';
import type { ReviewManifest, RunRecord, TaskRecord, TaskCounts, RunState } from './types.js';
import { ORCHESTRATOR_SCHEMA_VERSION, isTaskFilename } from './types.js';
import { manifestDigest, buildManifest as buildFingerprintManifest, repositoryIdentity } from './fingerprint.js';
import { atomicWriteJson, readJson } from './storage.js';
import { resolveExistingRunDir, listRunDirsNear, readContext, readLaunchConfig } from '../runs/store.js';
import { withRunLock } from './lock.js';
import { Orchestrator } from './orchestrator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MANIFEST_FILE = 'manifest.json';
const RUN_RECORD_FILE = 'run.json';
const TASKS_DIR = 'tasks';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Read a run record from a run directory.
 */
async function readRunRecord(runDir: string): Promise<RunRecord | null> {
  try {
    return await readJson<RunRecord>(join(runDir, RUN_RECORD_FILE));
  } catch {
    return null;
  }
}

/**
 * Read a manifest from a run directory.
 */
async function readManifest(runDir: string): Promise<ReviewManifest | null> {
  try {
    return await readJson<ReviewManifest>(join(runDir, MANIFEST_FILE));
  } catch {
    return null;
  }
}

/**
 * Read all task records from a run directory.
 */
async function readAllTasks(runDir: string): Promise<TaskRecord[]> {
  const tasksDir = join(runDir, TASKS_DIR);
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
 * Compute task counts from task records.
 */
function computeTaskCounts(tasks: TaskRecord[]): TaskCounts {
  const counts: TaskCounts = { queued: 0, leased: 0, running: 0, succeeded: 0, failed: 0 };
  for (const t of tasks) {
    switch (t.state) {
      case 'queued': counts.queued++; break;
      case 'leased': counts.leased++; break;
      case 'running': counts.running++; break;
      case 'succeeded': counts.succeeded++; break;
      case 'failed': counts.failed++; break;
    }
  }
  return counts;
}

/**
 * Check if a run record and manifest constitute a valid schema-1 run that can
 * be resumed. Must match: schema-1 run record, schema-1 manifest, manifest
 * digest matches, and the run is 'active'.
 */
function isValidResumableRun(
  runRecord: RunRecord | null,
  manifest: ReviewManifest | null,
): boolean {
  if (!runRecord || !manifest) return false;
  if (runRecord.schemaVersion !== ORCHESTRATOR_SCHEMA_VERSION) return false;
  if (manifest.schemaVersion !== ORCHESTRATOR_SCHEMA_VERSION) return false;
  if (runRecord.state !== 'active') return false;
  // Verify manifest integrity
  if (runRecord.manifestDigest !== manifestDigest(manifest)) return false;
  return true;
}

/**
 * Check if a manifest matches the candidate's fingerprints.
 */
function manifestsMatch(
  manifest: ReviewManifest,
  candidateManifest: ReviewManifest,
): boolean {
  return (
    manifest.repoIdentity === candidateManifest.repoIdentity &&
    manifest.argsFingerprint === candidateManifest.argsFingerprint &&
    manifest.diffFingerprint === candidateManifest.diffFingerprint
  );
}

/**
 * Find the newest active schema-1 run for the same repository identity.
 * Returns the run directory and run record, or null if none found.
 */
async function findNewestActiveRunForRepo(
  runDirs: string[],
  repoIdentity: string,
): Promise<{ runDir: string; runRecord: RunRecord } | null> {
  let newest: { runDir: string; runRecord: RunRecord } | null = null;
  let newestCreatedAt = '';

  for (const dir of runDirs) {
    const runRecord = await readRunRecord(dir);
    if (!runRecord) continue;
    if (runRecord.schemaVersion !== ORCHESTRATOR_SCHEMA_VERSION) continue;
    if (runRecord.state !== 'active') continue;
    if (runRecord.repoIdentity !== repoIdentity) continue;

    // Verify manifest exists and is valid
    const manifest = await readManifest(dir);
    if (!isValidResumableRun(runRecord, manifest)) continue;

    if (runRecord.createdAt > newestCreatedAt) {
      newestCreatedAt = runRecord.createdAt;
      newest = { runDir: dir, runRecord };
    }
  }

  return newest;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Result of selecting the effective run.
 */
export interface EffectiveRunResult {
  effectiveRunId: string;
  resumed: boolean;
  state: RunState;
  taskCounts: TaskCounts;
}

/**
 * Select the effective run for a candidate.
 *
 * - If a compatible active run exists (same repo/args/diff fingerprints,
 *   valid schema-1 manifest), resume it: return its runId.
 * - Otherwise, prepare the candidate as a new run.
 *
 * When resuming, the candidate context directory is left as diagnostic input.
 * The old manifest and tasks are never overwritten.
 */
export async function selectEffectiveRun(
  candidateRunId: string,
  candidateManifest: ReviewManifest,
  repoRoot: string,
): Promise<EffectiveRunResult> {
  const candidateDir = await resolveExistingRunDir(candidateRunId);
  if (!candidateDir) {
    throw new Error(`Candidate run directory not found: ${candidateRunId}`);
  }

  // Scan nearby run directories
  const runDirs = await listRunDirsNear(candidateRunId);

  // Look for a compatible active run to resume
  for (const dir of runDirs) {
    const runDirName = dir.split('/').pop() ?? '';
    if (runDirName === candidateRunId) continue; // Skip self

    const runRecord = await readRunRecord(dir);
    const manifest = await readManifest(dir);

    if (!isValidResumableRun(runRecord, manifest)) continue;
    // After the guard, both are non-null and valid
    if (!manifestsMatch(manifest!, candidateManifest)) continue;

    // Found a compatible active run — resume it
    const tasks = await readAllTasks(dir);
    const taskCounts = computeTaskCounts(tasks);

    return {
      effectiveRunId: runRecord!.runId,
      resumed: true,
      state: runRecord!.state,
      taskCounts,
    };
  }

  // No compatible run found — prepare candidate as new run
  // Before initializing, supersede the newest active schema-1 run for the same repo
  const newestActive = await findNewestActiveRunForRepo(runDirs, candidateManifest.repoIdentity);
  if (newestActive) {
    await withRunLock(newestActive.runDir, async () => {
      const record = await readRunRecord(newestActive.runDir);
      if (record && record.state === 'active') {
        record.state = 'superseded';
        record.supersededBy = candidateRunId;
        record.supersededAt = new Date().toISOString();
        record.updatedAt = new Date().toISOString();
        await atomicWriteJson(join(newestActive.runDir, RUN_RECORD_FILE), record);
      }
    });
  }

  // Initialize candidate directory
  await initializeCandidate(candidateDir, candidateManifest);

  return {
    effectiveRunId: candidateRunId,
    resumed: false,
    state: 'active',
    taskCounts: { queued: candidateManifest.files.length, leased: 0, running: 0, succeeded: 0, failed: 0 },
  };
}

/**
 * Initialize a candidate run directory with manifest, run record, and tasks.
 */
async function initializeCandidate(
  candidateDir: string,
  manifest: ReviewManifest,
): Promise<void> {
  // Write immutable manifest
  await atomicWriteJson(join(candidateDir, MANIFEST_FILE), manifest);

  // Write run record
  const runRecord: RunRecord = {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    runId: manifest.runId,
    state: 'active',
    manifestDigest: manifestDigest(manifest),
    repoIdentity: manifest.repoIdentity,
    argsFingerprint: manifest.argsFingerprint,
    diffFingerprint: manifest.diffFingerprint,
    createdAt: manifest.createdAt,
    updatedAt: manifest.createdAt,
  };
  await atomicWriteJson(join(candidateDir, RUN_RECORD_FILE), runRecord);

  // Create one queued task per file in manifest order
  const tasksDir = join(candidateDir, TASKS_DIR);
  await mkdir(tasksDir, { recursive: true });

  for (const file of manifest.files) {
    const taskId = `task-${file.manifestIndex}`;
    const task: TaskRecord = {
      runId: manifest.runId,
      taskId,
      manifestIndex: file.manifestIndex,
      filePath: file.path,
      diffFingerprint: file.diffFingerprint,
      state: 'queued',
      attemptsUsed: 0,
      maxAttempts: 2,
      createdAt: manifest.createdAt,
      updatedAt: manifest.createdAt,
    };
    await atomicWriteJson(join(tasksDir, `${taskId}.json`), task);
  }
}

// ---------------------------------------------------------------------------
// High-level API
// ---------------------------------------------------------------------------

/**
 * Result of starting a candidate run.
 */
export interface StartCandidateResult {
  candidateRunId: string;
  effectiveRunId: string;
  resumed: boolean;
  state: RunState;
  taskCounts: TaskCounts;
  nextLeaseDeadline?: string;
}

/**
 * Start a candidate run: read context and launch config, compute fingerprints,
 * select effective run, and initialize if needed.
 *
 * This is the high-level entry point used by the orchestrator_start CLI.
 */
export async function startCandidate(candidateRunId: string): Promise<StartCandidateResult> {
  // Read context and launch config
  const context = await readContext<ReviewContext>(candidateRunId);
  const launch = await readLaunchConfig(candidateRunId);

  // Compute repository identity
  const repoId = context.repoRoot
    ? await repositoryIdentity(context.repoRoot)
    : 'unknown';

  // Build candidate manifest
  const candidateManifest = buildFingerprintManifest(context, launch, candidateRunId, repoId);

  // Select effective run
  const result = await selectEffectiveRun(candidateRunId, candidateManifest, context.repoRoot);

  // If resuming, reconcile leases on the effective run so stale leases are
  // expired before returning. The Orchestrator is constructed on the effective
  // run directory and reconcile() acquires its own lock (no nested lock issue
  // since we are outside any withRunLock scope).
  let reconcileResult: Awaited<ReturnType<Orchestrator['reconcile']>> | undefined;
  if (result.resumed) {
    const effectiveRunDir = await resolveExistingRunDir(result.effectiveRunId);
    if (effectiveRunDir) {
      const orchestrator = new Orchestrator(effectiveRunDir);
      reconcileResult = await orchestrator.reconcile();
    }
  }

  return {
    candidateRunId,
    effectiveRunId: result.effectiveRunId,
    resumed: result.resumed,
    state: reconcileResult?.state ?? result.state,
    taskCounts: reconcileResult?.taskCounts ?? result.taskCounts,
    nextLeaseDeadline: reconcileResult?.nextLeaseDeadline,
  };
}
