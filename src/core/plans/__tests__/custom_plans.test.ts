import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlansGuidance } from '../custom_plans.js';

test('loadPlansGuidance: CLI path wins over repo and user defaults', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-plans-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'ocrp-plans-home-'));
  try {
    await mkdir(join(home, '.code-review'), { recursive: true });
    await writeFile(join(repo, '.code-review-plans.md'), 'repo guidance');
    await writeFile(join(home, '.code-review', 'plans.md'), 'user guidance');
    await writeFile(join(repo, 'custom-plans.md'), 'cli guidance');

    const loaded = await loadPlansGuidance(repo, 'custom-plans.md', { homeDir: home });

    assert.equal(loaded.sourceKind, 'cli');
    assert.equal(loaded.source, 'custom-plans.md');
    assert.equal(loaded.text, 'cli guidance');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('loadPlansGuidance: repo default wins over user default', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-plans-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'ocrp-plans-home-'));
  try {
    await mkdir(join(home, '.code-review'), { recursive: true });
    await writeFile(join(repo, '.code-review-plans.md'), 'repo guidance');
    await writeFile(join(home, '.code-review', 'plans.md'), 'user guidance');

    const loaded = await loadPlansGuidance(repo, undefined, { homeDir: home });

    assert.equal(loaded.sourceKind, 'repo');
    assert.equal(loaded.source, '.code-review-plans.md');
    assert.equal(loaded.text, 'repo guidance');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('loadPlansGuidance: user default is used when repo has none', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-plans-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'ocrp-plans-home-'));
  try {
    await mkdir(join(home, '.code-review'), { recursive: true });
    await writeFile(join(home, '.code-review', 'plans.md'), 'user guidance');

    const loaded = await loadPlansGuidance(repo, undefined, { homeDir: home });

    assert.equal(loaded.sourceKind, 'user');
    assert.equal(loaded.source, '~/.code-review/plans.md');
    assert.equal(loaded.text, 'user guidance');
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('loadPlansGuidance: no files returns none', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-plans-repo-'));
  const home = await mkdtemp(join(tmpdir(), 'ocrp-plans-home-'));
  try {
    const loaded = await loadPlansGuidance(repo, undefined, { homeDir: home });

    assert.deepEqual(loaded, { sourceKind: 'none', text: '' });
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('loadPlansGuidance: missing CLI path throws OCRP-PLANS-100', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'ocrp-plans-repo-'));
  try {
    await assert.rejects(
      () => loadPlansGuidance(repo, 'missing.md'),
      /OCRP-PLANS-100: cannot read plans file missing\.md/,
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
