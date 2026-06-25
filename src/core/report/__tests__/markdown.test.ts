import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownReport } from '../markdown.js';
import type { ReviewContext } from '../../model/request.js';
import type { CommentRecord } from '../../model/comment.js';

const CTX: ReviewContext = {
  runId: 'r1',
  repoRoot: '/abs',
  range: 'HEAD~3..HEAD',
  background: 'fixing race',
  files: [
    {
      path: 'src/a.ts',
      status: 'modified',
      diff: '',
      truncated: false,
      hunks: [],
      rulesHit: [],
    },
    {
      path: 'src/b.ts',
      status: 'modified',
      diff: '',
      truncated: false,
      hunks: [],
      rulesHit: [],
    },
  ],
  changeFiles: ['src/a.ts', 'src/b.ts'],
  meta: { generatedAt: 'now', pluginVersion: '0.1.0' },
};

const COMMENTS: CommentRecord[] = [
  { path: 'src/a.ts', start_line: 10, end_line: 12, content: 'high issue', _meta: { ts: 't1' } },
  { path: 'src/a.ts', start_line: 30, end_line: 30, content: 'medium issue', _meta: { ts: 't2' } },
];

test('renderMarkdownReport 含标题、文件数、评论', () => {
  const md = renderMarkdownReport(CTX, COMMENTS, { partialFiles: [] });
  assert.match(md, /Code Review Results/i);
  assert.match(md, /Files reviewed.*2/);
  assert.match(md, /src\/a\.ts:10/);
  assert.match(md, /high issue/);
});

test('renderMarkdownReport partialFiles 在顶部产生 Warnings 段', () => {
  const md = renderMarkdownReport(CTX, [], { partialFiles: ['src/c.ts'] });
  assert.match(md, /⚠️ Warnings/);
  assert.match(md, /src\/c\.ts/);
});

test('renderMarkdownReport 无评论时输出 No issues 信息', () => {
  const md = renderMarkdownReport(CTX, [], { partialFiles: [] });
  assert.match(md, /no issues found/i);
});
