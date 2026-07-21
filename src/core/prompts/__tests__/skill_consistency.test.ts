import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAIN_TASK_SYSTEM } from '../main_task.js';
import { PLAN_TASK_SYSTEM } from '../plan_task.js';

function readRoot(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

test('MAIN_TASK TS 常量与 ocr-review-file skill 保持关键段落一致', () => {
  const skill = readRoot('skills/ocr-review-file/SKILL.md');
  // Snippets that must appear in BOTH files
  const bothMustHave = [
    'You are a code review assistant developed by Alibaba.',
    'Focus on issues in newly added code.',
    'Findings from other files must NOT become the subject of your comments.',
    'task_done',
    // schema-1 credential fields
    'taskId',
    'attemptId',
    'leaseToken',
    'diffFingerprint',
    'outcome',
    'summary',
  ];
  for (const snippet of bothMustHave) {
    assert.ok(MAIN_TASK_SYSTEM.includes(snippet), `TS MAIN_TASK missing ${snippet}`);
    assert.ok(skill.includes(snippet), `SKILL MAIN_TASK missing ${snippet}`);
  }

  // Tool count: both should mention code_comment and file_read_diff
  assert.ok(MAIN_TASK_SYSTEM.includes('code_comment'), 'TS MAIN_TASK missing code_comment');
  assert.ok(skill.includes('code_comment'), 'SKILL MAIN_TASK missing code_comment');
  assert.ok(MAIN_TASK_SYSTEM.includes('file_read_diff'), 'TS MAIN_TASK missing file_read_diff');
  assert.ok(skill.includes('file_read_diff'), 'SKILL MAIN_TASK missing file_read_diff');
});

test('PLAN_TASK TS 常量与 ocr-plan skill 保持关键段落一致', () => {
  const skill = readRoot('skills/ocr-plan/SKILL.md');
  for (const snippet of [
    'You are an expert in code review task planning.',
    'Analyze code change content, identify potential risk points',
    'Strictly follow the JSON format below.',
    'The issues list must be sorted by severity in descending order',
  ]) {
    assert.ok(PLAN_TASK_SYSTEM.includes(snippet), `TS PLAN_TASK missing ${snippet}`);
    assert.ok(skill.includes(snippet), `SKILL PLAN_TASK missing ${snippet}`);
  }
});

test('ocr-plan skill describes single-file PLAN handoff', () => {
  const skill = readRoot('skills/ocr-plan/SKILL.md');

  assert.ok(skill.includes('currentFilePath'), 'ocr-plan skill must require currentFilePath');
  assert.ok(skill.includes('Produce ONE PlanOutput JSON for the current file only'), 'ocr-plan skill must be single-file scoped');
  assert.equal(skill.includes('covering ALL files in `context.files[]`'), false);
  assert.equal(skill.includes('triggered by totalChangedLines >= 50'), false);
});

