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
import type { RunRecord, TaskRecord, ReviewManifest, ManifestFile } from '../../core/orchestrator/types.js';
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

async function createSchema1Run(
  dir: string,
  runId: string,
  state: string,
  taskStates: Array<{ taskId: string; filePath: string; taskState: string; acceptedAttemptId?: string; failureReason?: string }>,
  attemptComments: Array<{ attemptId: string; records: CommentRecord[] }>,
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
// Tests
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
    ], []);
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
        assert.match(e.stderr ?? '', /failed/);
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

test('schema-1 completed run reports partial files for failed tasks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-partial-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
      { taskId: 'task-1', filePath: 'src/b.ts', taskState: 'failed', failureReason: 'retry_exhausted' },
    ], [
      {
        attemptId: 'attempt-1',
        records: [
          { comment_id: 'c-1', path: 'src/a.ts', start_line: 1, end_line: 1, content: 'Issue in a.ts' },
        ],
      },
    ]);
    process.chdir(oldCwd);

    const { stdout } = await runAggregate(dir, ['--runId', 'run1', '--format', 'both']);
    const summary = JSON.parse(stdout) as { partial: boolean; partialFiles: string[]; commentCount: number };

    assert.equal(summary.partial, true);
    assert.deepEqual(summary.partialFiles, ['src/b.ts']);
    assert.equal(summary.commentCount, 1);

    const reportJson = JSON.parse(await readFile(join(dir, '.ocr-runs/run1/report.json'), 'utf8'));
    assert.equal(reportJson.status, 'completed_with_warnings');
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('schema-1 completed run with no comments produces empty report', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-empty-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], [
      {
        attemptId: 'attempt-1',
        records: [],
      },
    ]);
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

test('schema-1 completed run fails closed on malformed attempt comments JSONL', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-malformed-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], []);

    // Write malformed JSONL directly
    const commentsDir = join(dir, '.ocr-runs/run1/attempt-comments');
    await mkdir(commentsDir, { recursive: true });
    await writeFile(join(commentsDir, 'attempt-1.jsonl'), 'not valid json\n');

    process.chdir(oldCwd);

    await assert.rejects(
      () => runAggregate(dir, ['--runId', 'run1', '--format', 'json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 1);
        assert.match(e.stderr ?? '', /malformed/i);
        return true;
      },
    );
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('schema-1 completed run with no attempt-comments dir returns empty', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-strict-no-comments-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await createSchema1Run(dir, 'run1', 'completed', [
      { taskId: 'task-0', filePath: 'src/a.ts', taskState: 'succeeded', acceptedAttemptId: 'attempt-1' },
    ], []);
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
