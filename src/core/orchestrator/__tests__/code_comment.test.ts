import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Orchestrator } from '../orchestrator.js';
import type { RunRecord, TaskRecord, AttemptRecord, ReviewManifest, ManifestFile } from '../types.js';
import type { AttemptCredentials } from '../types.js';
import type { CommentRecord } from '../../model/comment.js';
import { ORCHESTRATOR_SCHEMA_VERSION } from '../types.js';
import { sha256, manifestDigest } from '../fingerprint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = '/tmp/orchestrator-stage-comments-test';

async function tmpDir(): Promise<string> {
  const dir = join(TMP_ROOT, `run-${randomUUID().slice(0, 8)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

interface RunDirResult {
  runId: string;
  taskId: string;
  attemptId: string;
  leaseToken: string;
  filePath: string;
  diffFingerprint: string;
}

async function createRunDirWithClaimedTask(runDir: string): Promise<RunDirResult> {
  const runId = `test-run-${randomUUID().slice(0, 8)}`;
  const taskId = `task-0`;
  const createdAt = new Date().toISOString();
  const filePath = 'src/foo.ts';
  const diffFp = sha256('test-diff');

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

  await writeFile(join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(runDir, 'run.json'), JSON.stringify(runRecord, null, 2) + '\n');

  const tasksDir = join(runDir, 'tasks');
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

  const orchestrator = new Orchestrator(runDir);
  const claimResults = await orchestrator.claim(1);
  const claim = claimResults[0];
  await orchestrator.acknowledgeDispatch(claim.taskId, claim.attemptId);

  return {
    runId,
    taskId: claim.taskId,
    attemptId: claim.attemptId,
    leaseToken: claim.leaseToken,
    filePath: claim.filePath,
    diffFingerprint: claim.diffFingerprint,
  };
}

function makeComment(overrides?: Partial<CommentRecord>): CommentRecord {
  return {
    comment_id: `c-${randomUUID()}`,
    path: 'src/foo.ts',
    start_line: 1,
    end_line: 1,
    content: 'test comment',
    _meta: { subagent: 'reviewer-0', ts: new Date().toISOString() },
    ...overrides,
  };
}

function makeCredentials(tr: RunDirResult): AttemptCredentials {
  return {
    taskId: tr.taskId,
    attemptId: tr.attemptId,
    leaseToken: tr.leaseToken,
    filePath: tr.filePath,
    diffFingerprint: tr.diffFingerprint,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Orchestrator stageComments', () => {
  describe('validation', () => {
    it('rejects when run is not active', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const runPath = join(runDir, 'run.json');
      const runData = JSON.parse(await readFile(runPath, 'utf-8'));
      runData.state = 'completed';
      await writeFile(runPath, JSON.stringify(runData, null, 2) + '\n');

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.stageComments(makeCredentials(tr), [makeComment()]),
        { message: /run.*not active/i },
      );

      await cleanup(runDir);
    });

    it('rejects when task is not running', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const tasksDir = join(runDir, 'tasks');
      const taskPath = join(tasksDir, `${tr.taskId}.json`);
      const taskData = JSON.parse(await readFile(taskPath, 'utf-8'));
      taskData.state = 'queued';
      await writeFile(taskPath, JSON.stringify(taskData, null, 2) + '\n');

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.stageComments(makeCredentials(tr), [makeComment()]),
        { message: /not running/i },
      );

      await cleanup(runDir);
    });

    it('rejects when attempt ID does not match', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.stageComments(
          { ...makeCredentials(tr), attemptId: 'wrong-attempt' },
          [makeComment()],
        ),
        { message: /attempt.*mismatch/i },
      );

      await cleanup(runDir);
    });

    it('rejects when file path does not match', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.stageComments(
          { ...makeCredentials(tr), filePath: 'wrong/path.ts' },
          [makeComment()],
        ),
        { message: /file path.*mismatch/i },
      );

      await cleanup(runDir);
    });

    it('rejects when diff fingerprint does not match', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.stageComments(
          { ...makeCredentials(tr), diffFingerprint: 'wrong-fingerprint' },
          [makeComment()],
        ),
        { message: /diff.*mismatch/i },
      );

      await cleanup(runDir);
    });

    it('rejects invalid lease token', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.stageComments(
          { ...makeCredentials(tr), leaseToken: 'invalid-token' },
          [makeComment()],
        ),
        { message: /lease.*token.*mismatch|digest.*mismatch/i },
      );

      await cleanup(runDir);
    });

    it('rejects expired lease', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const clock = new FakeClock(Date.now() + 1_800_000);
      const orchestrator = new Orchestrator(runDir, { now: () => clock.now() });

      await assert.rejects(
        () => orchestrator.stageComments(makeCredentials(tr), [makeComment()]),
        { message: /lease.*expired/i },
      );

      await cleanup(runDir);
    });
  });

  describe('successful comment staging', () => {
    it('appends a single comment and updates stagedCommentCount', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      const ids = await orchestrator.stageComments(makeCredentials(tr), [makeComment()]);

      assert.equal(ids.length, 1);
      assert.ok(ids[0]);

      const attemptPath = join(runDir, 'tasks', `${tr.taskId}.${tr.attemptId}.json`);
      const attemptData = JSON.parse(await readFile(attemptPath, 'utf-8')) as AttemptRecord;
      assert.equal(attemptData.stagedCommentCount, 1);

      await cleanup(runDir);
    });

    it('appends multiple comments at once and increments count', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      const ids = await orchestrator.stageComments(makeCredentials(tr), [
        makeComment({ comment_id: 'c-1', content: 'first' }),
        makeComment({ comment_id: 'c-2', content: 'second' }),
        makeComment({ comment_id: 'c-3', content: 'third' }),
      ]);

      assert.equal(ids.length, 3);
      assert.deepEqual(ids, ['c-1', 'c-2', 'c-3']);

      const commentsPath = join(runDir, 'attempt-comments', `${tr.attemptId}.jsonl`);
      const content = await readFile(commentsPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      assert.equal(lines.length, 3);

      const attemptPath = join(runDir, 'tasks', `${tr.taskId}.${tr.attemptId}.json`);
      const attemptData = JSON.parse(await readFile(attemptPath, 'utf-8')) as AttemptRecord;
      assert.equal(attemptData.stagedCommentCount, 3);

      await cleanup(runDir);
    });

    it('preserves existing comment_id values', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      const ids = await orchestrator.stageComments(makeCredentials(tr), [
        makeComment({ comment_id: 'my-custom-id-1' }),
        makeComment({ comment_id: 'my-custom-id-2' }),
      ]);

      assert.deepEqual(ids, ['my-custom-id-1', 'my-custom-id-2']);

      const commentsPath = join(runDir, 'attempt-comments', `${tr.attemptId}.jsonl`);
      const content = await readFile(commentsPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      assert.equal(JSON.parse(lines[0]).comment_id, 'my-custom-id-1');
      assert.equal(JSON.parse(lines[1]).comment_id, 'my-custom-id-2');

      await cleanup(runDir);
    });

    it('appends multiple calls preserving all comments', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);

      const ids1 = await orchestrator.stageComments(makeCredentials(tr), [
        makeComment({ comment_id: 'c-1', content: 'first' }),
      ]);
      assert.equal(ids1.length, 1);

      const ids2 = await orchestrator.stageComments(makeCredentials(tr), [
        makeComment({ comment_id: 'c-2', content: 'second' }),
        makeComment({ comment_id: 'c-3', content: 'third' }),
      ]);
      assert.equal(ids2.length, 2);

      const commentsPath = join(runDir, 'attempt-comments', `${tr.attemptId}.jsonl`);
      const content = await readFile(commentsPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      assert.equal(lines.length, 3);

      const attemptPath = join(runDir, 'tasks', `${tr.taskId}.${tr.attemptId}.json`);
      const attemptData = JSON.parse(await readFile(attemptPath, 'utf-8')) as AttemptRecord;
      assert.equal(attemptData.stagedCommentCount, 3);

      await cleanup(runDir);
    });
  });

  describe('JSONL recovery', () => {
    it('recovers stagedCommentCount from existing valid JSONL', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const commentsDir = join(runDir, 'attempt-comments');
      await mkdir(commentsDir, { recursive: true });
      const commentsPath = join(commentsDir, `${tr.attemptId}.jsonl`);
      await writeFile(commentsPath, JSON.stringify({ comment_id: 'existing-1' }) + '\n');

      const orchestrator = new Orchestrator(runDir);
      const ids = await orchestrator.stageComments(makeCredentials(tr), [
        makeComment({ comment_id: 'new-1' }),
      ]);

      assert.equal(ids.length, 1);

      const attemptPath = join(runDir, 'tasks', `${tr.taskId}.${tr.attemptId}.json`);
      const attemptData = JSON.parse(await readFile(attemptPath, 'utf-8')) as AttemptRecord;
      assert.equal(attemptData.stagedCommentCount, 2);

      await cleanup(runDir);
    });

    it('fails closed on malformed JSONL', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const commentsDir = join(runDir, 'attempt-comments');
      await mkdir(commentsDir, { recursive: true });
      const commentsPath = join(commentsDir, `${tr.attemptId}.jsonl`);
      await writeFile(commentsPath, 'not-json\n');

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.stageComments(makeCredentials(tr), [makeComment()]),
        { message: /malformed/i },
      );

      await cleanup(runDir);
    });

    it('fails closed when any line in JSONL is malformed', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const commentsDir = join(runDir, 'attempt-comments');
      await mkdir(commentsDir, { recursive: true });
      const commentsPath = join(commentsDir, `${tr.attemptId}.jsonl`);
      const lines = [
        JSON.stringify({ comment_id: 'c1' }),
        'bad-json-line',
        JSON.stringify({ comment_id: 'c3' }),
      ].join('\n');
      await writeFile(commentsPath, lines + '\n');

      const orchestrator = new Orchestrator(runDir);
      await assert.rejects(
        () => orchestrator.stageComments(makeCredentials(tr), [makeComment()]),
        { message: /malformed/i },
      );

      await cleanup(runDir);
    });
  });

  describe('token and event non-leakage', () => {
    it('does not leak lease token in stored JSONL', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      await orchestrator.stageComments(makeCredentials(tr), [makeComment()]);

      const commentsPath = join(runDir, 'attempt-comments', `${tr.attemptId}.jsonl`);
      const content = await readFile(commentsPath, 'utf-8');
      const parsed = JSON.parse(content.trim().split('\n')[0]);

      assert.equal(parsed.leaseToken, undefined);
      assert.equal(parsed.leaseTokenDigest, undefined);

      await cleanup(runDir);
    });

    it('returns only comment_ids array', async () => {
      const runDir = await tmpDir();
      const tr = await createRunDirWithClaimedTask(runDir);

      const orchestrator = new Orchestrator(runDir);
      const ids = await orchestrator.stageComments(makeCredentials(tr), [makeComment()]);

      assert.ok(Array.isArray(ids));
      assert.equal(ids.length, 1);

      await cleanup(runDir);
    });
  });
});

// ---------------------------------------------------------------------------
// FakeClock
// ---------------------------------------------------------------------------

class FakeClock {
  private _now: number;

  constructor(isoOrMs: number | string) {
    this._now = typeof isoOrMs === 'string' ? Date.parse(isoOrMs) : isoOrMs;
  }

  now(): Date {
    return new Date(this._now);
  }

  advance(ms: number): void {
    this._now += ms;
  }
}
