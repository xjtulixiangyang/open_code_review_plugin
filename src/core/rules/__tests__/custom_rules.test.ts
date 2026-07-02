import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCustomRules } from '../custom_rules.js';

async function mkRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ocrp-rules-'));
}

test('loadCustomRules: CLI path wins over repo .code-review.yaml', async () => {
  const repo = await mkRepo();
  try {
    await writeFile(join(repo, '.code-review.yaml'), 'rules:\n  - path: "src/**"\n    rule: "repo rule"\n');
    await writeFile(join(repo, 'cli-rules.yaml'), 'rules:\n  - path: "**"\n    rule: "cli rule"\n');
    const r = await loadCustomRules(repo, 'cli-rules.yaml');
    assert.equal(r.sourceKind, 'cli');
    assert.equal(r.source, 'cli-rules.yaml');
    assert.equal(r.rules[0].rule, 'cli rule');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: repo discovery priority .yaml > .yml > .json', async () => {
  const repo = await mkRepo();
  try {
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, '.code-review.yml'), 'rules:\n  - path: "a"\n    rule: "yml"\n');
    await writeFile(join(repo, '.code-review.json'), JSON.stringify({ rules: [{ path: 'b', rule: 'json' }] }));
    const r = await loadCustomRules(repo);
    assert.equal(r.sourceKind, 'repo');
    assert.equal(r.source, '.code-review.yml');
    assert.equal(r.rules[0].rule, 'yml');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: no config returns sourceKind none and empty arrays', async () => {
  const repo = await mkRepo();
  try {
    const r = await loadCustomRules(repo);
    assert.equal(r.sourceKind, 'none');
    assert.equal(r.source, 'system');
    assert.deepEqual(r.rules, []);
    assert.deepEqual(r.include, []);
    assert.deepEqual(r.exclude, []);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: JSON file parses include/exclude', async () => {
  const repo = await mkRepo();
  try {
    await writeFile(join(repo, '.code-review.json'), JSON.stringify({
      rules: [{ path: 'src/**/*.ts', rule: 'check types' }],
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
    }));
    const r = await loadCustomRules(repo);
    assert.equal(r.sourceKind, 'repo');
    assert.deepEqual(r.include, ['src/**/*.ts']);
    assert.deepEqual(r.exclude, ['**/*.test.ts']);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: missing CLI file throws OCRP-RULES-090', async () => {
  const repo = await mkRepo();
  try {
    await assert.rejects(loadCustomRules(repo, 'nope.yaml'), /OCRP-RULES-090/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: malformed YAML throws OCRP-RULES-091', async () => {
  const repo = await mkRepo();
  try {
    await writeFile(join(repo, '.code-review.yaml'), 'rules: [unterminated\n');
    await assert.rejects(loadCustomRules(repo), /OCRP-RULES-091/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: non-object root throws OCRP-RULES-092', async () => {
  const repo = await mkRepo();
  try {
    await writeFile(join(repo, '.code-review.json'), JSON.stringify(['not', 'an', 'object']));
    await assert.rejects(loadCustomRules(repo), /OCRP-RULES-092/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: rule entry missing path throws OCRP-RULES-093', async () => {
  const repo = await mkRepo();
  try {
    await writeFile(join(repo, '.code-review.json'), JSON.stringify({ rules: [{ rule: 'no path' }] }));
    await assert.rejects(loadCustomRules(repo), /OCRP-RULES-093/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('loadCustomRules: rule entry missing rule throws OCRP-RULES-093', async () => {
  const repo = await mkRepo();
  try {
    await writeFile(join(repo, '.code-review.json'), JSON.stringify({ rules: [{ path: '**' }] }));
    await assert.rejects(loadCustomRules(repo), /OCRP-RULES-093/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
