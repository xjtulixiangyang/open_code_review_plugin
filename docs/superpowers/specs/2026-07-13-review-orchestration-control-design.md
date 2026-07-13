# Deterministic Review Orchestration Control Design

> Date: 2026-07-13
> Status: Approved design
> Scope: Replace prompt-owned review scheduling with a shared TypeScript orchestration protocol for Claude Code and OpenCode.

## 1. Goal

Guarantee that every eligible diff file is reviewed exactly once by one accepted attempt before a review run can report success.

The current plugin already persists review context, comments, completion markers, plans, filters, relocations, and reports. It also describes batching, waiting, and retry behavior in `commands/review.md` and `commands/review-opencode.md`. However, the host agent still interprets and executes that control flow. A host can omit a file, stop before every task is terminal, or aggregate early. The existing aggregate step can diagnose a partial run, but the runtime does not make complete scheduling a hard invariant.

The target design moves file enumeration, task state, leasing, retries, recovery, and the completeness gate into a deterministic TypeScript orchestrator. Host commands remain responsible for launching reviewer agents because plugin CLIs cannot directly invoke host subagents, but hosts may only execute tasks claimed from the orchestrator.

## 2. Decisions

The design uses these approved choices:

- Use protocol-based strong control rather than directly calling an external model API.
- Support Claude Code and OpenCode in the first version through one shared orchestrator.
- Use a transactional pull protocol with lightweight append-only audit events.
- Treat any exhausted file task as a failure of the complete review command.
- Generate a partial diagnostic report on failure, but return a non-zero result.
- Automatically resume only an unfinished run whose repository, review parameters, and complete diff fingerprint match.
- Create a new run when the diff changes and mark the old unfinished run `superseded`.
- Require a structured, lease-bound completion credential. A valid `no_findings` result is successful review completion.

## 3. Architecture

The implementation separates the control plane from the execution plane.

### 3.1 Prepare and immutable manifest

`ocr-prepare` continues to create deterministic review context. It also creates a versioned immutable manifest containing:

- schema version;
- run ID;
- repository identity;
- normalized review arguments and their fingerprint;
- complete diff fingerprint;
- every eligible file in stable order;
- each file's normalized path, per-file diff fingerprint, and changed-line metadata;
- excluded files and exclusion reasons for reporting, but not as review tasks.

There must be exactly one logical task for every eligible manifest file. The manifest is never edited after creation. Mutable lifecycle data is stored separately.

### 3.2 Shared TypeScript orchestrator

The orchestrator is the only component allowed to mutate run, task, or attempt state. Its responsibilities are:

- find an automatically resumable run or create a new run;
- create one task per eligible manifest file;
- atomically claim queued work up to a requested capacity;
- issue attempts and lease credentials;
- acknowledge dispatch;
- validate completion submissions;
- expire leases and schedule bounded retries;
- calculate authoritative run status;
- permit complete aggregation or failed diagnostic aggregation;
- append audit events for every accepted state transition.

The authoritative state is materialized in versioned run and task records. `events.jsonl` is diagnostic and auditable, not an event-sourcing dependency that must be replayed to reconstruct state.

### 3.3 Host adapters

`commands/review.md` and `commands/review-opencode.md` become thin adapters around the same protocol:

```text
start/resume
while run is active:
  claim(capacity)
  dispatch exactly the returned tasks
  acknowledge dispatch
  reconcile completions and expired leases
read status
aggregate --strict
```

Claude Code requests up to `reviewConcurrency` claims and dispatches the returned agents concurrently. OpenCode requests capacity one and executes sequentially. Capacity and dispatch syntax are host concerns. File selection, retry budget, timeouts, and completion criteria are not.

A host stopping early cannot be prevented by an in-process plugin CLI, but it leaves an unfinished run. It cannot produce a successful aggregate result because the completeness gate is programmatic.

### 3.4 Single-file reviewer

A reviewer receives one claimed attempt and may review only its bound file and frozen diff. It retains existing per-file PLAN guidance and review tools. It submits comments against its attempt, then completes with either:

- `findings`: review completed and one or more candidate comments were submitted; or
- `no_findings`: review completed and no actionable issue was found.

The reviewer has no authority over global scheduling, retries, or aggregation.

### 3.5 Aggregate

Aggregate reads authoritative orchestrator state rather than inferring completeness from `done/*.json` names. It verifies that the manifest and current run state agree before rendering output.

- If any task is non-terminal, aggregation is rejected.
- If every task succeeded, it generates a complete report and exits successfully.
- If at least one task failed and all tasks are terminal, it generates a partial diagnostic report and exits non-zero.

## 4. Pull Protocol

The orchestrator exposes discrete CLI operations. Exact binary names may follow existing project conventions during planning, but the semantic operations are fixed.

### 4.1 Start or resume

`start/resume` computes repository identity, normalized argument fingerprint, and complete diff fingerprint. It then:

1. finds the latest compatible unfinished run;
2. resumes it if all identity values match;
3. otherwise marks an incompatible unfinished run `superseded` and creates a new run;
4. recovers expired leases before returning status.

Old-schema runs are not automatic-resume candidates.

### 4.2 Claim

`claim(capacity)` runs under the run lock. It selects at most `capacity` queued tasks in stable manifest order and creates one current attempt for each. Each claim returns:

- `runId`;
- `taskId`;
- `attemptId`;
- plaintext high-entropy `leaseToken`;
- lease deadline;
- file path;
- per-file diff fingerprint;
- immutable reviewer inputs needed by the host.

Persistent state stores only a cryptographic digest of the lease token. Claiming is atomic: a task cannot be leased to two hosts concurrently.

### 4.3 Dispatch acknowledgement

After successfully starting a reviewer, the host acknowledges dispatch and changes the attempt from `leased` to `running`. If launch fails, it reports dispatch failure. Reconciliation returns retryable tasks to `queued` when budget remains or marks them `failed` when it is exhausted.

The lease deadline covers both `leased` and `running`, preventing a host crash from leaving permanent in-progress work.

### 4.4 Comment submission

`code_comment` submissions include `runId`, `taskId`, `attemptId`, and `leaseToken`. Accepted comments are written to an attempt-scoped staging area. They are not visible to aggregate until that attempt successfully completes.

This prevents comments from expired, failed, superseded, or duplicated attempts from leaking into the final report.

### 4.5 Reconcile

`reconcile` runs under the run lock and is safe to call repeatedly. It:

1. accepts optional host-reported dispatch failures for current attempts;
2. expires every overdue `leased` or `running` attempt;
3. closes each failed or expired attempt with a stable reason code;
4. returns its task to `queued` when an attempt remains, or marks it `failed` when the attempt budget is exhausted;
5. recomputes counts and transitions the run to `completed` or `failed` when every task is terminal;
6. returns machine-readable state counts, whether more work can be claimed, the next lease deadline, and whether strict aggregation is allowed.

A dispatch failure is an explicit host signal; lease expiry is the fallback when the host crashes or cannot report it. Both consume an attempt because the orchestrator cannot prove that an unacknowledged reviewer did not start. The centralized default lease duration is 15 minutes and may be changed only through validated run configuration recorded in the argument fingerprint. There is no host-specific lease override. The host should reconcile after each dispatch batch and wait until the next lease deadline rather than busy-poll when no task is claimable.

### 4.6 Structured completion

`task_done` submits:

```ts
{
  runId: string;
  taskId: string;
  attemptId: string;
  leaseToken: string;
  filePath: string;
  diffFingerprint: string;
  outcome: "findings" | "no_findings";
  summary: string;
}
```

The orchestrator accepts completion only if:

- the run is active and matches the frozen snapshot;
- the task belongs to the run and the named file;
- the attempt is the task's current attempt;
- `SHA-256(submittedLeaseToken)` matches the stored digest and the lease has not expired;
- file path and per-file diff fingerprint match the manifest;
- `summary` is a non-empty human-readable per-file outcome summary of at most 500 Unicode code points;
- staged comments belong to this attempt;
- `findings` has at least one staged comment, while `no_findings` has none.

A first accepted completion atomically records that attempt as the task's accepted attempt and sets the task to `succeeded`. Aggregate reads comments only from the accepted attempt IDs referenced by succeeded tasks; no copy or append-based promotion step is required. Repeating the identical completion payload is idempotently successful. A conflicting submission or submission from an old attempt is rejected and cannot mutate state.

## 5. State Model

### 5.1 Task states

Each logical file task follows:

```text
queued -> leased -> running -> succeeded
              \          \
               \          +-> queued (retryable failure or lease expiry)
                +------------> queued (dispatch failure)

queued/leased/running -> failed only when the retry budget is exhausted
```

- `queued`: eligible for claim.
- `leased`: an attempt and lease exist, but dispatch is not acknowledged.
- `running`: the host reports that the reviewer was launched.
- `succeeded`: a valid `findings` or `no_findings` completion was accepted.
- `failed`: no attempt remains after an attempt failure or expiry.

`succeeded` and `failed` are terminal. Only `succeeded` contributes comments to the report.

Attempt count increments when a claim creates an attempt. The default policy preserves the current maximum of two total attempts per file, with the value centralized in validated run configuration rather than host prose.

### 5.2 Run states

- `active`: one or more tasks are non-terminal.
- `completed`: every task is `succeeded`.
- `failed`: every task is terminal and at least one task is `failed`.
- `superseded`: a changed snapshot or parameters caused a replacement run.

A run cannot transition from `completed`, `failed`, or `superseded` back to `active`.

## 6. Storage and Concurrency

A versioned layout extends the existing run directory:

```text
.ocr-runs/<runId>/
  context.json
  manifest.json
  run.json
  tasks/<safePathKey>.json
  attempts/<attemptId>.json
  attempt-comments/<attemptId>.jsonl
  events.jsonl
  plans/
  filters/
  relocations/
  report.md
  report.json
```

The initial schema uses integer major version `1`. Additive fields retain the major version; removed fields, changed meaning, or incompatible state semantics require a new major version. Only the current major version is automatically resumable.

`run.json` contains `schemaVersion`, run identity and state, `manifestDigest`, repository/argument/diff fingerprints, timestamps, terminal counts, and optional `supersededBy`. Each task record contains its IDs, path and diff fingerprint, task state, current and accepted attempt IDs, attempts used, maximum attempts, and terminal reason. Each attempt record points back to its run and task and contains attempt state, SHA-256 lease-token digest, lease deadline, timestamps, outcome, summary, staged-comment count, and failure reason. Cross-record references and cached counts are validated on every terminal decision.

Task filenames use the existing `safePathKey` helper, but that helper must be hardened before it becomes an authoritative key: output must contain only an ASCII safe alphabet, must not equal a Windows reserved device name, and must stay within a fixed component-length limit. If percent encoding would exceed the limit, use a readable prefix plus a SHA-256 path digest. The manifest path remains the source of truth; filenames are never decoded as authority.

Mutating operations use a run-level lock implemented as an atomic `mkdir` of `.orchestrator.lock`, followed by an owner record containing a random owner ID, process ID, creation time, and expiry. A contender may rename an expired lock directory to a unique tombstone and retry acquisition; only the contender that successfully renames it may remove that tombstone. Lock expiry must be longer than the maximum expected state mutation and is independent from reviewer leases. Mutations renew the owner record when needed and verify owner ID before release.

State writes use one cross-platform helper: serialize to a uniquely named temporary file in the destination directory, open with exclusive creation, write and sync the file, then replace the destination. Because overwrite rename differs on Windows, the implementation plan must select and test a Node 18-compatible atomic-write library or implement a platform-specific replace sequence under the run lock. `EXDEV` fallback is forbidden because temporary files are always in the destination directory. A failed replacement leaves the previous valid file authoritative and fails closed. Directory sync is best-effort where the platform supports it.

Audit events are append-only JSON lines with envelope `{ schemaVersion: 1, eventId, type, ts, runId, taskId?, attemptId?, reason?, data? }`. Event IDs are unique within a run. Event payloads must not contain plaintext lease tokens. Events include run creation/resumption/supersession, task claim, dispatch acknowledgement/failure, lease expiry, retry scheduling, completion acceptance/rejection, task failure, and run terminal transition. Rotation is out of scope for this version. Corrupt or inconsistent authoritative state must fail closed: it may block a run and produce a diagnostic, but it must never be interpreted as complete.

## 7. Recovery and Snapshot Consistency

Automatic recovery is conservative:

- completed tasks remain completed;
- queued tasks remain claimable;
- unexpired leases remain owned and are not duplicated;
- expired `leased` or `running` attempts are closed and either retried or failed;
- promoted comments from completed attempts remain stable;
- staged comments from unsuccessful attempts remain excluded.

A run is resumable only when repository identity, normalized review arguments, and complete diff fingerprint are identical. Any diff change creates a new run and marks the prior unfinished run `superseded`. The plugin does not reuse unchanged-file results across snapshots in this version, because one report must represent one coherent code snapshot.

## 8. Strict Completeness and Failure Semantics

The programmatic invariants are:

1. N eligible manifest files produce exactly N logical tasks.
2. Every successful task has exactly one accepted attempt.
3. An unclaimed task cannot complete.
4. An invalid, expired, mismatched, or superseded credential cannot mutate state.
5. At most one attempt per task contributes comments.
6. A successful aggregate requires N succeeded tasks.
7. Any exhausted task makes the run and command fail.

A failed run still renders a diagnostic report containing:

- expected, succeeded, and failed counts;
- failed file paths;
- attempt counts and stable failure reason codes;
- warnings for recovered expirations or rejected stale submissions;
- valid comments from successfully reviewed files, clearly labeled as partial coverage.

The aggregate command returns non-zero for failed or non-terminal runs. Partial output is evidence for diagnosis, never evidence of successful completion.

## 9. Compatibility and Migration

Existing `context.json`, reports, plans, filters, relocations, and public tool behavior remain where compatible.

- Old runs without the new schema remain readable by legacy-compatible report logic but are not resumed by the orchestrator.
- `done/*.json` stops being authoritative. During migration it may be emitted as derived compatibility output for existing hooks or diagnostics.
- New completion records are authoritative and are created only after credential validation.
- Existing per-file PLAN behavior remains part of reviewer execution. A PLAN failure continues according to its existing review policy and is recorded as a warning; it does not bypass task completion requirements.
- Review and OpenCode command documentation share one protocol definition or generated fragment. Host-specific documents contain only capacity, dispatch, and waiting syntax to reduce semantic drift.
- Existing `resumeRunId` behavior is migrated to the fingerprint-based automatic resume path. Explicit run selection may remain a diagnostic escape hatch but cannot bypass compatibility validation.

## 10. Error Handling

Stable errors distinguish protocol and review failures, including:

- manifest/context mismatch;
- no compatible run or invalid explicit resume target;
- lock acquisition or state corruption;
- invalid task or attempt;
- invalid, expired, or mismatched lease;
- dispatch failure;
- lease expiry;
- retry exhaustion;
- aggregation requested before terminal state;
- strict aggregation of a failed run.

Recoverable attempt errors flow through reconciliation and consume retry budget. Storage corruption, manifest inconsistency, and snapshot mismatch fail closed rather than consuming arbitrary file retries.

Hosts must surface CLI errors verbatim enough to retain the stable code and failed file identity. They must not reinterpret a non-zero strict aggregate as success.

## 11. Testing Strategy

### 11.1 State-machine unit tests

Cover every legal transition and reject every illegal shortcut, including:

- claim, dispatch acknowledgement, completion, and terminal transitions;
- dispatch failure and lease expiry with and without retry budget;
- `findings` and `no_findings` success;
- invalid task, attempt, file, fingerprint, and lease;
- stale completion after retry;
- identical completion idempotency and conflicting completion rejection.

### 11.2 Storage and fault-injection tests

Cover:

- atomic claim under concurrent processes;
- run-lock contention and expired-lock recovery;
- process interruption after claim, dispatch, staged comment, completion promotion, and terminal transition;
- truncated or inconsistent state files failing closed;
- no promotion of comments from expired attempts;
- cross-platform path keys and atomic replacement behavior.

### 11.3 Host contract tests

Run the same fixture through a capacity-N driver and a capacity-one driver. Both must produce identical logical task and report outcomes. Verify that a host cannot:

- claim a file outside the manifest;
- complete a task without a claim;
- skip active work and successfully aggregate;
- exceed orchestrator retry policy;
- aggregate stale results after a diff change.

### 11.4 End-to-end scenarios

All tests in Sections 11.1–11.4 are required in the same implementation plan because they verify the completeness guarantee rather than optional polish. The plan may stage implementation into independently passing milestones, but the feature is not complete until the full matrix passes.

Cover:

- multiple files all succeeding;
- successful `no_findings` files;
- timeout followed by successful retry;
- retry exhaustion producing a partial report and non-zero exit;
- interruption and automatic resume without re-reviewing succeeded files;
- changed diff creating a new run and superseding the old run;
- rejected late completion from an expired attempt;
- duplicate comments from unsuccessful attempts excluded;
- Claude Code parallel and OpenCode sequential adapters reaching equivalent results;
- old-schema runs remaining readable but not resumable.

## 12. Observability

Status output must be machine-readable and human-readable. At minimum it reports:

- run ID and snapshot fingerprint prefix;
- run state;
- counts by task state;
- current attempts and lease deadlines;
- retries consumed;
- whether aggregation is allowed;
- failed files and stable reason codes.

This is local orchestration observability. Full LLM request/response persistence, OpenTelemetry, and Go-style memory compression are not required for this design.

## 13. Non-Goals

- Calling Anthropic APIs or the Agent SDK directly from the orchestrator.
- Replacing host-native subagents with a standalone model runtime.
- Reusing successful file results across changed diff snapshots.
- Full event sourcing or reconstructing state exclusively from `events.jsonl`.
- Proving semantic review quality beyond requiring a valid explicit result for every file.
- Go-style memory compression, token telemetry, or asynchronous comment worker pools.
- Unrelated changes to filtering, relocation, posting, or custom rule semantics.

## 14. Acceptance Criteria

- Every eligible diff file deterministically creates one logical task.
- Claude Code and OpenCode use the same orchestrator and state schema.
- The host can request capacity but cannot choose arbitrary files or retry policy.
- Claims and completions are lease-bound, atomic, validated, and idempotent.
- `no_findings` is a valid explicit successful outcome.
- Interrupted runs automatically resume only against an identical snapshot and arguments.
- Changed diffs create a new run; old unfinished runs become `superseded`.
- Comments from failed or stale attempts never enter aggregate output.
- Aggregate refuses active runs.
- Any exhausted file task generates a partial diagnostic report and a non-zero command result.
- Complete success is possible only when every manifest task is `succeeded`.
- State-machine, fault-injection, host-contract, and end-to-end tests cover the listed invariants.
- `npm test`, `npm run typecheck`, and `npm run build` pass after implementation.
