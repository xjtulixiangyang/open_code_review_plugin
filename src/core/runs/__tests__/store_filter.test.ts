import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFilterResults, safePathKey, writeFilterResult } from '../store.js';

test('safePathKey encodes slashes without creating directories', () => {
  assert.equal(safePathKey('src/a.ts'), 'src%2Fa.ts');
});

test('filter store roundtrips results and returns empty output when missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-filter-store-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    assert.deepEqual(await readFilterResults('run1'), { results: [], warnings: [] });

    await writeFilterResult('run1', {
      path: 'src/a.ts',
      decisions: [{ comment_id: 'c-1', action: 'hide', reason: 'duplicate' }],
      _meta: { source: 'review_filter_task', subagent: 'filter-a', ts: 'now' },
    });

    const out = await readFilterResults('run1');
    assert.equal(out.warnings.length, 0);
    assert.deepEqual(out.results, [{
      path: 'src/a.ts',
      decisions: [{ comment_id: 'c-1', action: 'hide', reason: 'duplicate' }],
      _meta: { source: 'review_filter_task', subagent: 'filter-a', ts: 'now' },
    }]);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('readFilterResults skips malformed filter files with warnings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-filter-store-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await mkdir(join(dir, '.ocr-runs/run1/filters'), { recursive: true });
    await writeFile(join(dir, '.ocr-runs/run1/filters/bad.json'), '{not json', 'utf8');

    const out = await readFilterResults('run1');
    assert.deepEqual(out.results, []);
    assert.equal(out.warnings.length, 1);
    assert.equal(out.warnings[0].kind, 'filter_parse_error');
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
