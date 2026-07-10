import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { writePlan } from '../../core/runs/store.js';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX = join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs');

async function runCli(cwd: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX, join(ROOT, 'src/cli/plan_guidance.ts'), ...args], {
    cwd,
  });
}

test('plan_guidance CLI prints file-specific guidance JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-plan-cli-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writePlan('run1', {
      change_summary: 'summary text',
      issues: [
        { severity: 'high', description: 'Fix src/a.ts race', tool_guidance: [] },
        { severity: 'medium', description: 'Check src/b.ts naming', tool_guidance: [] },
      ],
    });
    process.chdir(oldCwd);

    const { stdout } = await runCli(dir, ['--runId', 'run1', '--path', 'src/a.ts']);
    const json = JSON.parse(stdout) as { guidance: string };

    assert.match(json.guidance, /summary text/);
    assert.match(json.guidance, /Fix src\/a\.ts race/);
    assert.doesNotMatch(json.guidance, /src\/b\.ts/);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});


test('plan_guidance CLI appends custom plans guidance from context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-plan-cli-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writePlan('run-custom', {
      change_summary: 'summary text',
      issues: [
        { severity: 'high', description: 'Fix src/a.ts race', tool_guidance: [] },
      ],
    });
    await mkdir(join(dir, '.ocr-runs', 'run-custom'), { recursive: true });
    await writeFile(join(dir, '.ocr-runs', 'run-custom', 'context.json'), JSON.stringify({
      plansGuidanceText: 'custom guidance',
    }));
    process.chdir(oldCwd);

    const { stdout } = await runCli(dir, ['--runId', 'run-custom', '--path', 'src/a.ts']);
    const json = JSON.parse(stdout) as { guidance: string; hasPlan: boolean; hasCustomPlans: boolean };

    assert.equal(json.hasPlan, true);
    assert.equal(json.hasCustomPlans, true);
    assert.match(json.guidance, /PLAN guidance:/);
    assert.match(json.guidance, /Fix src\/a\.ts race/);
    assert.match(json.guidance, /Custom plans guidance:/);
    assert.match(json.guidance, /custom guidance/);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('plan_guidance CLI returns custom guidance when plan is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-plan-cli-'));
  try {
    await mkdir(join(dir, '.ocr-runs', 'run-custom'), { recursive: true });
    await writeFile(join(dir, '.ocr-runs', 'run-custom', 'context.json'), JSON.stringify({
      plansGuidanceText: 'custom guidance',
    }));

    const { stdout } = await runCli(dir, ['--runId', 'run-custom', '--path', 'src/a.ts']);
    const json = JSON.parse(stdout) as { guidance: string; hasPlan: boolean; hasCustomPlans: boolean };

    assert.equal(json.hasPlan, false);
    assert.equal(json.hasCustomPlans, true);
    assert.match(json.guidance, /Custom plans guidance:/);
    assert.match(json.guidance, /custom guidance/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
