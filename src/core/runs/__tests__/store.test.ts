import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  newRunId,
  runDir,
  writeContext,
  readContext,
  appendComment,
  readComments,
  writePlan,
  readPlan,
  appendEvent,
  markDone,
  listDone,
  writeReport,
} from '../store.js';
import type { ReviewContext } from '../../model/request.js';
import type { CommentRecord } from '../../model/comment.js';
import type { PlanOutput } from '../../model/plan.js';

const tempRoots: string[] = [];

async function setupTempRepo() {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-store-'));
  tempRoots.push(dir);
  const cwdBefore = process.cwd();
  process.chdir(dir);
  return { dir, restore: () => process.chdir(cwdBefore) };
}

function makeContext(id: string, repoRoot: string): ReviewContext {
  return {
    runId: id,
    repoRoot,
    range: 'workspace',
    background: '',
    files: [],
    changeFiles: [],
    meta: { generatedAt: new Date().toISOString(), pluginVersion: '0.1.0' },
  };
}

test.after(async () => {
  for (const d of tempRoots) await rm(d, { recursive: true, force: true });
});

test('newRunId 格式正确', () => {
  const id = newRunId();
  assert.match(id, /^\d{8}-\d{6}-[a-z0-9]{4}$/);
});

test('newRunId 互不相同', () => {
  const ids = new Set(Array.from({ length: 50 }, () => newRunId()));
  assert.equal(ids.size, 50);
});

test('runDir 返回 .ocr-runs/<runId> 绝对路径', async () => {
  const { dir, restore } = await setupTempRepo();
  try {
    const id = 'fake-id';
    const cwd = process.cwd();
    const p = runDir(id);
    assert.equal(p, join(cwd, '.ocr-runs', id));
  } finally {
    restore();
  }
});

test('writeContext + readContext 往返一致', async () => {
  const { dir, restore } = await setupTempRepo();
  try {
    const id = newRunId();
    const ctx = makeContext(id, dir);
    await writeContext(id, ctx);
    const back = await readContext(id);
    assert.deepEqual(back, ctx);
  } finally {
    restore();
  }
});

test('run artifacts from a Claude worktree resolve to the parent repo run', async () => {
  const { dir, restore } = await setupTempRepo();
  try {
    const id = newRunId();
    await writeContext(id, makeContext(id, dir));

    const worktreesDir = join(dir, '.claude', 'worktrees');
    await mkdir(worktreesDir, { recursive: true });
    const worktree = await mkdtemp(join(worktreesDir, 'reviewer-a-'));
    process.chdir(worktree);

    await markDone(id, 'reviewer-a', 'src/a.ts');
    const dones = await listDone(id);
    assert.deepEqual(dones, [{ subagent: 'reviewer-a', file: 'src/a.ts' }]);
    await assert.rejects(readFile(join(worktree, '.ocr-runs', id, 'done', 'reviewer-a.json'), 'utf8'));
  } finally {
    restore();
  }
});

test('run artifacts from inside an existing run directory resolve to that run instead of nesting', async () => {
  const { dir, restore } = await setupTempRepo();
  try {
    const id = newRunId();
    await writeContext(id, makeContext(id, dir));
    const rootRunDir = join(dir, '.ocr-runs', id);
    process.chdir(rootRunDir);

    await markDone(id, 'reviewer-nested', 'src/nested.ts');

    const marker = await readFile(join(rootRunDir, 'done', 'reviewer-nested.json'), 'utf8');
    assert.match(marker, /"file": "src\/nested.ts"/);
    await assert.rejects(readFile(join(rootRunDir, '.ocr-runs', id, 'done', 'reviewer-nested.json'), 'utf8'));
  } finally {
    restore();
  }
});

test('appendComment 串行 N 次 + readComments 顺序保留', async () => {
  const { restore } = await setupTempRepo();
  try {
    const id = newRunId();
    const N = 5;
    for (let i = 0; i < N; i++) {
      const c: CommentRecord = {
        path: `f${i}.ts`,
        start_line: i,
        end_line: i,
        content: `c${i}`,
      };
      await appendComment(id, c);
    }
    const all = await readComments(id);
    assert.equal(all.length, N);
    for (let i = 0; i < N; i++) assert.equal(all[i].content, `c${i}`);
  } finally {
    restore();
  }
});

test('writePlan + readPlan 往返', async () => {
  const { restore } = await setupTempRepo();
  try {
    const id = newRunId();
    const p: PlanOutput = { change_summary: 's', issues: [] };
    assert.equal(await readPlan(id), null);
    await writePlan(id, p);
    assert.deepEqual(await readPlan(id), p);
  } finally {
    restore();
  }
});

test('markDone + listDone', async () => {
  const { restore } = await setupTempRepo();
  try {
    const id = newRunId();
    await markDone(id, 'reviewer-a', 'src/a.ts');
    await markDone(id, 'reviewer-b', 'src/b.ts');
    const dones = await listDone(id);
    assert.equal(dones.length, 2);
    const files = dones.map((d) => d.file).sort();
    assert.deepEqual(files, ['src/a.ts', 'src/b.ts']);
  } finally {
    restore();
  }
});

test('appendEvent 写入 events.jsonl', async () => {
  const { dir, restore } = await setupTempRepo();
  try {
    const id = newRunId();
    await appendEvent(id, { type: 'tool_call', tool: 'code_comment' });
    const body = await readFile(join(dir, '.ocr-runs', id, 'events.jsonl'), 'utf8');
    assert.match(body, /"type":"tool_call"/);
  } finally {
    restore();
  }
});

test('writeReport 写入指定文件', async () => {
  const { dir, restore } = await setupTempRepo();
  try {
    const id = newRunId();
    await writeReport(id, 'report.md', '# hi');
    const body = await readFile(join(dir, '.ocr-runs', id, 'report.md'), 'utf8');
    assert.equal(body, '# hi');
  } finally {
    restore();
  }
});
