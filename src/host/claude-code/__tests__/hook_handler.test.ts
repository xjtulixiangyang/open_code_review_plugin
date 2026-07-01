import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHookInput, extractToolCall, formatProgressLine } from '../hook_handler.js';

test('parseHookInput 正确解析 JSON', () => {
  const j = parseHookInput('{"tool_name":"Bash","tool_input":{"command":"code_comment --runId x --args {\\"path\\":\\"y\\"}"}}');
  assert.equal(j?.tool_name, 'Bash');
  assert.equal(j?.tool_input?.command?.startsWith('code_comment'), true);
});

test('parseHookInput 容错非 JSON', () => {
  assert.equal(parseHookInput('not json'), null);
});

test('extractToolCall 识别 code_comment 并解析 args', () => {
  const t = extractToolCall('code_comment --runId R --args \'{"path":"src/a.ts","subagent":"reviewer-a","comments":[{"start_line":42,"end_line":50,"content":"x"}]}\'');
  assert.equal(t?.tool, 'code_comment');
  assert.equal(t?.args.runId, 'R');
  assert.equal(t?.args.path, 'src/a.ts');
  assert.equal(t?.args.subagent, 'reviewer-a');
  assert.equal(t?.args.start, '42');
  assert.equal(t?.args.end, '50');
});

test('extractToolCall 识别 task_done', () => {
  const t = extractToolCall('task_done --runId R --args \'{"subagent":"reviewer-a","file":"src/a.ts"}\'');
  assert.equal(t?.tool, 'task_done');
  assert.equal(t?.args.subagent, 'reviewer-a');
  assert.equal(t?.args.file, 'src/a.ts');
});

test('extractToolCall 识别 file_read_diff', () => {
  const t = extractToolCall('file_read_diff --runId R --args \'{"path_array":["src/a.ts"]}\'');
  assert.equal(t?.tool, 'file_read_diff');
  assert.equal(t?.args.runId, 'R');
});

test('extractToolCall 非目标命令返回 null', () => {
  assert.equal(extractToolCall('ls -la'), null);
  assert.equal(extractToolCall('git status'), null);
});

test('formatProgressLine code_comment', () => {
  const line = formatProgressLine({
    tool: 'code_comment',
    args: { runId: 'R', subagent: 'reviewer-a', path: 'src/foo.ts', start: '42' } as any,
  });
  assert.match(line, /💬|reviewer-a|src\/foo\.ts/);
});

test('formatProgressLine task_done', () => {
  const line = formatProgressLine({ tool: 'task_done', args: { subagent: 'reviewer-a', file: 'src/a.ts' } as any });
  assert.match(line, /✅|reviewer-a/);
});
