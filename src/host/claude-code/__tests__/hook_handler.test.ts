import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHookInput, extractToolCall, formatProgressLine } from '../hook_handler.js';

test('parseHookInput 正确解析 JSON', () => {
  const j = parseHookInput('{"tool_name":"Bash","tool_input":{"command":"code_comment --runId x --path y --start 1 --end 1 --content z"}}');
  assert.equal(j?.tool_name, 'Bash');
  assert.equal(j?.tool_input?.command?.startsWith('code_comment'), true);
});

test('parseHookInput 容错非 JSON', () => {
  assert.equal(parseHookInput('not json'), null);
});

test('extractToolCall 识别 code_comment', () => {
  const t = extractToolCall('code_comment --runId R --path src/a.ts --start 42 --end 50 --content "x" --subagent reviewer-a');
  assert.deepEqual(t, {
    tool: 'code_comment',
    args: { runId: 'R', path: 'src/a.ts', start: '42', end: '50', content: 'x', subagent: 'reviewer-a' },
  });
});

test('extractToolCall 识别 task_done', () => {
  const t = extractToolCall('task_done --runId R --subagent reviewer-a --file src/a.ts');
  assert.equal(t?.tool, 'task_done');
});

test('extractToolCall 识别 file_read_diff', () => {
  const t = extractToolCall('file_read_diff --runId R --path src/a.ts');
  assert.equal(t?.tool, 'file_read_diff');
});

test('extractToolCall 非目标命令返回 null', () => {
  assert.equal(extractToolCall('ls -la'), null);
  assert.equal(extractToolCall('git status'), null);
});

test('formatProgressLine code_comment', () => {
  const line = formatProgressLine({
    tool: 'code_comment',
    args: { subagent: 'reviewer-a', path: 'src/foo.ts', start: '42' } as any,
  });
  assert.match(line, /💬|reviewer-a|src\/foo.ts/);
});

test('formatProgressLine task_done', () => {
  const line = formatProgressLine({ tool: 'task_done', args: { subagent: 'reviewer-a', file: 'src/a.ts' } as any });
  assert.match(line, /✅|reviewer-a/);
});
