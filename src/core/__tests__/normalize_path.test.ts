import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePath } from '../diff/null_path.js';

test('normalizePath converts backslash to forward slash', () => {
  assert.equal(normalizePath('a\\b\\c'), 'a/b/c');
});

test('normalizePath is idempotent on forward slashes', () => {
  assert.equal(normalizePath('a/b/c'), 'a/b/c');
});

test('normalizePath handles mixed slashes', () => {
  assert.equal(normalizePath('a\\b/c\\d'), 'a/b/c/d');
});

test('normalizePath handles empty string', () => {
  assert.equal(normalizePath(''), '');
});

test('normalizePath handles no slashes', () => {
  assert.equal(normalizePath('foo.ts'), 'foo.ts');
});
