import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_REVIEW_CONCURRENCY,
  MAX_REVIEW_CONCURRENCY,
  normalizeConcurrency,
  parseArgs,
} from '../prepare.js';

test('parseArgs accepts --rules and stores rulesPath', () => {
  const args = parseArgs(['--rules', 'team-rules.yaml']);
  assert.equal(args.rulesPath, 'team-rules.yaml');
  assert.deepEqual(args.unsupported, []);
});

test('parseArgs accepts --rule alias and stores rulesPath', () => {
  const args = parseArgs(['--rule', 'team-rules.yaml']);
  assert.equal(args.rulesPath, 'team-rules.yaml');
  assert.deepEqual(args.unsupported, []);
});

test('parseArgs keeps --preview and --dry-run unsupported in this increment', () => {
  const args = parseArgs(['--preview', '--dry-run']);
  assert.ok(args.unsupported.some((x) => x.includes('--preview')));
  assert.ok(args.unsupported.some((x) => x.includes('--dry-run')));
});

test('normalizeConcurrency defaults to 2', () => {
  assert.equal(normalizeConcurrency(undefined), DEFAULT_REVIEW_CONCURRENCY);
  assert.equal(DEFAULT_REVIEW_CONCURRENCY, 2);
});

test('normalizeConcurrency accepts valid positive values', () => {
  assert.equal(normalizeConcurrency(1), 1);
  assert.equal(normalizeConcurrency(4), 4);
  assert.equal(normalizeConcurrency(MAX_REVIEW_CONCURRENCY), MAX_REVIEW_CONCURRENCY);
});

test('normalizeConcurrency rejects zero, negative, and NaN', () => {
  assert.throws(() => normalizeConcurrency(0), /OCRP-RUN-011/);
  assert.throws(() => normalizeConcurrency(-1), /OCRP-RUN-011/);
  assert.throws(() => normalizeConcurrency(Number.NaN), /OCRP-RUN-011/);
});

test('normalizeConcurrency caps values above MAX_REVIEW_CONCURRENCY', () => {
  assert.equal(normalizeConcurrency(MAX_REVIEW_CONCURRENCY + 10), MAX_REVIEW_CONCURRENCY);
});
