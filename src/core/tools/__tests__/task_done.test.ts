import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTaskDone } from '../task_done.js';
import { markDone } from '../../runs/store.js';

test('parseTaskDone returns subagent and file', () => {
  const out = parseTaskDone({ subagent: 'reviewer-a', file: 'src/a.ts' });
  assert.deepEqual(out, { subagent: 'reviewer-a', file: 'src/a.ts' });
});

test('parseTaskDone throws when subagent missing', () => {
  assert.throws(() => parseTaskDone({ file: 'src/a.ts' }), /subagent/);
});

test('parseTaskDone throws when file missing', () => {
  assert.throws(() => parseTaskDone({ subagent: 'reviewer-a' }), /file/);
});

test('markDone writes done marker file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-task-done-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    const { subagent, file } = parseTaskDone({ subagent: 'reviewer-a', file: 'src/a.ts' });
    await markDone('run1', subagent, file);
    const body = JSON.parse(await readFile(join(dir, '.ocr-runs/run1/done/reviewer-a.json'), 'utf8'));
    assert.equal(body.subagent, 'reviewer-a');
    assert.equal(body.file, 'src/a.ts');
    assert.ok(body.ts);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
