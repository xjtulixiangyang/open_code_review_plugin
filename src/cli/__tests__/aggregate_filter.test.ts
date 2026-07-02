import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendComment, appendEvent, markDone, writeContext, writeFilterResult } from '../../core/runs/store.js';
import type { ReviewContext } from '../../core/model/request.js';
import type { CommentRecord } from '../../core/model/comment.js';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX_LOADER = join(ROOT, 'node_modules/tsx/dist/loader.mjs');

async function runAggregate(cwd: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX_LOADER, join(ROOT, 'src/cli/aggregate.ts'), ...args], { cwd });
}

const CTX: ReviewContext = {
  runId: 'run1',
  repoRoot: '/repo',
  range: 'workspace',
  background: '',
  files: [{ path: 'src/a.ts', status: 'modified', diff: '', truncated: false, hunks: [], rulesHit: [] }],
  changeFiles: ['src/a.ts'],
  meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
};

const KEEP: CommentRecord = {
  comment_id: 'c-11111111-1111-4111-8111-111111111111',
  path: 'src/a.ts',
  start_line: 1,
  end_line: 1,
  content: 'Keep this issue',
};

const HIDE: CommentRecord = {
  comment_id: 'c-22222222-2222-4222-8222-222222222222',
  path: 'src/a.ts',
  start_line: 2,
  end_line: 2,
  content: 'Hide this duplicate',
};

test('aggregate hides comments listed in filter results and reports counts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-aggregate-filter-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run1', CTX);
    await appendComment('run1', KEEP);
    await appendComment('run1', HIDE);
    await writeFilterResult('run1', {
      path: 'src/a.ts',
      decisions: [{ comment_id: HIDE.comment_id, action: 'hide', reason: 'duplicate' }],
      _meta: { source: 'review_filter_task', subagent: 'filter-a', ts: 'now' },
    });
    process.chdir(oldCwd);

    const { stdout } = await runAggregate(dir, ['--runId', 'run1', '--format', 'both']);
    const summary = JSON.parse(stdout) as {
      rawCommentCount: number;
      commentCount: number;
      filteredCommentCount: number;
      filterWarnings: unknown[];
    };

    assert.equal(summary.rawCommentCount, 2);
    assert.equal(summary.commentCount, 1);
    assert.equal(summary.filteredCommentCount, 1);
    assert.deepEqual(summary.filterWarnings, []);

    const reportMd = await readFile(join(dir, '.ocr-runs/run1/report.md'), 'utf8');
    assert.match(reportMd, /Keep this issue/);
    assert.doesNotMatch(reportMd, /Hide this duplicate/);
    assert.match(reportMd, /Filtered\*\*: 1/);

    const reportJson = JSON.parse(await readFile(join(dir, '.ocr-runs/run1/report.json'), 'utf8'));
    assert.equal(reportJson.summary.raw_comments, 2);
    assert.equal(reportJson.summary.comments, 1);
    assert.equal(reportJson.summary.filtered_comments, 1);
    assert.equal(reportJson.comments.length, 1);
    assert.equal(reportJson.comments[0].comment_id, KEEP.comment_id);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('aggregate warns when code_comment hook event is malformed without marking the review partial', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-aggregate-event-warning-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run1', CTX);
    await appendEvent('run1', { type: 'tool_call', tool: 'code_comment', args: { runId: 'run1' } });
    await markDone('run1', 'reviewer-a', 'src/a.ts');
    process.chdir(oldCwd);

    const { stdout } = await runAggregate(dir, ['--runId', 'run1', '--format', 'both']);
    const summary = JSON.parse(stdout) as { partial: boolean; eventWarnings: Array<{ reason: string }> };

    assert.equal(summary.partial, false);
    assert.match(summary.eventWarnings[0].reason, /malformed code_comment/);

    const reportJson = JSON.parse(await readFile(join(dir, '.ocr-runs/run1/report.json'), 'utf8'));
    assert.equal(reportJson.status, 'success');
    assert.match(reportJson.warnings[0].reason, /malformed code_comment/);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('aggregate ignores malformed event jsonl lines and still reports valid event warnings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-aggregate-event-parse-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run1', CTX);
    await appendFile(join(dir, '.ocr-runs/run1/events.jsonl'), '{bad json\n', 'utf8');
    await appendEvent('run1', { type: 'tool_call', tool: 'code_comment', args: { runId: 'run1' } });
    await markDone('run1', 'reviewer-a', 'src/a.ts');
    process.chdir(oldCwd);

    const { stdout } = await runAggregate(dir, ['--runId', 'run1', '--format', 'json']);
    const summary = JSON.parse(stdout) as { partial: boolean; eventWarnings: Array<{ reason: string }> };

    assert.equal(summary.partial, false);
    assert.equal(summary.eventWarnings.length, 1);
    assert.match(summary.eventWarnings[0].reason, /malformed code_comment/);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('aggregate escapes markdown warning fields', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-aggregate-warning-md-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run1', CTX);
    await appendEvent('run1', {
      type: 'tool_call',
      tool: 'code_comment',
      args: { path: 'src/[a](b).ts\n- injected', runId: 'run1' },
    });
    await markDone('run1', 'reviewer-a', 'src/a.ts');
    process.chdir(oldCwd);

    await runAggregate(dir, ['--runId', 'run1', '--format', 'markdown']);

    const reportMd = await readFile(join(dir, '.ocr-runs/run1/report.md'), 'utf8');
    assert.match(reportMd, /src\/\\\[a\\\]\\\(b\\\)\\\.ts\\n\\- injected/);
    assert.doesNotMatch(reportMd, /^- injected/m);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
