import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readRelocationResults, writeRelocationResult } from '../store.js';

test('relocation store returns empty output when missing and roundtrips results', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-relocation-store-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    assert.deepEqual(await readRelocationResults('run1'), { results: [], warnings: [] });

    await writeRelocationResult('run1', {
      path: 'src/a.ts',
      decisions: [{
        comment_id: 'c-1',
        original_start_line: 1,
        original_end_line: 1,
        resolved_start_line: 2,
        resolved_end_line: 2,
        source: 'existing_code_diff',
        reason: 'matched',
      }],
      _meta: { source: 'line_resolver', ts: 'now' },
    });

    const out = await readRelocationResults('run1');
    assert.equal(out.warnings.length, 0);
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0].path, 'src/a.ts');
    assert.equal(out.results[0].decisions[0].resolved_start_line, 2);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('readRelocationResults skips malformed relocation files with warnings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-relocation-store-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await mkdir(join(dir, '.ocr-runs/run1/relocations'), { recursive: true });
    await writeFile(join(dir, '.ocr-runs/run1/relocations/bad.json'), '{not json', 'utf8');

    const out = await readRelocationResults('run1');
    assert.deepEqual(out.results, []);
    assert.equal(out.warnings.length, 1);
    assert.equal(out.warnings[0].kind, 'relocation_parse_error');
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
