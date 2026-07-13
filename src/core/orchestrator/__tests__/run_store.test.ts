import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listRunDirsNear,
  readLaunchConfig,
  resolveExistingRunDir,
  safePathKey,
  writeContext,
  writeLaunchConfig,
} from '../../runs/store.js';

test('launch config round-trips and the candidate run is discoverable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ocr-run-store-'));
  const previous = process.cwd();
  process.chdir(root);
  try {
    await writeContext('candidate', { runId: 'candidate' });
    await writeLaunchConfig('candidate', {
      schemaVersion: 1,
      mode: 'workspace',
      concurrency: 2,
      leaseDurationMs: 900_000,
      maxAttempts: 2,
    });
    assert.equal((await readLaunchConfig('candidate')).mode, 'workspace');
    assert.equal(await resolveExistingRunDir('candidate'), join(process.cwd(), '.ocr-runs', 'candidate'));
    assert.deepEqual(await listRunDirsNear('candidate'), [join(process.cwd(), '.ocr-runs', 'candidate')]);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
});

test('safePathKey handles normal paths, reserved names, and long paths', () => {
  assert.equal(safePathKey('src/a.ts'), 'src%2Fa.ts');
  assert.match(safePathKey('src/CON.ts'), /^src%2FCON\.ts-[a-f0-9]{64}$/);
  const longKey = safePathKey(`src/${'x'.repeat(300)}.ts`);
  assert.ok(Buffer.byteLength(longKey, 'utf8') <= 200);
  assert.match(longKey, /-[a-f0-9]{64}$/);
});
