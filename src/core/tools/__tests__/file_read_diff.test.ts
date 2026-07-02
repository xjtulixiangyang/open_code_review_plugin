import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileDiff } from '../file_read_diff.js';
import type { ReviewContext } from '../../model/request.js';

function ctxWith(paths: Array<{ path: string; diff: string; truncated?: boolean }>): ReviewContext {
  return {
    runId: 'run1',
    repoRoot: '/repo',
    range: 'workspace',
    background: '',
    files: paths.map((p) => ({
      path: p.path,
      status: 'modified',
      diff: p.diff,
      truncated: p.truncated ?? false,
      hunks: [],
      rulesHit: [],
    })),
    changeFiles: paths.map((p) => p.path),
    meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
  };
}

test('readFileDiff formats multiple files with ==== FILE headers', () => {
  const ctx = ctxWith([
    { path: 'src/a.ts', diff: '@@ -1 +1 @@\n-a\n+a2' },
    { path: 'src/b.ts', diff: '@@ -2 +2 @@\n-b\n+b2' },
  ]);
  const out = readFileDiff({ path_array: ['src/a.ts', 'src/b.ts'] }, ctx);
  assert.match(out, /==== FILE: src\/a\.ts ====/);
  assert.match(out, /@@ -1 \+1 @@/);
  assert.match(out, /==== FILE: src\/b\.ts ====/);
});

test('readFileDiff ignores unknown paths but returns found ones', () => {
  const ctx = ctxWith([{ path: 'src/a.ts', diff: 'DIFF_A' }]);
  const out = readFileDiff({ path_array: ['src/a.ts', 'src/missing.ts'] }, ctx);
  assert.match(out, /DIFF_A/);
  assert.doesNotMatch(out, /missing\.ts/);
});

test('readFileDiff returns error when path_array empty', () => {
  const out = readFileDiff({ path_array: [] }, ctxWith([]));
  assert.equal(out, 'Error: no files found');
});

test('readFileDiff returns error when no path resolves', () => {
  const ctx = ctxWith([{ path: 'src/a.ts', diff: 'DIFF_A' }]);
  const out = readFileDiff({ path_array: ['src/missing.ts'] }, ctx);
  assert.equal(out, 'Error: diff not found for the requested paths');
});

test('readFileDiff appends truncation marker', () => {
  const ctx = ctxWith([{ path: 'src/a.ts', diff: 'PARTIAL', truncated: true }]);
  const out = readFileDiff({ path_array: ['src/a.ts'] }, ctx);
  assert.match(out, /\.\.\. \(truncated\)/);
});
