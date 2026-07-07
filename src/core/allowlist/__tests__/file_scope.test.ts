import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFileInScope } from '../allowed_ext.js';
import type { LoadedCustomRules } from '../../rules/custom_rules.js';

function custom(opts: { include?: string[]; exclude?: string[] } = {}): LoadedCustomRules {
  return {
    source: '.code-review.yaml',
    sourceKind: 'repo',
    rules: [],
    include: opts.include ?? [],
    exclude: opts.exclude ?? [],
  };
}

test('isFileInScope: unsupported ext excluded', () => {
  const r = isFileInScope('src/foo.unknownext', null);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'unsupported-ext');
});

test('isFileInScope: user exclude wins over include', () => {
  const r = isFileInScope('src/foo.test.ts', custom({ include: ['src/**'], exclude: ['**/*.test.ts'] }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'user-exclude');
});

test('isFileInScope: include excludes non-matching files', () => {
  const r = isFileInScope('lib/foo.ts', custom({ include: ['src/**'] }));
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'not-in-include');
});

test('isFileInScope: include match skips default exclude', () => {
  // foo.test.ts would normally be default-excluded, but include match overrides.
  const r = isFileInScope('src/foo.test.ts', custom({ include: ['src/**/*.test.ts'] }));
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'ok');
});

test('isFileInScope: no include, default exclude applies', () => {
  const r = isFileInScope('src/foo.test.ts', null);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'default-exclude');
});

test('isFileInScope: normal ts file without config is ok', () => {
  const r = isFileInScope('src/foo.ts', null);
  assert.equal(r.allowed, true);
  assert.equal(r.reason, 'ok');
});
