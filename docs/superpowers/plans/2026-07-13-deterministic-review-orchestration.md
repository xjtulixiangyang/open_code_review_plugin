# Deterministic Review Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make complete per-file review coverage a programmatically enforced invariant for both Claude Code and OpenCode.

**Architecture:** `ocr-prepare` writes a candidate context plus normalized launch configuration. A shared TypeScript pull orchestrator computes an immutable manifest, resumes a fingerprint-compatible active run or initializes the candidate run, and exclusively owns task, attempt, lease, retry, and terminal state. Host commands only claim and dispatch work; attempt-scoped tools validate credentials, and strict aggregation succeeds only after every manifest task succeeds.

**Tech Stack:** TypeScript 5.5, Node.js >=18, Node test runner via `tsx`, filesystem-backed `.ocr-runs`, SHA-256, `write-file-atomic` 5.x, Markdown command/agent/skill contracts.

## Global Constraints

- Support Node.js >=18 and Windows, macOS, and Linux.
- Use schema major version `1`, a default lease duration of `900_000` ms, and a default maximum of `2` attempts per file.
- Store only SHA-256 lease-token digests; never persist plaintext lease tokens or write them to audit events.
- A report may be partial, but a partial review must exit non-zero and must never be reported as successful.
- Resume only the current schema and an exact repository, launch-configuration, and full-diff fingerprint match.
- A changed snapshot starts a new run and supersedes the prior active run selected for the same repository.
- Keep legacy runs readable by legacy aggregation, but never auto-resume or upgrade them.
- Do not modify or stage the user's existing changes in `src/core/prompts/main_task.ts`, `codespec/.aidesign-store.tmp.json`, or `codespec/changes/main/*.md`.
- Do not change filtering, relocation, posting, rule semantics, or Go-style memory/telemetry behavior except where strict aggregation must consume accepted-attempt comments.
- Every task below ends with a focused commit containing only that task's files. Append `Co-Authored-By: Claude <noreply@anthropic.com>` to each commit message.

## File Structure

Create focused modules under `src/core/orchestrator/`:

- `types.ts`: versioned manifest/run/task/attempt/config/result contracts and stable reason codes.
- `storage.ts`: atomic JSON writes, locked JSONL append, record readers, path-key hardening.
- `lock.ts`: non-reentrant run lock using atomic directory creation and stale-lock tombstones.
- `fingerprint.ts`: canonical JSON and repository/arguments/diff SHA-256 fingerprints.
- `manifest.ts`: immutable manifest construction and validation.
- `orchestrator.ts`: start/resume, claim, dispatch acknowledgement/failure, reconcile, comments, completion, and status.

Create CLI wrappers in `src/cli/orchestrator_start.ts`, `orchestrator_claim.ts`, `orchestrator_ack.ts`, `orchestrator_dispatch_fail.ts`, `orchestrator_reconcile.ts`, and `orchestrator_status.ts`. Extend existing tools and reports rather than duplicating their parsing/rendering layers.

---

### Task 1: Persist Normalized Launch Configuration and Resolve Run Roots

**Files:**
- Create: `src/core/orchestrator/types.ts`
- Modify: `src/core/runs/store.ts:34-102,228-230`
- Modify: `src/cli/prepare.ts:13-28,95-138`
- Test: `src/core/orchestrator/__tests__/run_store.test.ts`
- Test: `src/cli/__tests__/prepare.test.ts`

**Interfaces:**
- Produces: `LaunchConfig`, `ReviewManifest`, `RunRecord`, `TaskRecord`, `AttemptRecord`, `ClaimResult`, `CompletionSubmission`, `ReconcileResult`.
- Produces: `resolveExistingRunDir(runId): Promise<string | null>`, `listRunDirsNear(runId): Promise<string[]>`, `writeLaunchConfig(runId, config)`, `readLaunchConfig(runId)`.
- Consumes later: every orchestrator and CLI task uses these exact contracts and paths.

- [ ] **Step 1: Write failing run-store and prepare tests**

```ts
// src/core/orchestrator/__tests__/run_store.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listRunDirsNear,
  readLaunchConfig,
  resolveExistingRunDir,
  writeContext,
  writeLaunchConfig,
} from '../../runs/store.js';

test('launch config round-trips and the candidate run is discoverable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocr-run-store-'));
  const previous = process.cwd();
  process.chdir(root);
  try {
    await writeContext('candidate', { runId: 'candidate' });
    await writeLaunchConfig('candidate', {
      schemaVersion: 1,
      mode: 'workspace',
      concurrency: 2,
      leaseDurationMs: 900_000,
      maxAttempts: 2,
    });
    assert.equal((await readLaunchConfig('candidate')).mode, 'workspace');
    assert.equal(await resolveExistingRunDir('candidate'), join(root, '.ocr-runs', 'candidate'));
    assert.deepEqual(await listRunDirsNear('candidate'), [join(root, '.ocr-runs', 'candidate')]);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});
```

Add to `src/cli/__tests__/prepare.test.ts` an assertion that `.ocr-runs/<runId>/launch.json` contains normalized `concurrency: 2`, `leaseDurationMs: 900000`, `maxAttempts: 2`, and excludes `resumeRunId`.

Add `safePathKey` assertions to `run_store.test.ts`:

```ts
assert.equal(safePathKey('src/a.ts'), 'src%2Fa.ts');
assert.match(safePathKey('src/CON.ts'), /^src%2FCON-[a-f0-9]{64}$/);
const longKey = safePathKey(`src/${'x'.repeat(300)}.ts`);
assert.ok(Buffer.byteLength(longKey, 'utf8') <= 200);
assert.match(longKey, /-[a-f0-9]{64}$/);
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
node --import tsx --test src/core/orchestrator/__tests__/run_store.test.ts src/cli/__tests__/prepare.test.ts
```

Expected: FAIL because `types.ts`, launch-config helpers, and `launch.json` do not exist.

- [ ] **Step 3: Define exact versioned contracts**

```ts
// src/core/orchestrator/types.ts
export const ORCHESTRATOR_SCHEMA_VERSION = 1;
export const DEFAULT_LEASE_DURATION_MS = 900_000;
export const DEFAULT_MAX_ATTEMPTS = 2;

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
```

- [ ] **Step 4: Export worktree-aware run discovery and launch-config helpers**

Refactor the existing private resolver in `src/core/runs/store.ts` without changing existing callers:

```ts
export async function resolveExistingRunDir(runId: string): Promise<string | null> {
  const containing = containingRunDir(runId);
  if (containing && await fileExists(join(containing, 'context.json'))) return containing;
  const current = runDir(runId);
  if (await fileExists(join(current, 'context.json'))) return current;
  const parent = worktreeParentRunDir(runId);
  if (parent && await fileExists(join(parent, 'context.json'))) return parent;
  return null;
}

async function resolveRunDir(runId: string): Promise<string> {
  return await resolveExistingRunDir(runId) ?? runDir(runId);
}

export async function listRunDirsNear(runId: string): Promise<string[]> {
  const candidate = await resolveExistingRunDir(runId);
  const root = dirname(candidate ?? runDir(runId));
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return names.sort().map((name) => join(root, name));
}

export async function writeLaunchConfig(runId: string, config: LaunchConfig): Promise<void> {
  const dir = runDir(runId);
  await ensureDir(dir);
  await writeFile(join(dir, 'launch.json'), JSON.stringify(config, null, 2), 'utf8');
}

export async function readLaunchConfig(runId: string): Promise<LaunchConfig> {
  const dir = await resolveRunDir(runId);
  return JSON.parse(await readFile(join(dir, 'launch.json'), 'utf8')) as LaunchConfig;
}
```

Replace `safePathKey` with a hardened, backward-compatible implementation:

```ts
const WINDOWS_RESERVED_NAMES = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

export function safePathKey(path: string): string {
  const encoded = encodeURIComponent(path);
  const segments = path.replace(/\\/g, '/').split('/');
  const reserved = segments.some((segment) => WINDOWS_RESERVED_NAMES.has(segment.replace(/\.[^/.]+$/, '').toLowerCase()));
  if (!reserved && Buffer.byteLength(encoded, 'utf8') <= 200) return encoded;
  const digest = createHash('sha256').update(path, 'utf8').digest('hex');
  const prefix = encoded.slice(0, Math.max(1, 199 - digest.length - 1));
  return `${prefix}-${digest}`;
}
```

Import `createHash` from `node:crypto` at the top of `store.ts`. In `prepare.ts`, construct and persist `LaunchConfig` from `ParsedArgs` plus normalized concurrency. Do not include `resumeRunId`, `preview`, or `dryRun`; those do not define the executable review snapshot.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
node --import tsx --test src/core/orchestrator/__tests__/run_store.test.ts src/cli/__tests__/prepare.test.ts
npm run typecheck
```

Expected: PASS; no TypeScript errors.

- [ ] **Step 6: Commit the launch-contract foundation**

```bash
git add src/core/orchestrator/types.ts src/core/orchestrator/__tests__/run_store.test.ts src/core/runs/store.ts src/cli/prepare.ts src/cli/__tests__/prepare.test.ts
git commit -m $'feat(orchestrator): persist normalized launch configuration\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
```

---

### Task 2: Add Atomic Records, Audit Events, and a Non-Reentrant Run Lock

**Files:**
- Modify: `package.json`
- Modify: lockfile generated by `npm install`
- Create: `src/core/orchestrator/storage.ts`
- Create: `src/core/orchestrator/lock.ts`
- Test: `src/core/orchestrator/__tests__/storage.test.ts`
- Test: `src/core/orchestrator/__tests__/lock.test.ts`

**Interfaces:**
- Produces: `atomicWriteJson<T>(path, value)`, `readJson<T>(path)`, `appendAuditEvent(path, event)`.
- Produces: `withRunLock<T>(runDir, operation): Promise<T>`; it is deliberately non-reentrant.
- Consumes: Task 1 types.

- [ ] **Step 1: Write failing storage and lock tests**

```ts
// src/core/orchestrator/__tests__/lock.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRunLock } from '../lock.js';

test('only one concurrent mutation enters the critical section', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-lock-'));
  let inside = 0;
  let peak = 0;
  try {
    await Promise.all(Array.from({ length: 8 }, () => withRunLock(dir, async () => {
      inside += 1;
      peak = Math.max(peak, inside);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inside -= 1;
    })));
    assert.equal(peak, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

Storage tests must assert replacement leaves valid JSON, concurrent locked event appends retain every event ID, and an expired lock directory is atomically renamed to a tombstone and recovered.

- [ ] **Step 2: Run tests and verify module-not-found failure**

```bash
node --import tsx --test src/core/orchestrator/__tests__/storage.test.ts src/core/orchestrator/__tests__/lock.test.ts
```

Expected: FAIL because `storage.ts` and `lock.ts` do not exist.

- [ ] **Step 3: Add the justified cross-platform atomic-write dependency**

Run:

```bash
npm install write-file-atomic@^5.0.1
```

Expected: `package.json` and the repository lockfile record `write-file-atomic`; this dependency is required because unlink-then-rename creates a visibility gap and overwrite-rename semantics differ on Windows.

- [ ] **Step 4: Implement atomic records and event envelopes**

```ts
// src/core/orchestrator/storage.ts
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import writeFileAtomic from 'write-file-atomic';
import type { AuditEvent } from './types.js';

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n', { fsync: true });
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function appendAuditEvent(file: string, event: AuditEvent): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(event) + '\n', { encoding: 'utf8', flag: 'a' });
}
```

Add `AuditEvent` to `types.ts` with envelope `{ schemaVersion: 1, eventId, type, ts, runId, taskId?, attemptId?, reason?, data? }` and no lease-token field.

- [ ] **Step 5: Implement a non-reentrant directory lock**

`withRunLock` must use `mkdir(.orchestrator.lock)` for acquisition, retry with bounded jitter, store owner/expiry in `owner.json`, atomically rename stale lock directories to unique tombstones, remove only the tombstone successfully renamed by this contender, and verify owner ID before release. Internal orchestrator methods called while locked must be named `*Locked` and must never call `withRunLock`.

```ts
export async function withRunLock<T>(runDir: string, operation: () => Promise<T>): Promise<T> {
  const ownerId = randomUUID();
  await acquire(runDir, ownerId, 30_000);
  try {
    return await operation();
  } finally {
    await releaseIfOwner(runDir, ownerId);
  }
}
```

- [ ] **Step 6: Run focused tests**

```bash
node --import tsx --test src/core/orchestrator/__tests__/storage.test.ts src/core/orchestrator/__tests__/lock.test.ts
npm run typecheck
```

Expected: PASS, including concurrent exclusion and stale-lock recovery.

- [ ] **Step 7: Commit storage and locking**

```bash
git add package.json package-lock.json src/core/orchestrator/storage.ts src/core/orchestrator/lock.ts src/core/orchestrator/types.ts src/core/orchestrator/__tests__/storage.test.ts src/core/orchestrator/__tests__/lock.test.ts
git commit -m $'feat(orchestrator): add atomic storage and run locking\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
```

---

### Task 3: Build Immutable Manifests and Select the Effective Run

**Files:**
- Create: `src/core/orchestrator/fingerprint.ts`
- Create: `src/core/orchestrator/manifest.ts`
- Create: `src/cli/orchestrator_start.ts`
- Test: `src/core/orchestrator/__tests__/manifest.test.ts`
- Test: `src/cli/__tests__/orchestrator_start.test.ts`

**Interfaces:**
- Consumes: `readContext`, `readLaunchConfig`, `listRunDirsNear`, Task 1 types, Task 2 storage/lock.
- Produces: `buildManifest(context, launch, effectiveRunId)`, `manifestDigest(manifest)`, `selectEffectiveRun(candidateRunId)`.
- Produces CLI JSON: `{ candidateRunId, effectiveRunId, resumed, state, taskCounts }`.

- [ ] **Step 1: Write failing fingerprint, fresh-start, resume, and supersede tests**

The resume test must create candidate `B` with the same context/config as active run `A`, call start on `B`, and assert `effectiveRunId === 'A'`. The changed-diff test must assert `effectiveRunId === 'B'` and old run `A` becomes `superseded` with `supersededBy: 'B'`. Add a test proving a run without schema-1 `manifest.json` is never resumed.

```ts
test('start returns the compatible active run instead of the candidate', async () => {
  const result = await startCandidate('candidate-b');
  assert.deepEqual(result, {
    candidateRunId: 'candidate-b',
    effectiveRunId: 'active-a',
    resumed: true,
    state: 'active',
    taskCounts: { queued: 1, leased: 0, running: 0, succeeded: 1, failed: 0 },
  });
});
```

- [ ] **Step 2: Run tests and verify failure**

```bash
node --import tsx --test src/core/orchestrator/__tests__/manifest.test.ts src/cli/__tests__/orchestrator_start.test.ts
```

Expected: FAIL because manifest/fingerprint/start modules do not exist.

- [ ] **Step 3: Implement canonical fingerprints and manifest validation**

```ts
export function canonicalJson(value: unknown): string;
export function sha256(value: string): string;
export async function repositoryIdentity(repoRoot: string): Promise<string>;
export function buildManifest(
  context: ReviewContext,
  launch: LaunchConfig,
  effectiveRunId: string,
  repoIdentity: string,
): ReviewManifest;
```

Canonicalize object keys recursively; preserve array order. Repository identity is SHA-256 of normalized repo root, origin URL if present, and current `HEAD`. Full diff fingerprint hashes canonical ordered entries `{ path, oldPath, status, diff, truncated }`; file fingerprints hash path plus exact diff. Arguments fingerprint hashes the persisted `LaunchConfig`.

- [ ] **Step 4: Implement effective-run selection without altering prepare output**

`orchestrator_start` reads the candidate's context and `launch.json`, computes fingerprints, then scans `listRunDirsNear(candidateRunId)`. It may resume only an active schema-1 run with matching repo/args/diff fingerprints and a valid manifest. Otherwise it initializes the candidate directory, writes immutable `manifest.json`, creates one queued task per manifest file in manifest order, and supersedes the newest active schema-1 run for the same repository identity.

When resuming, leave the candidate context directory as diagnostic input and return the old effective run ID. Do not overwrite the old manifest or recreate its tasks.

- [ ] **Step 5: Run focused tests and typecheck**

```bash
node --import tsx --test src/core/orchestrator/__tests__/manifest.test.ts src/cli/__tests__/orchestrator_start.test.ts
npm run typecheck
```

Expected: PASS for fresh start, exact resume, changed-diff supersede, stable ordering, and legacy non-resume.

- [ ] **Step 6: Commit manifest and start protocol**

```bash
git add src/core/orchestrator/fingerprint.ts src/core/orchestrator/manifest.ts src/cli/orchestrator_start.ts src/core/orchestrator/__tests__/manifest.test.ts src/cli/__tests__/orchestrator_start.test.ts
git commit -m $'feat(orchestrator): add manifest and effective run selection\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
```

---

### Task 4: Implement Claim and Dispatch State Transitions

**Files:**
- Create: `src/core/orchestrator/orchestrator.ts`
- Test: `src/core/orchestrator/__tests__/claim.test.ts`

**Interfaces:**
- Consumes: initialized run/task/manifest records from Task 3.
- Produces: `claim(capacity)`, `acknowledgeDispatch(taskId, attemptId)`, `reportDispatchFailure(taskId, attemptId)`.
- Invariant: only `queued -> leased -> running`; attempts increment only at claim.

- [ ] **Step 1: Write failing state-transition tests**

Tests must cover capacity validation (`1..8`), manifest ordering, unique high-entropy tokens, persisted SHA-256 digest only, duplicate concurrent claims, invalid acknowledgement, explicit dispatch failure retry, and second dispatch failure exhausting the default two attempts.

```ts
test('concurrent claims never lease the same logical task twice', async () => {
  const batches = await Promise.all([orchestrator.claim(2), orchestrator.claim(2)]);
  const taskIds = batches.flat().map((claim) => claim.taskId);
  assert.equal(new Set(taskIds).size, taskIds.length);
});
```

- [ ] **Step 2: Run test and verify failure**

```bash
node --import tsx --test src/core/orchestrator/__tests__/claim.test.ts
```

Expected: FAIL because `Orchestrator` does not exist.

- [ ] **Step 3: Implement locked public methods and unlocked internals**

```ts
export class Orchestrator {
  constructor(readonly runDir: string) {}

  claim(capacity: number): Promise<ClaimResult[]> {
    return withRunLock(this.runDir, () => this.claimLocked(capacity));
  }

  acknowledgeDispatch(taskId: string, attemptId: string): Promise<void> {
    return withRunLock(this.runDir, () => this.acknowledgeDispatchLocked(taskId, attemptId));
  }

  reportDispatchFailure(taskId: string, attemptId: string): Promise<ReconcileResult> {
    return withRunLock(this.runDir, async () => {
      await this.failAttemptLocked(taskId, attemptId, 'dispatch_failure');
      return this.recomputeRunLocked();
    });
  }
}
```

Generate lease tokens with `randomBytes(32).toString('base64url')`, persist only `sha256(token)`, and return plaintext only in `ClaimResult`. Emit audit events for accepted/rejected claims, dispatch acknowledgement, dispatch failure, retry, and task failure without token content.

- [ ] **Step 4: Derive run counts from task records**

Implement `listTasksLocked()` and `recomputeRunLocked()` so no code increments cached counters. Terminal state is derived from the authoritative task set: all succeeded => `completed`; all terminal with any failed => `failed`; otherwise `active`.

- [ ] **Step 5: Run focused tests**

```bash
node --import tsx --test src/core/orchestrator/__tests__/claim.test.ts
npm run typecheck
```

Expected: PASS; concurrent claims have unique task IDs and no plaintext lease appears in persisted files or events.

- [ ] **Step 6: Commit claim and dispatch transitions**

```bash
git add src/core/orchestrator/orchestrator.ts src/core/orchestrator/__tests__/claim.test.ts
git commit -m $'feat(orchestrator): add claim and dispatch transitions\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
```

---

### Task 5: Reconcile Lease Expiry, Recovery, and Terminal Status

**Files:**
- Modify: `src/core/orchestrator/orchestrator.ts`
- Test: `src/core/orchestrator/__tests__/reconcile.test.ts`

**Interfaces:**
- Produces: `reconcile(): Promise<ReconcileResult>`, `status(): Promise<ReconcileResult>`.
- Consumes: Task 4 failure helper and task-derived counts.

- [ ] **Step 1: Write failing reconciliation tests**

Use an injected clock in `OrchestratorOptions` rather than sleeps. Cover leased and running expiry, retry, exhaustion, `nextLeaseDeadline`, completed/failed terminal transitions, and repeated reconciliation idempotency.

```ts
const clock = new FakeClock('2026-07-13T00:00:00.000Z');
const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });
const [claim] = await orchestrator.claim(1);
clock.advance(900_001);
const first = await orchestrator.reconcile();
const second = await orchestrator.reconcile();
assert.deepEqual(second.taskCounts, first.taskCounts);
```

- [ ] **Step 2: Run test and verify failure**

```bash
node --import tsx --test src/core/orchestrator/__tests__/reconcile.test.ts
```

Expected: FAIL because reconciliation/status options are absent.

- [ ] **Step 3: Add injected time and reconciliation**

```ts
export interface OrchestratorOptions {
  now?: () => Date;
}

reconcile(): Promise<ReconcileResult> {
  return withRunLock(this.runDir, async () => {
    for (const task of await this.listTasksLocked()) {
      if ((task.state === 'leased' || task.state === 'running') && task.currentAttemptId) {
        const attempt = await this.readAttempt(task.currentAttemptId);
        if (Date.parse(attempt.leaseDeadline) <= this.now().getTime()) {
          await this.failAttemptLocked(task.taskId, attempt.attemptId, 'lease_expired');
        }
      }
    }
    return this.recomputeRunLocked();
  });
}
```

`status()` acquires the lock and only validates/recomputes; it never expires a lease. `reconcile()` is the explicit expiry trigger used after batches and on resume.

- [ ] **Step 4: Reconcile on resume before start returns**

Update Task 3 start flow to construct `Orchestrator` on the effective run and call `reconcile()` after selecting a resumed run. Return its task counts and next deadline.

- [ ] **Step 5: Run focused and start tests**

```bash
node --import tsx --test src/core/orchestrator/__tests__/reconcile.test.ts src/cli/__tests__/orchestrator_start.test.ts
npm run typecheck
```

Expected: PASS with deterministic clock-based expiry.

- [ ] **Step 6: Commit reconciliation**

```bash
git add src/core/orchestrator/orchestrator.ts src/core/orchestrator/__tests__/reconcile.test.ts src/cli/orchestrator_start.ts src/cli/__tests__/orchestrator_start.test.ts
git commit -m $'feat(orchestrator): reconcile leases and terminal state\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
```

---

### Task 6: Stage Comments Under a Valid Current Lease

**Files:**
- Modify: `src/core/orchestrator/orchestrator.ts`
- Modify: `src/cli/code_comment.ts`
- Modify: `src/core/tools/code_comment.ts`
- Test: `src/cli/__tests__/code_comment_attempt.test.ts`

**Interfaces:**
- Produces: `stageComments(credentials, records): Promise<string[]>`.
- Consumes: existing `parseToolArgs`, `parseComments`, and comment ID behavior.
- Invariant: validate and append under one run lock; update `stagedCommentCount` in the same critical section.

- [ ] **Step 1: Write failing attempt-scoped comment tests**

Cover valid append, multiple calls preserving all comments, invalid token, stale attempt, expired lease, wrong run/file path, and legacy mode continuing to write `comments.jsonl` for old-schema runs.

```ts
test('two valid calls append comments and update the accepted attempt count', async () => {
  await invokeCodeComment(credentials, [comment('first')]);
  await invokeCodeComment(credentials, [comment('second')]);
  const lines = await readAttemptComments(credentials.attemptId);
  assert.equal(lines.length, 2);
  assert.equal((await readAttempt(credentials.attemptId)).stagedCommentCount, 2);
});
```

- [ ] **Step 2: Run test and verify failure**

```bash
node --import tsx --test src/cli/__tests__/code_comment_attempt.test.ts
```

Expected: FAIL because `code_comment` has no task/attempt/lease mode.

- [ ] **Step 3: Implement atomic lease validation plus append**

```ts
export interface AttemptCredentials {
  runId: string;
  taskId: string;
  attemptId: string;
  leaseToken: string;
  filePath: string;
  diffFingerprint: string;
}

stageComments(credentials: AttemptCredentials, records: CommentRecord[]): Promise<string[]> {
  return withRunLock(this.runDir, () => this.stageCommentsLocked(credentials, records));
}
```

Inside `stageCommentsLocked`, validate active run, current task/attempt, `running` state, path and fingerprint, SHA-256 token digest, and unexpired deadline. Append JSONL while holding the lock, then atomically update `AttemptRecord.stagedCommentCount`. If append succeeds but record update fails, recompute count from parseable lines on the next invocation before appending; do not silently discard malformed lines.

- [ ] **Step 4: Route structured and legacy CLI modes**

`code_comment --runId <id> --args '<json>'` selects orchestrator mode only when all six credential fields are present. Partial structured credentials are an error. If no `taskId` is present, preserve the existing `persistComments` path for legacy runs.

- [ ] **Step 5: Run focused tests**

```bash
node --import tsx --test src/cli/__tests__/code_comment_attempt.test.ts src/cli/__tests__/roundtrip.test.ts
npm run typecheck
```

Expected: PASS; legacy roundtrip remains green.

- [ ] **Step 6: Commit attempt-scoped comments**

```bash
git add src/core/orchestrator/orchestrator.ts src/cli/code_comment.ts src/core/tools/code_comment.ts src/cli/__tests__/code_comment_attempt.test.ts
git commit -m $'feat(review): stage comments under validated attempts\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
```

---

### Task 7: Accept Structured, Idempotent Completion

**Files:**
- Modify: `src/core/orchestrator/orchestrator.ts`
- Modify: `src/core/tools/task_done.ts`
- Modify: `src/cli/task_done.ts`
- Test: `src/core/orchestrator/__tests__/completion.test.ts`
- Test: `src/cli/__tests__/task_done_attempt.test.ts`

**Interfaces:**
- Produces: `acceptCompletion(submission): Promise<{ accepted: true; idempotent: boolean }>`.
- Consumes: attempt comment counts from Task 6.

- [ ] **Step 1: Write failing completion tests**

Cover `findings` with comments, `no_findings` without comments, mismatched outcome/count, 500-code-point summary limit, invalid/expired/stale credentials, identical duplicate completion, conflicting duplicate completion, late completion after retry, and exactly one accepted attempt per task.

```ts
test('identical completion is idempotent and conflicting completion is rejected', async () => {
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
```

- [ ] **Step 2: Run tests and verify failure**

```bash
node --import tsx --test src/core/orchestrator/__tests__/completion.test.ts src/cli/__tests__/task_done_attempt.test.ts
```

Expected: FAIL because structured completion is absent.

- [ ] **Step 3: Parse and canonicalize completion**

Add `parseStructuredCompletion(args, runId)` to `src/core/tools/task_done.ts`. Require every field, exact outcome enum, non-empty summary, and at most 500 Unicode code points. Compute completion digest from canonical payload excluding plaintext token but including its SHA-256 digest.

- [ ] **Step 4: Implement idempotency before active/current checks**

Under the run lock, read task and accepted attempt first. If the task already succeeded and the accepted attempt has the same completion digest, return idempotent success even though the run may now be completed. If a completion digest exists but differs, reject. Otherwise validate active/current/running credentials and outcome/comment-count consistency, write attempt success, then task success, and derive run terminal state from all tasks.

- [ ] **Step 5: Preserve explicit legacy completion mode**

`task_done` uses structured mode when `taskId` exists and rejects partial credentials. Old-schema calls without `taskId` keep `markDone`; schema-1 runs must not accept the legacy mode.

- [ ] **Step 6: Run focused tests**

```bash
node --import tsx --test src/core/orchestrator/__tests__/completion.test.ts src/cli/__tests__/task_done_attempt.test.ts src/cli/__tests__/roundtrip.test.ts
npm run typecheck
```

Expected: PASS for structured and legacy cases.

- [ ] **Step 7: Commit structured completion**

```bash
git add src/core/orchestrator/orchestrator.ts src/core/tools/task_done.ts src/cli/task_done.ts src/core/orchestrator/__tests__/completion.test.ts src/cli/__tests__/task_done_attempt.test.ts
git commit -m $'feat(review): accept lease-bound review completion\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
```

---

### Task 8: Expose Pull-Protocol CLIs and Package Them Cross-Platform

**Files:**
- Create: `src/cli/orchestrator_claim.ts`
- Create: `src/cli/orchestrator_ack.ts`
- Create: `src/cli/orchestrator_dispatch_fail.ts`
- Create: `src/cli/orchestrator_reconcile.ts`
- Create: `src/cli/orchestrator_status.ts`
- Modify: `scripts/shebang.mjs:20-42`
- Test: `src/cli/__tests__/orchestrator_protocol.test.ts`

**Interfaces:**
- Consumes: `resolveExistingRunDir` and Task 4–7 Orchestrator methods.
- Produces binaries: `ocr-orchestrator-start`, `ocr-orchestrator-claim`, `ocr-orchestrator-ack`, `ocr-orchestrator-dispatch-fail`, `ocr-orchestrator-reconcile`, `ocr-orchestrator-status`, plus matching `.cmd` wrappers.

- [ ] **Step 1: Write failing CLI protocol tests**

Invoke each TypeScript CLI with `node --import tsx`. Assert JSON-only stdout, stable error prefixes on stderr, exit 2 for malformed arguments, capacity validation, and worktree-aware run resolution.

```ts
test('claim emits credentials and status reports the same leased task', async () => {
  const claims = JSON.parse((await invoke('orchestrator_claim', ['--runId', runId, '--capacity', '1'])).stdout);
  assert.equal(claims.length, 1);
  const status = JSON.parse((await invoke('orchestrator_status', ['--runId', runId])).stdout);
  assert.equal(status.taskCounts.leased, 1);
});
```

- [ ] **Step 2: Run tests and verify missing CLI failure**

```bash
node --import tsx --test src/cli/__tests__/orchestrator_protocol.test.ts
```

Expected: FAIL because the CLI files do not exist.

- [ ] **Step 3: Add thin CLI wrappers with one shared argument helper**

Each wrapper resolves the existing run directory, constructs `Orchestrator`, performs exactly one operation, and prints its structured result. `orchestrator_dispatch_fail` reports explicit launch failure; `reconcile` handles silent crash/timeout recovery.

- [ ] **Step 4: Register friendly Unix names and Windows wrappers**

Add all six mappings to both `stemToBinName` and `binToMjsStem` in `scripts/shebang.mjs`. Friendly names must be identical on Unix and Windows; do not rely on the Unix fallback stem.

- [ ] **Step 5: Run tests and build packaging**

```bash
node --import tsx --test src/cli/__tests__/orchestrator_protocol.test.ts
npm run build
for name in start claim ack dispatch-fail reconcile status; do test -e "bin/ocr-orchestrator-$name"; test -e "bin/ocr-orchestrator-$name.cmd"; done
```

Expected: PASS and all twelve launcher paths exist.

- [ ] **Step 6: Commit protocol CLIs**

```bash
git add src/cli/orchestrator_*.ts src/cli/__tests__/orchestrator_protocol.test.ts scripts/shebang.mjs
git commit -m $'feat(cli): expose deterministic review protocol\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
```

---

### Task 9: Enforce Strict Aggregation and Accepted-Attempt Visibility

**Files:**
- Modify: `src/cli/aggregate.ts:39-196`
- Modify: `src/core/report/markdown.ts`
- Modify: `src/core/report/json.ts`
- Test: `src/cli/__tests__/aggregate_strict.test.ts`
- Test: existing aggregate filter/relocation suites

**Interfaces:**
- Consumes: orchestrator status, tasks, and `attempt-comments/<acceptedAttemptId>.jsonl`.
- Produces: exit `0` completed, exit `1` failed after writing partial reports, exit `2` active/superseded without writing a success report.

- [ ] **Step 1: Write failing strict aggregation tests**

Cover completed report, active rejection, failed partial report written before exit 1, failed paths/reasons/counts, only accepted-attempt comments visible, stale-attempt comments excluded, filters and relocation still applied, and old run aggregation using existing `done/*.json` behavior.

```ts
test('failed run writes diagnostics and exits one', async () => {
  const result = await invokeAggregate(runId, ['--strict', 'true', '--format', 'both']);
  assert.equal(result.exitCode, 1);
  assert.match(await readReport(runId, 'report.md'), /Failed files/);
  assert.equal(JSON.parse(await readReport(runId, 'report.json')).partial, true);
});
```

- [ ] **Step 2: Run aggregate suites and verify failure**

```bash
node --import tsx --test src/cli/__tests__/aggregate_strict.test.ts src/cli/__tests__/aggregate_filter.test.ts src/cli/__tests__/aggregate_relocation.test.ts
```

Expected: FAIL because `--strict` and accepted-attempt reads are absent.

- [ ] **Step 3: Split comment source from existing post-processing**

Add a helper that returns `{ rawComments, partialFiles, failedTasks, orchestrated }`. For schema-1 runs it reads only succeeded tasks' accepted attempt files. For old runs without schema-1 manifest/run records it calls the existing `readComments` and `listDone` path unchanged. Feed both paths through the existing filter and relocation code once.

- [ ] **Step 4: Add strict gate and diagnostic rendering**

Active/nonterminal and superseded runs exit 2 before rendering. Failed terminal runs render Markdown/JSON with expected/succeeded/failed counts, file paths, attempt counts, and stable failure reasons, write both requested reports, print the summary, then set `process.exitCode = 1`. Completed runs exit 0.

- [ ] **Step 5: Run aggregate suites and typecheck**

```bash
node --import tsx --test src/cli/__tests__/aggregate_strict.test.ts src/cli/__tests__/aggregate_filter.test.ts src/cli/__tests__/aggregate_relocation.test.ts
npm run typecheck
```

Expected: PASS; legacy, filter, and relocation behavior remains intact.

- [ ] **Step 6: Commit strict aggregation**

```bash
git add src/cli/aggregate.ts src/core/report/markdown.ts src/core/report/json.ts src/cli/__tests__/aggregate_strict.test.ts
git commit -m $'feat(review): require complete orchestrator state to aggregate\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
```

---

### Task 10: Convert Both Hosts to the Shared Mechanical Protocol

**Files:**
- Modify: `commands/review.md`
- Modify: `commands/review-opencode.md`
- Modify: `agents/ocr-reviewer.md`
- Modify: `agents/ocr-reviewer-opencode.md`
- Modify: `skills/ocr-review-file/SKILL.md`
- Test: `src/cli/__tests__/protocol_sync.test.ts`
- Test: `src/host/__tests__/contract.test.ts`

**Interfaces:**
- Consumes: all pull-protocol CLIs and structured reviewer credentials.
- Produces: identical marker-delimited protocol sections in both command files; Claude uses capacity N, OpenCode uses capacity 1 outside that shared section.

- [ ] **Step 1: Write failing protocol-sync and host-contract tests**

```ts
test('host command protocol sections are identical', async () => {
  const extract = (text: string) => {
    const match = text.match(/<!-- ORCHESTRATOR-PROTOCOL:START -->([\s\S]*?)<!-- ORCHESTRATOR-PROTOCOL:END -->/);
    assert.ok(match, 'missing orchestrator protocol markers');
    return match[1].trim();
  };
  assert.equal(extract(await read('commands/review.md')), extract(await read('commands/review-opencode.md')));
});
```

The host contract test uses programmatic drivers with capacities 3 and 1 against the same fixture and asserts identical logical terminal state. Also assert neither driver can complete unclaimed work, exceed two attempts, or aggregate while active.

- [ ] **Step 2: Run tests and verify marker failure**

```bash
node --import tsx --test src/cli/__tests__/protocol_sync.test.ts src/host/__tests__/contract.test.ts
```

Expected: FAIL because commands still own scheduling prose and lack markers.

- [ ] **Step 3: Replace scheduling prose with the shared protocol loop**

Both command files must state:

```text
prepare -> start candidate -> replace runId with effectiveRunId
loop: reconcile -> claim(capacity) -> per-file PLAN -> dispatch -> ack or dispatch-fail
when terminal: filter -> relocate -> aggregate --strict true
```

The shared marker section must specify that no file path may be invented by the host, empty claims with live leases wait until `nextLeaseDeadline`, every reviewer receives all credential fields, and a non-zero strict aggregate is the final command failure. Keep host-specific concurrency/cooldown outside the markers.

- [ ] **Step 4: Update reviewer and skill contracts**

Require `code_comment` arguments to include `taskId`, `attemptId`, `leaseToken`, `filePath`, and `diffFingerprint`. Require exactly one final `task_done` with `findings` when comments were staged or `no_findings` otherwise, plus a non-empty summary.

- [ ] **Step 5: Run sync, contract, and text tests**

```bash
node --import tsx --test src/cli/__tests__/protocol_sync.test.ts src/host/__tests__/contract.test.ts src/cli/__tests__/prepare.test.ts
```

Expected: PASS for both capacity models and exact protocol synchronization.

- [ ] **Step 6: Commit host adapters**

```bash
git add commands/review.md commands/review-opencode.md agents/ocr-reviewer.md agents/ocr-reviewer-opencode.md skills/ocr-review-file/SKILL.md src/cli/__tests__/protocol_sync.test.ts src/host/__tests__/contract.test.ts
git commit -m $'feat(host): drive reviews through orchestrator protocol\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
```

---

### Task 11: Add Recovery and End-to-End Completeness Scenarios

**Files:**
- Test: `src/core/orchestrator/__tests__/recovery.test.ts`
- Test: `src/cli/__tests__/orchestrator_e2e.test.ts`
- Modify only if tests expose defects: orchestrator/CLI files created above

**Interfaces:**
- Exercises the public protocol only; introduces no new product API.
- Proves all acceptance invariants from the approved design.

- [ ] **Step 1: Write recovery fault-injection tests**

Cover interruption after claim, after acknowledgement, after comment append, and after accepted completion. Verify succeeded files are not reclaimed, expired attempts retry once, late completions fail, failed-attempt comments never aggregate, identical resume keeps the effective run ID, and changed diff supersedes without reusing results.

- [ ] **Step 2: Write full CLI lifecycle tests**

The E2E driver initializes a real temporary git repository with multiple modified files, runs prepare/start/claim/ack, submits one findings result and one no-findings result, reconciles, filters/relocates where applicable, and runs strict aggregate. Add retry exhaustion and old-schema legacy aggregation cases.

```ts
test('N eligible files produce N succeeded tasks before strict success', async () => {
  const prepared = await cli.prepare(repo);
  const started = await cli.start(prepared.runId);
  const claims = await drainClaims(started.effectiveRunId, 3);
  assert.equal(claims.length, prepared.fileCount);
  await completeEveryClaim(claims);
  const aggregate = await cli.aggregateStrict(started.effectiveRunId);
  assert.equal(aggregate.exitCode, 0);
  assert.equal(aggregate.summary.filesReviewed, prepared.fileCount);
});
```

- [ ] **Step 3: Run new tests and observe any real failures**

```bash
node --import tsx --test src/core/orchestrator/__tests__/recovery.test.ts src/cli/__tests__/orchestrator_e2e.test.ts
```

Expected before fixes: any failure must identify a concrete invariant violation; do not weaken assertions.

- [ ] **Step 4: Apply minimal fixes for demonstrated invariant failures**

Keep fixes within the relevant orchestrator/CLI module. Add a regression assertion beside each fix. Do not expand scope into filters, relocation, prompts, or posting.

- [ ] **Step 5: Run the entire verification matrix**

```bash
npm test
npm run typecheck
npm run build
npm run smoke
```

Expected: all existing and new tests pass; typecheck, build, and smoke succeed.

- [ ] **Step 6: Verify worktree and user-change safety**

```bash
git status --short
git diff --name-only HEAD -- src/core/prompts/main_task.ts codespec/.aidesign-store.tmp.json codespec/changes/main
```

Expected: the pre-existing paths remain uncommitted and are absent from orchestration commits; no implementation step overwrote them.

- [ ] **Step 7: Commit recovery and E2E coverage**

```bash
git add src/core/orchestrator/__tests__/recovery.test.ts src/cli/__tests__/orchestrator_e2e.test.ts src/core/orchestrator src/cli/orchestrator_*.ts
git commit -m $'test(orchestrator): verify recovery and complete coverage\n\nCo-Authored-By: Claude <noreply@anthropic.com>'
```

## Final Verification and Review Gate

After all task commits:

```bash
npm test
npm run typecheck
npm run build
npm run smoke
git log --oneline -12
git status --short
```

Expected:

- All tests, typecheck, build, and smoke pass.
- Every eligible manifest file has one logical task and at most one accepted attempt.
- Completed strict aggregation exits 0; failed terminal aggregation writes partial diagnostics and exits 1; active/superseded aggregation exits 2.
- Claude Code and OpenCode protocol sections remain identical while capacities differ.
- Existing user modifications remain present and uncommitted, and no orchestration commit contains them.
- Before merging, invoke `superpowers:requesting-code-review`, then run the project `verify` skill to exercise the real review flow end-to-end.
