import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolArgs } from '../args.js';

test('parseToolArgs returns runId and parsed args object', () => {
  const out = parseToolArgs(['--runId', 'run1', '--args', '{"path":"src/a.ts"}']);
  assert.equal(out.runId, 'run1');
  assert.deepEqual(out.args, { path: 'src/a.ts' });
});

test('parseToolArgs throws when --runId missing', () => {
  assert.throws(() => parseToolArgs(['--args', '{}']), /missing --runId/);
});

test('parseToolArgs throws when --args missing', () => {
  assert.throws(() => parseToolArgs(['--runId', 'run1']), /missing --args/);
});

test('parseToolArgs rejects non-object JSON (array)', () => {
  assert.throws(
    () => parseToolArgs(['--runId', 'run1', '--args', '[1,2]']),
    /must be a JSON object/,
  );
});

test('parseToolArgs rejects malformed JSON', () => {
  assert.throws(
    () => parseToolArgs(['--runId', 'run1', '--args', '{not json}']),
    /SyntaxError|Unexpected|JSON/,
  );
});
