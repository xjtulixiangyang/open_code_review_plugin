import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseComments, persistComments } from '../code_comment.js';
import { writeContext } from '../../runs/store.js';
import type { ReviewContext } from '../../model/request.js';

const CTX: ReviewContext = {
  runId: 'run1', repoRoot: '/repo', range: 'workspace', background: '',
  files: [{ path: 'src/a.ts', status: 'modified', diff: '', truncated: false, hunks: [], rulesHit: [] }],
  changeFiles: ['src/a.ts'],
  meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
};

test('parseComments builds records with comment_id from top-level path', () => {
  const { records, error } = parseComments({
    path: 'src/a.ts',
    subagent: 'reviewer-a',
    comments: [
      { content: 'issue one', start_line: 10, end_line: 12 },
      { content: 'issue two', start_line: 20, end_line: 20, suggestion_code: 'fix()' },
    ],
  });
  assert.equal(error, undefined);
  assert.equal(records.length, 2);
  assert.equal(records[0].path, 'src/a.ts');
  assert.equal(records[0].start_line, 10);
  assert.match(records[0].comment_id, /^c-/);
  assert.equal(records[0]._meta?.subagent, 'reviewer-a');
  assert.equal(records[1].suggestion_code, 'fix()');
});

test('parseComments skips invalid items (missing content / lines)', () => {
  const { records } = parseComments({
    path: 'src/a.ts',
    comments: [
      { start_line: 1, end_line: 1 }, // no content
      { content: 'ok', start_line: 1, end_line: 1 },
    ],
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].content, 'ok');
});

test('parseComments error when comments missing', () => {
  const { error } = parseComments({ path: 'src/a.ts' });
  assert.match(error ?? '', /'comments' array is required/);
});

test('parseComments error when path missing', () => {
  const { error } = parseComments({ comments: [{ content: 'x', start_line: 1, end_line: 1 }] });
  assert.equal(error, "Error: 'path' is required");
});

test('parseComments error when no valid comments', () => {
  const { error } = parseComments({ path: 'src/a.ts', comments: [{ start_line: 1, end_line: 1 }] });
  assert.equal(error, 'Error: no valid comments found');
});

test('persistComments appends one jsonl row per record with id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-code-comment-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('run1', CTX);
    const { records } = parseComments({
      path: 'src/a.ts', subagent: 'reviewer-a',
      comments: [{ content: 'first', start_line: 1, end_line: 1 }],
    });
    const ids = await persistComments('run1', records);
    assert.equal(ids.length, 1);
    assert.equal(ids[0], records[0].comment_id);

    const body = await readFile(join(dir, '.ocr-runs/run1/comments.jsonl'), 'utf8');
    const row = JSON.parse(body.trim());
    assert.equal(row.comment_id, ids[0]);
    assert.equal(row._meta.subagent, 'reviewer-a');
    assert.ok(row._meta.ts);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
