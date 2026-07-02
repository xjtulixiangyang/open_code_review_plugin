import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

async function runPrepare(cwd: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX, join(ROOT, 'src/cli/prepare.ts'), ...args], {
    cwd,
  });
}

test('ocr-prepare rejects --rules in P0 instead of silently ignoring it', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    await assert.rejects(
      runPrepare(repo, ['--rules', 'custom.json']),
      (err: unknown) => {
        const e = err as { code?: number; stderr?: string };
        assert.equal(e.code, 2);
        assert.match(e.stderr ?? '', /OCRP-RUN-011/);
        assert.match(e.stderr ?? '', /--rules is planned for P1/);
        return true;
      },
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('ocr-prepare rejects preview and dry-run flags in P0', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-prepare-'));
  try {
    for (const flag of ['--preview', '-p', '--dry-run']) {
      await assert.rejects(
        runPrepare(repo, [flag]),
        (err: unknown) => {
          const e = err as { code?: number; stderr?: string };
          assert.equal(e.code, 2);
          assert.match(e.stderr ?? '', /OCRP-RUN-011/);
          assert.match(e.stderr ?? '', /planned for P1/);
          return true;
        },
      );
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
