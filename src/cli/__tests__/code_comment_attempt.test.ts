import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { Orchestrator } from '../../core/orchestrator/orchestrator.js';
import type { RunRecord, TaskRecord, AttemptRecord, ReviewManifest, ManifestFile } from '../../core/orchestrator/types.js';
import { ORCHESTRATOR_SCHEMA_VERSION } from '../../core/orchestrator/types.js';
import { sha256, manifestDigest } from '../../core/orchestrator/fingerprint.js';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX_LOADER = join(ROOT, 'node_modules/tsx/dist/loader.mjs');

async function runCli(cwd: string, file: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX_LOADER, join(ROOT, 'src/cli', file), ...args], { cwd });
}

interface TestRun {
  dir: string;
  runId: string;
  taskId: string;
  attemptId: string;
  leaseToken: string;
  filePath: string;
  diffFingerprint: string;
}

/**
 * Create an orchestrator run directory inside `.ocr-runs/<runId>/` so that
 * resolveExistingRunDir can find it via the CLI.
 */
async function createTestRun(): Promise<TestRun> {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-code-comment-attempt-'));
  const runId = `test-run-${randomUUID().slice(0, 8)}`;
  const taskId = 'task-0';
  const createdAt = new Date().toISOString();
  const filePath = 'src/foo.ts';
  const diffFp = sha256('test-diff');

  // Create the orchestrator run dir inside .ocr-runs/<runId>/
  const ocrRunDir = join(dir, '.ocr-runs', runId);
  await mkdir(ocrRunDir, { recursive: true });

  // Write context.json so resolveExistingRunDir finds it
  await writeFile(join(ocrRunDir, 'context.json'), JSON.stringify({ runId }) + '\n');

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
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    runId,
    state: 'active',
    manifestDigest: manifestDigest(manifest),
    repoIdentity: 'test-repo',
    argsFingerprint: sha256('test-args'),
    diffFingerprint: diffFp,
    createdAt,
    updatedAt: createdAt,
  };

  await writeFile(join(ocrRunDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(ocrRunDir, 'run.json'), JSON.stringify(runRecord, null, 2) + '\n');

  const tasksDir = join(ocrRunDir, 'tasks');
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

  const orchestrator = new Orchestrator(ocrRunDir);
  const claimResults = await orchestrator.claim(1);
  const claim = claimResults[0];
  await orchestrator.acknowledgeDispatch(claim.taskId, claim.attemptId);

  return {
    dir,
    runId,
    taskId: claim.taskId,
    attemptId: claim.attemptId,
    leaseToken: claim.leaseToken,
    filePath: claim.filePath,
    diffFingerprint: claim.diffFingerprint,
  };
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

function makeCommentArgs(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    path: 'src/foo.ts',
    subagent: 'reviewer-0',
    comments: [{ start_line: 1, end_line: 1, content: 'test comment' }],
    ...overrides,
  };
}

describe('code_comment CLI attempt-scoped mode', () => {
  it('appends multiple comments and returns matching IDs', async () => {
    const tr = await createTestRun();
    try {
      const oldCwd = process.cwd();
      process.chdir(tr.dir);
      try {
        const r1 = await runCli(tr.dir, 'code_comment.ts', [
          '--runId', tr.runId,
          '--args', JSON.stringify({
            ...makeCommentArgs(),
            taskId: tr.taskId,
            attemptId: tr.attemptId,
            leaseToken: tr.leaseToken,
            filePath: tr.filePath,
            diffFingerprint: tr.diffFingerprint,
            comments: [{ start_line: 1, end_line: 1, content: 'first' }],
          }),
        ]);
        const j1 = JSON.parse(r1.stdout);
        assert.equal(j1.ok, true);
        assert.equal(j1.count, 1);
        assert.equal(j1.comment_ids.length, 1);

        const r2 = await runCli(tr.dir, 'code_comment.ts', [
          '--runId', tr.runId,
          '--args', JSON.stringify({
            ...makeCommentArgs(),
            taskId: tr.taskId,
            attemptId: tr.attemptId,
            leaseToken: tr.leaseToken,
            filePath: tr.filePath,
            diffFingerprint: tr.diffFingerprint,
            comments: [{ start_line: 2, end_line: 2, content: 'second' }],
          }),
        ]);
        const j2 = JSON.parse(r2.stdout);
        assert.equal(j2.ok, true);
        assert.equal(j2.count, 1);
        assert.equal(j2.comment_ids.length, 1);

        assert.notEqual(j1.comment_ids[0], j2.comment_ids[0]);

        const commentsPath = join(tr.dir, '.ocr-runs', tr.runId, 'attempt-comments', `${tr.attemptId}.jsonl`);
        const content = await readFile(commentsPath, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l.length > 0);
        assert.equal(lines.length, 2);

        const attemptPath = join(tr.dir, '.ocr-runs', tr.runId, 'tasks', `${tr.taskId}.${tr.attemptId}.json`);
        const attemptData = JSON.parse(await readFile(attemptPath, 'utf-8')) as AttemptRecord;
        assert.equal(attemptData.stagedCommentCount, 2);
      } finally {
        process.chdir(oldCwd);
      }
    } finally {
      await cleanup(tr.dir);
    }
  });

  it('rejects invalid lease token', async () => {
    const tr = await createTestRun();
    try {
      const r = await runCli(tr.dir, 'code_comment.ts', [
        '--runId', tr.runId,
        '--args', JSON.stringify({
          ...makeCommentArgs(),
          taskId: tr.taskId,
          attemptId: tr.attemptId,
          leaseToken: 'invalid-token',
          filePath: tr.filePath,
          diffFingerprint: tr.diffFingerprint,
        }),
      ]);
      const j = JSON.parse(r.stdout);
      assert.equal(j.ok, false);
      assert.match(j.error, /lease|digest/i);
    } finally {
      await cleanup(tr.dir);
    }
  });

  it('rejects expired lease', async () => {
    const tr = await createTestRun();
    try {
      // Expire the lease by advancing clock
      const ocrRunDir = join(tr.dir, '.ocr-runs', tr.runId);
      const orchestrator = new Orchestrator(ocrRunDir, {
        now: () => new Date(Date.now() + 1_800_000),
      });
      await orchestrator.reconcile();

      const r = await runCli(tr.dir, 'code_comment.ts', [
        '--runId', tr.runId,
        '--args', JSON.stringify({
          ...makeCommentArgs(),
          taskId: tr.taskId,
          attemptId: tr.attemptId,
          leaseToken: tr.leaseToken,
          filePath: tr.filePath,
          diffFingerprint: tr.diffFingerprint,
        }),
      ]);
      const j = JSON.parse(r.stdout);
      assert.equal(j.ok, false);
      // Reconcile re-queues the task, so error is about task state
      assert.ok(j.error);
    } finally {
      await cleanup(tr.dir);
    }
  });

  it('rejects wrong file path', async () => {
    const tr = await createTestRun();
    try {
      const r = await runCli(tr.dir, 'code_comment.ts', [
        '--runId', tr.runId,
        '--args', JSON.stringify({
          ...makeCommentArgs(),
          taskId: tr.taskId,
          attemptId: tr.attemptId,
          leaseToken: tr.leaseToken,
          filePath: 'wrong/path.ts',
          diffFingerprint: tr.diffFingerprint,
        }),
      ]);
      const j = JSON.parse(r.stdout);
      assert.equal(j.ok, false);
      assert.match(j.error, /filePath|mismatch/i);
    } finally {
      await cleanup(tr.dir);
    }
  });

  it('rejects wrong diff fingerprint', async () => {
    const tr = await createTestRun();
    try {
      const r = await runCli(tr.dir, 'code_comment.ts', [
        '--runId', tr.runId,
        '--args', JSON.stringify({
          ...makeCommentArgs(),
          taskId: tr.taskId,
          attemptId: tr.attemptId,
          leaseToken: tr.leaseToken,
          filePath: tr.filePath,
          diffFingerprint: 'wrong-fingerprint',
        }),
      ]);
      const j = JSON.parse(r.stdout);
      assert.equal(j.ok, false);
      assert.match(j.error, /diff/i);
    } finally {
      await cleanup(tr.dir);
    }
  });

  it('rejects partial credentials', async () => {
    const tr = await createTestRun();
    try {
      const r = await runCli(tr.dir, 'code_comment.ts', [
        '--runId', tr.runId,
        '--args', JSON.stringify({
          ...makeCommentArgs(),
          taskId: tr.taskId,
          attemptId: tr.attemptId,
          leaseToken: tr.leaseToken,
          // missing filePath and diffFingerprint
        }),
      ]);
      const j = JSON.parse(r.stdout);
      assert.equal(j.ok, false);
      assert.match(j.error, /partial/i);
    } finally {
      await cleanup(tr.dir);
    }
  });

  it('rejects schema-1 legacy mode', async () => {
    const tr = await createTestRun();
    try {
      const r = await runCli(tr.dir, 'code_comment.ts', [
        '--runId', tr.runId,
        '--args', JSON.stringify(makeCommentArgs()),
      ]);
      const j = JSON.parse(r.stdout);
      assert.equal(j.ok, false);
      assert.match(j.error, /schema/i);
    } finally {
      await cleanup(tr.dir);
    }
  });

  it('allows old-schema legacy mode', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocrp-legacy-'));
    try {
      const runId = 'legacy-run';
      await mkdir(join(dir, '.ocr-runs', runId), { recursive: true });
      await writeFile(join(dir, '.ocr-runs', runId, 'context.json'), JSON.stringify({ runId }) + '\n');

      // No run.json — old-schema legacy mode
      const r = await runCli(dir, 'code_comment.ts', [
        '--runId', runId,
        '--args', JSON.stringify(makeCommentArgs()),
      ]);
      const j = JSON.parse(r.stdout);
      assert.equal(j.ok, true);
      assert.equal(j.count, 1);
      assert.equal(j.comment_ids.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed on malformed JSONL', async () => {
    const tr = await createTestRun();
    try {
      const ocrRunDir = join(tr.dir, '.ocr-runs', tr.runId);
      const commentsDir = join(ocrRunDir, 'attempt-comments');
      await mkdir(commentsDir, { recursive: true });
      await writeFile(join(commentsDir, `${tr.attemptId}.jsonl`), 'not-json\n');

      const r = await runCli(tr.dir, 'code_comment.ts', [
        '--runId', tr.runId,
        '--args', JSON.stringify({
          ...makeCommentArgs(),
          taskId: tr.taskId,
          attemptId: tr.attemptId,
          leaseToken: tr.leaseToken,
          filePath: tr.filePath,
          diffFingerprint: tr.diffFingerprint,
        }),
      ]);
      const j = JSON.parse(r.stdout);
      assert.equal(j.ok, false);
      assert.match(j.error, /malformed/i);
    } finally {
      await cleanup(tr.dir);
    }
  });

  it('output IDs match staged CommentRecords', async () => {
    const tr = await createTestRun();
    try {
      const r = await runCli(tr.dir, 'code_comment.ts', [
        '--runId', tr.runId,
        '--args', JSON.stringify({
          ...makeCommentArgs(),
          taskId: tr.taskId,
          attemptId: tr.attemptId,
          leaseToken: tr.leaseToken,
          filePath: tr.filePath,
          diffFingerprint: tr.diffFingerprint,
          comments: [
            { start_line: 1, end_line: 1, content: 'first' },
            { start_line: 2, end_line: 2, content: 'second' },
          ],
        }),
      ]);
      const j = JSON.parse(r.stdout);
      assert.equal(j.ok, true);
      assert.equal(j.count, 2);
      assert.equal(j.comment_ids.length, 2);

      const commentsPath = join(tr.dir, '.ocr-runs', tr.runId, 'attempt-comments', `${tr.attemptId}.jsonl`);
      const content = await readFile(commentsPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      assert.equal(lines.length, 2);

      const parsed0 = JSON.parse(lines[0]);
      const parsed1 = JSON.parse(lines[1]);
      assert.equal(parsed0.comment_id, j.comment_ids[0]);
      assert.equal(parsed1.comment_id, j.comment_ids[1]);
    } finally {
      await cleanup(tr.dir);
    }
  });
});
