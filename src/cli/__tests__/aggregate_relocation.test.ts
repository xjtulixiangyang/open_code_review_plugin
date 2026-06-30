import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendComment, writeContext, writeRelocationResult } from '../../core/runs/store.js';
import type { ReviewContext } from '../../core/model/request.js';
import type { CommentRecord } from '../../core/model/comment.js';

const execFileAsync = promisify(execFile);
const ROOT = process.cwd();
const TSX_LOADER = join(ROOT, 'node_modules/tsx/dist/loader.mjs');

async function runAggregate(cwd: string, args: string[]) {
  return execFileAsync('node', ['--import', TSX_LOADER, join(ROOT, 'src/cli/aggregate.ts'), ...args], { cwd });
}

const CTX: ReviewContext = {
  runId: 'reloc-run',
  repoRoot: '/repo',
  range: 'workspace',
  background: '',
  files: [{ path: 'src/a.ts', status: 'modified', diff: '', truncated: false, hunks: [], rulesHit: [] }],
  changeFiles: ['src/a.ts'],
  meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
};

const COMMENT_KEEP: CommentRecord = {
  comment_id: 'c-keep',
  path: 'src/a.ts',
  start_line: 1,
  end_line: 1,
  content: 'Keep as is',
};

const COMMENT_RELOCATE: CommentRecord = {
  comment_id: 'c-reloc',
  path: 'src/a.ts',
  start_line: 5,
  end_line: 5,
  content: 'Should be relocated',
};

const COMMENT_FALLBACK: CommentRecord = {
  comment_id: 'c-fb',
  path: 'src/a.ts',
  start_line: 10,
  end_line: 10,
  content: 'Fallback original',
};

test('aggregate applies relocation decisions to visible comments', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-aggregate-reloc-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('reloc-run', CTX);
    await appendComment('reloc-run', COMMENT_KEEP);
    await appendComment('reloc-run', COMMENT_RELOCATE);
    await appendComment('reloc-run', COMMENT_FALLBACK);
    await writeRelocationResult('reloc-run', {
      path: 'src/a.ts',
      decisions: [
        {
          comment_id: 'c-reloc',
          original_start_line: 5,
          original_end_line: 5,
          resolved_start_line: 14,
          resolved_end_line: 15,
          source: 'existing_code_diff',
          reason: 'Matched existing_code',
        },
        {
          comment_id: 'c-fb',
          original_start_line: 10,
          original_end_line: 10,
          resolved_start_line: 10,
          resolved_end_line: 10,
          source: 'fallback_original',
          reason: 'Could not resolve',
        },
      ],
      _meta: { source: 'line_resolver', ts: 'now' },
    });
    process.chdir(oldCwd);

    const { stdout } = await runAggregate(dir, ['--runId', 'reloc-run', '--format', 'both']);
    const summary = JSON.parse(stdout) as {
      rawCommentCount: number;
      commentCount: number;
    };

    assert.equal(summary.rawCommentCount, 3);
    assert.equal(summary.commentCount, 3);

    // Check JSON report
    const reportJson = JSON.parse(await readFile(join(dir, '.ocr-runs/reloc-run/report.json'), 'utf8'));
    assert.equal(reportJson.summary.comments, 3);
    assert.equal(reportJson.summary.raw_comments, 3);
    // Relocated comment should have updated line numbers
    const relocComment = reportJson.comments.find((c: any) => c.comment_id === 'c-reloc');
    assert.equal(relocComment.start_line, 14);
    assert.equal(relocComment.end_line, 15);
    // Fallback comment should keep original line numbers
    const fbComment = reportJson.comments.find((c: any) => c.comment_id === 'c-fb');
    assert.equal(fbComment.start_line, 10);
    assert.equal(fbComment.end_line, 10);
    // Keep comment should keep original line numbers
    const keepComment = reportJson.comments.find((c: any) => c.comment_id === 'c-keep');
    assert.equal(keepComment.start_line, 1);
    assert.equal(keepComment.end_line, 1);
    // Summary should have relocation counts
    assert.equal(reportJson.summary.relocated_comments, 1);
    assert.equal(reportJson.summary.relocation_fallbacks, 1);

    // Check Markdown report
    const reportMd = await readFile(join(dir, '.ocr-runs/reloc-run/report.md'), 'utf8');
    assert.match(reportMd, /\*\*Relocated\*\*: 1 \(fallback 1\)/);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('aggregate handles missing relocation data gracefully', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-aggregate-reloc-missing-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('reloc-run2', CTX);
    await appendComment('reloc-run2', COMMENT_KEEP);
    process.chdir(oldCwd);

    const { stdout } = await runAggregate(dir, ['--runId', 'reloc-run2', '--format', 'json']);
    const summary = JSON.parse(stdout);
    assert.equal(summary.rawCommentCount, 1);
    assert.equal(summary.commentCount, 1);

    const reportJson = JSON.parse(await readFile(join(dir, '.ocr-runs/reloc-run2/report.json'), 'utf8'));
    assert.equal(reportJson.summary.comments, 1);
    assert.equal(reportJson.summary.relocated_comments, 0);
    assert.equal(reportJson.summary.relocation_fallbacks, 0);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('aggregate records warnings for unknown relocation decisions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ocrp-aggregate-reloc-warn-'));
  const oldCwd = process.cwd();
  try {
    process.chdir(dir);
    await writeContext('reloc-run3', CTX);
    await appendComment('reloc-run3', COMMENT_KEEP);
    await writeRelocationResult('reloc-run3', {
      path: 'src/a.ts',
      decisions: [
        {
          comment_id: 'c-nonexistent',
          original_start_line: 1,
          original_end_line: 1,
          resolved_start_line: 5,
          resolved_end_line: 5,
          source: 'existing_code_diff',
          reason: 'Test',
        },
      ],
      _meta: { source: 'line_resolver', ts: 'now' },
    });
    process.chdir(oldCwd);

    const { stdout } = await runAggregate(dir, ['--runId', 'reloc-run3', '--format', 'json']);
    const summary = JSON.parse(stdout);
    assert.ok(summary.relocationWarnings.length > 0);
    assert.match(summary.relocationWarnings[0].detail, /c-nonexistent/);

    const reportJson = JSON.parse(await readFile(join(dir, '.ocr-runs/reloc-run3/report.json'), 'utf8'));
    assert.ok(reportJson.relocation_warnings);
    assert.equal(reportJson.relocation_warnings.length, 1);
  } finally {
    process.chdir(oldCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
