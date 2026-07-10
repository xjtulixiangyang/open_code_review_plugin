import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NULL_PATH, NULL_PATH_ALTS } from '../null_path.js';
import { parseUnifiedDiff } from '../parser.js';

test('NULL_PATH is /dev/null on non-win32', () => {
  assert.equal(NULL_PATH, '/dev/null');
});

test('NULL_PATH_ALTS contains both spellings', () => {
  assert.ok(NULL_PATH_ALTS.includes('/dev/null'));
  assert.ok(NULL_PATH_ALTS.includes('NUL'));
});

test('parser recognizes NUL as added file (--- NUL)', () => {
  const diff = [
    'diff --git a/NUL b/new.ts',
    '--- NUL',
    '+++ b/new.ts',
    '@@ -0,0 +1,3 @@',
    '+line 1',
    '+line 2',
    '+line 3',
  ].join('\n');
  const changes = parseUnifiedDiff(diff);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, 'added');
  assert.equal(changes[0].path, 'new.ts');
});

test('parser recognizes NUL as deleted file (+++ NUL)', () => {
  const diff = [
    'diff --git a/old.ts b/NUL',
    '--- a/old.ts',
    '+++ NUL',
    '@@ -1,3 +0,0 @@',
    '-line 1',
    '-line 2',
    '-line 3',
  ].join('\n');
  const changes = parseUnifiedDiff(diff);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].status, 'deleted');
  assert.equal(changes[0].path, 'old.ts');
});
