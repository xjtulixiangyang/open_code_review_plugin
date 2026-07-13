import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeContext, appendComment, writeFilterResult, writeRelocationResult } from '../../core/runs/store.js';
import type { ReviewContext } from '../../core/model/request.js';
import type { CommentRecord } from '../../core/model/comment.js';
import type { RunRecord, TaskRecord, AttemptRecord, ReviewManifest, ManifestFile } from '../../core/orchestrator/types.js';
import { ORCHESTRATOR_SCHEMA_VERSION } from '../../core/orchestrator/types.js';
import { sha256, manifestDigest } from '../../core/orchestrator/fingerprint.js';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX_LOADER = join(ROOT, 'node_modules/tsx/dist/loader.mjs');

async function runAggregate(cwd: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX_LOADER, join(ROOT, 'src/cli/aggregate.ts'), ...args], { cwd });
}

const CTX: ReviewContext = {
  runId: 'strict-run',
  repoRoot: '/repo',
  range: 'workspace',
  background: '',
  files: [
    { path: 'src/a.ts', status: 'modified', diff: '', truncated: false, hunks: [], rulesHit: [] },
    { path: 'src/b.ts', status: 'modified', diff: '', truncated: false, hunks: [], rulesHit: [] },
  ],
  changeFiles: ['src/a.ts', 'src/b.ts'],
  meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TaskDef {
  taskId: string;
  filePath: string;
  taskState: string;
  acceptedAttemptId?: string;
  failureReason?: string;
}

interface AttemptDef {
  attemptId: string;
  state: string;
  outcome: string;
  stagedCommentCount: number;
}

interface AttemptCommentsDef {
  attemptId: string;
  records: CommentRecord[];
}

async function createSchema1Run(
  dir: string,
  runId: string,
  state: string,
  taskStates: TaskDef[],
  attemptDefs: AttemptDef[],
  attemptComments: AttemptCommentsDef[],
): Promise<void> {
  const ocrDir = join(dir, '.ocr-runs', runId);
  await mkdir(ocrDir, { recursive: true });

  // Write context
  await writeFile(join(ocrDir, 'context.json'), JSON.stringify({ ...CTX, runId }) + '\n');

  // Write manifest
  const files: ManifestFile[] = taskStates.map((t, i) => ({
    manifestIndex: i,
    path: t.filePath,
    diffFingerprint: sha256(`diff-${i}`),
    changedLines: 1,
    status: 'modified',
  }));
  const manifest: ReviewManifest = {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    runId,
    repoIdentity: 'test-repo',
    argsFingerprint: sha256('test-args'),
    diffFingerprint: sha256('test-diff'),
    files,
    excludedFiles: [],
    createdAt: new Date().toISOString(),
  };
  await writeFile(join(ocrDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // Write run record
  const runRecord: RunRecord = {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    runId,
    state: state as RunRecord['state'],
    manifestDigest: manifestDigest(manifest),
    repoIdentity: 'test-repo',
    argsFingerprint: sha256('test-args'),
    diffFingerprint: sha256('test-diff'),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(join(ocrDir, 'run.json'), JSON.stringify(runRecord, null, 2) + '\n');

  // Write tasks
  const tasksDir = join(ocrDir, 'tasks');
  await mkdir(tasksDir, { recursive: true });
  for (let i = 0; i < taskStates.length; i++) {
    const t = taskStates[i];
    const task: TaskRecord = {
      runId,
      taskId: t.taskId,
      manifestIndex: i,
      filePath: t.filePath,
      diffFingerprint: sha256(`diff-${i}`),
      state: t.taskState as TaskRecord['state'],
      attemptsUsed: 1,
      maxAttempts: 2,
      acceptedAttemptId: t.acceptedAttemptId,
      failureReason: t.failureReason as TaskRecord['failureReason'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeFile(join(tasksDir, `${t.taskId}.json`), JSON.stringify(task, null, 2) + '\n');
  }

  // Write attempt records
  for (const ad of attemptDefs) {
    const attempt: AttemptRecord = {
      runId,
      taskId: taskStates.find((t) => t.acceptedAttemptId === ad.attemptId)?.taskId ?? 'task-0',
      attemptId: ad.attemptId,
      state: ad.state as AttemptRecord['state'],
      leaseTokenDigest: sha256('test-token'),
      leaseDeadline: new Date(Date.now() + 900_000).toISOString(),
      stagedCommentCount: ad.stagedCommentCount,
      outcome: ad.outcome as AttemptRecord['outcome'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await writeFile(join(tasksDir, `${attempt.taskId}.${ad.attemptId}.json`), JSON.stringify(attempt, null, 2) + '\n');
  }

  // Write attempt comments
  if (attemptComments.length > 0) {
    const commentsDir = join(ocrDir, 'attempt-comments');
    await mkdir(commentsDir, { recursive: true });
    for (const ac of attemptComments) {
      const lines = ac.records.map((r) => JSON.stringify(r)).join('\n');
      await writeFile(join(commentsDir, `${ac.attemptId}.jsonl`), lines + '\n');
    }
  }
}

// ---------------------------------------------------------------------------
// Happy path tests
// ---------------------------------------------------------------------------

test('schema-1 completed run exits 0 and produces report with accepted comments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-completed-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
      { taskId: 'task-1', filePath: 'src/b.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-2' },
    ], [
      { attemptId: 'attempt-1', state: 'succeeded', outcome: 'findings', stagedCommentCount: 1 },
      { attemptId: 'attempt-2', state: 'succeeded', outcome: 'findings', stagedCommentCount: 1 },
    ], [
      {
        attemptId: 'attempt-1',
        records: [
          { comment_id: 'c-1', path: 'src/a.ts', start_line: 1, end_line: 1, content: 'Issue in a.ts' },
        ],
      },
      {
        attemptId: 'attempt-2',
        records: [
          { comment_id: 'c-2', path: 'src/b.ts', start_line: 5, end_line: 5, content: 'Issue in b.ts' },
        ],
      },
    ]);
    process.chdir(oldCwd);

    const { stdout } = await runAggregate(dir, ['--runId', 'run1', '--format', 'both']);
    const summary = JSON.parse(stdout) as { rawCommentCount: number; commentCount: number; partial: boolean; partialFiles: string[] };

    assert.equal(summary.rawCommentCount, 2);
    assert.equal(summary.commentCount, 2);
    assert.equal(summary.partial, false);
    assert.deepEqual(summary.partialFiles, []);

    const reportMd = await readFile(join(dir, '.ocr-runs/run1/report.md'), 'utf8');
    assert.match(reportMd, /Issue in a\.ts/);
    assert.match(reportMd, /Issue in b\.ts/);

    const reportJson = JSON.parse(await readFile(join(dir, '.ocr-runs/run1/report.json'), 'utf8'));
    assert.equal(reportJson.status, 'success');
    assert.equal(reportJson.summary.comments, 2);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('schema-1 active run exits 2 with stderr message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-active-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'active', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'running' },
    ], [], []);
    process.chdir(oldCwd);

    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /is active/);
        return true;
      },
    );
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('schema-1 superseded run exits 2 with stderr message', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-superseded-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'superseded', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], [
      { attemptId: 'attempt-1', state: 'succeeded', outcome: 'no_findings', stagedCommentCount: 0 },
    ], []);
    process.chdir(oldCwd);

    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /superseded/);
        return true;
      },
    );
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('schema-1 failed run exits 1 and writes diagnostic report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-failed-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'failed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'failed', failureReason: 'retry_exhausted' },
      { taskId: 'task-1', filePath: 'src/b.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-2' },
    ], [
      { attemptId: 'attempt-2', state: 'succeeded', outcome: 'findings', stagedCommentCount: 1 },
    ], [
      {
        attemptId: 'attempt-2',
        records: [
          { comment_id: 'c-2', path: 'src/b.ts', start_line: 5, end_line: 5, content: 'Issue in b.ts' },
        ],
      },
    ]);
    process.chdir(oldCwd);

    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 1);
        assert.match(e.stdout ?? '', /failed/);
        return true;
      },
    );

    // Diagnostic report should be written
    const reportJson = JSON.parse(await readFile(join(dir, '.ocr-runs/run1/report.json'), 'utf8'));
    assert.equal(reportJson.status, 'completed_with_errors');
    assert.equal(reportJson.state, 'failed');
    assert.ok(reportJson.taskCounts);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('old-schema legacy path unchanged (no run.json)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-legacy-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run1', CTX);
    await appendComment('run1', {
      comment_id: 'c-legacy',
      path: 'src/a.ts',
      start_line: 1,
      end_line: 1,
      content: 'Legacy comment',
    });
    process.chdir(oldCwd);

    const { stdout } = await runAggregate(dir, ['--runId', 'run1', '--format', 'both']);
    const summary = JSON.parse(stdout) as { rawCommentCount: number; commentCount: number; partial: boolean };

    assert.equal(summary.rawCommentCount, 1);
    assert.equal(summary.commentCount, 1);
    assert.equal(summary.partial, true); // No done markers

    const reportMd = await readFile(join(dir, '.ocr-runs/run1/report.md'), 'utf8');
    assert.match(reportMd, /Legacy comment/);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('schema-1 completed run applies filters and relocations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-filter-reloc-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], [
      { attemptId: 'attempt-1', state: 'succeeded', outcome: 'findings', stagedCommentCount: 2 },
    ], [
      {
        attemptId: 'attempt-1',
        records: [
          { comment_id: 'c-keep', path: 'src/a.ts', start_line: 1, end_line: 1, content: 'Keep this' },
          { comment_id: 'c-hide', path: 'src/a.ts', start_line: 2, end_line: 2, content: 'Hide this' },
        ],
      },
    ]);

    // Write filter result
    await writeFilterResult('run1', {
      path: 'src/a.ts',
      decisions: [{ comment_id: 'c-hide', action: 'hide', reason: 'duplicate' }],
      _meta: { source: 'review_filter_task', subagent: 'filter-a', ts: 'now' },
    });

    // Write relocation result
    await writeRelocationResult('run1', {
      path: 'src/a.ts',
      decisions: [{
        comment_id: 'c-keep',
        original_start_line: 1,
        original_end_line: 1,
        resolved_start_line: 10,
        resolved_end_line: 10,
        source: 'existing_code_diff',
        reason: 'matched',
      }],
      _meta: { source: 'line_resolver', ts: 'now' },
    });

    process.chdir(oldCwd);

    const { stdout } = await runAggregate(dir, ['--runId', 'run1', '--format', 'both']);
    const summary = JSON.parse(stdout) as { rawCommentCount: number; commentCount: number; filteredCommentCount: number };

    assert.equal(summary.rawCommentCount, 2);
    assert.equal(summary.commentCount, 1);
    assert.equal(summary.filteredCommentCount, 1);

    const reportJson = JSON.parse(await readFile(join(dir, '.ocr-runs/run1/report.json'), 'utf8'));
    assert.equal(reportJson.summary.comments, 1);
    assert.equal(reportJson.summary.raw_comments, 2);
    assert.equal(reportJson.summary.filtered_comments, 1);
    assert.equal(reportJson.comments[0].comment_id, 'c-keep');
    // Relocation applied
    assert.equal(reportJson.comments[0].start_line, 10);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});


test('schema-1 completed run with no_findings produces empty report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-nofindings-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], [
      { attemptId: 'attempt-1', state: 'succeeded', outcome: 'no_findings', stagedCommentCount: 0 },
    ], []);
    process.chdir(oldCwd);

    const { stdout } = await runAggregate(dir, ['--runId', 'run1', '--format', 'both']);
    const summary = JSON.parse(stdout) as { rawCommentCount: number; commentCount: number; partial: boolean };

    assert.equal(summary.rawCommentCount, 0);
    assert.equal(summary.commentCount, 0);
    assert.equal(summary.partial, false);

    const reportMd = await readFile(join(dir, '.ocr-runs/run1/report.md'), 'utf8');
    assert.match(reportMd, /no issues found/);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Regression tests: corrupt / invalid data
// ---------------------------------------------------------------------------

test('succeeded task missing acceptedAttemptId fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-no-attemptid-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded' }, // no acceptedAttemptId
    ], [], []);
    process.chdir(oldCwd);

    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 1);
        assert.match(e.stderr ?? '', /acceptedAttemptId is missing/i);
        return true;
      },
    );
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('succeeded task with missing attempt record fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-missing-attempt-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], [], []); // no attempt records written
    process.chdir(oldCwd);

    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 1);
        assert.match(e.stderr ?? '', /attempt.*not found/i);
        return true;
      },
    );
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('attempt record with wrong state fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-wrong-state-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], [
      { attemptId: 'attempt-1', state: 'running', outcome: 'findings', stagedCommentCount: 1 }, // not succeeded
    ], [
      {
        attemptId: 'attempt-1',
        records: [
          { comment_id: 'c-1', path: 'src/a.ts', start_line: 1, end_line: 1, content: 'Issue' },
        ],
      },
    ]);
    process.chdir(oldCwd);

    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 1);
        assert.match(e.stderr ?? '', /expected state succeeded/i);
        return true;
      },
    );
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('attempt record missing outcome fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-no-outcome-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], [
      { attemptId: 'attempt-1', state: 'succeeded', outcome: '', stagedCommentCount: 1 },
    ], [
      {
        attemptId: 'attempt-1',
        records: [
          { comment_id: 'c-1', path: 'src/a.ts', start_line: 1, end_line: 1, content: 'Issue' },
        ],
      },
    ]);
    process.chdir(oldCwd);

    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 1);
        assert.match(e.stderr ?? '', /outcome is missing/i);
        return true;
      },
    );
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('findings outcome with zero comments fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-findings-zero-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], [
      { attemptId: 'attempt-1', state: 'succeeded', outcome: 'findings', stagedCommentCount: 0 },
    ], []); // no comments file
    process.chdir(oldCwd);

    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 1);
        assert.match(e.stderr ?? '', /Missing attempt-comments/i);
        return true;
      },
    );
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('comment count mismatch fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-count-mismatch-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], [
      { attemptId: 'attempt-1', state: 'succeeded', outcome: 'findings', stagedCommentCount: 2 }, // says 2 but only 1 in file
    ], [
      {
        attemptId: 'attempt-1',
        records: [
          { comment_id: 'c-1', path: 'src/a.ts', start_line: 1, end_line: 1, content: 'Issue' },
        ],
      },
    ]);
    process.chdir(oldCwd);

    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 1);
        assert.match(e.stderr ?? '', /count mismatch/i);
        return true;
      },
    );
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('comment path mismatch fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-path-mismatch-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], [
      { attemptId: 'attempt-1', state: 'succeeded', outcome: 'findings', stagedCommentCount: 1 },
    ], [
      {
        attemptId: 'attempt-1',
        records: [
          { comment_id: 'c-1', path: 'src/wrong.ts', start_line: 1, end_line: 1, content: 'Issue' }, // path doesn't match task
        ],
      },
    ]);
    process.chdir(oldCwd);

    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 1);
        assert.match(e.stderr ?? '', /path mismatch/i);
        return true;
      },
    );
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('no_findings with zero comments and missing file succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-nofindings-ok-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], [
      { attemptId: 'attempt-1', state: 'succeeded', outcome: 'no_findings', stagedCommentCount: 0 },
    ], []); // no attempt-comments dir at all
    process.chdir(oldCwd);

    const { stdout } = await runAggregate(dir, ['--runId', 'run1', '--format', 'json']);
    const summary = JSON.parse(stdout) as { rawCommentCount: number; commentCount: number };
    assert.equal(summary.rawCommentCount, 0);
    assert.equal(summary.commentCount, 0);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('no_findings with non-zero stagedCommentCount fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-nofindings-nonzero-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], [
      { attemptId: 'attempt-1', state: 'succeeded', outcome: 'no_findings', stagedCommentCount: 1 }, // says 0 but has 1
    ], [
      {
        attemptId: 'attempt-1',
        records: [
          { comment_id: 'c-1', path: 'src/a.ts', start_line: 1, end_line: 1, content: 'Issue' },
        ],
      },
    ]);
    process.chdir(oldCwd);

    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 1);
        assert.match(e.stderr ?? '', /requires 0 comments/i);
        return true;
      },
    );
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('malformed run.json fails closed instead of using legacy aggregation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-bad-run-'));
  try {
    await mkdir(join(dir, '.ocr-runs/run1'), { recursive: true });
    await writeFile(join(dir, '.ocr-runs/run1/context.json'), JSON.stringify({ ...CTX, runId: 'run1' }));
    await writeFile(join(dir, '.ocr-runs/run1/run.json'), '{broken');
    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /run\.json|schema-1/i);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('completed run with a failed task fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-inconsistent-'));
  try {
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'failed', failureReason: 'retry_exhausted' },
      { taskId: 'task-1', filePath: 'src/b.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-2' },
    ], [
      { attemptId: 'attempt-2', state: 'succeeded', outcome: 'no_findings', stagedCommentCount: 0 },
    ], []);
    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.notEqual(e.code, 0);
        assert.match(e.stderr ?? '', /completed|task/i);
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('failed JSON report lists file, attempts, and reason without writing markdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-failed-detail-'));
  try {
    await createSchema1Run(dir, 'run1', 'failed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'failed', failureReason: 'retry_exhausted' },
      { taskId: 'task-1', filePath: 'src/b.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-2' },
    ], [
      { attemptId: 'attempt-2', state: 'succeeded', outcome: 'no_findings', stagedCommentCount: 0 },
    ], []);
    let stdout = '';
    await assert.rejects(
      async () => {
        try {
          await runAggregate(dir, ['--runId', 'run1', '--format', 'json']);
        } catch (error) {
          stdout = (error as { stdout?: string }).stdout ?? '';
          throw error;
        }
      },
      (err: unknown) => (err as { code?: number }).code === 1,
    );
    const report = JSON.parse(await readFile(join(dir, '.ocr-runs/run1/report.json'), 'utf8'));
    assert.equal(report.partial, true);
    assert.deepEqual(report.failedFiles, [{
      path: 'src/a.ts', attemptsUsed: 1, maxAttempts: 2, reason: 'retry_exhausted',
    }]);
    assert.equal(report.expected, 2);
    assert.equal(report.succeeded, 1);
    assert.equal(report.failed, 1);
    assert.equal(JSON.parse(stdout).partial, true);
    await assert.rejects(() => readFile(join(dir, '.ocr-runs/run1/report.md'), 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('malformed task JSON fails closed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-bad-task-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], [
      { attemptId: 'attempt-1', state: 'succeeded', outcome: 'no_findings', stagedCommentCount: 0 },
    ], []);

    // Corrupt the task file
    const tasksDir = join(dir, '.ocr-runs/run1/tasks');
    await writeFile(join(tasksDir, 'task-0.json'), '{not valid json\n');

    process.chdir(oldCwd);

    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 1);
        return true;
      },
    );
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
