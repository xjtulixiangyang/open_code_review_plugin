import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOutputToGuidance } from '../plan_guidance.js';
import type { PlanOutput } from '../../model/plan.js';

const SAMPLE: PlanOutput = {
  change_summary: 'overall',
  issues: [
    { severity: 'low', description: 'low issue in src/other.ts', tool_guidance: [] },
    { severity: 'high', description: 'high issue in src/foo.ts:42', tool_guidance: [] },
    { severity: 'medium', description: 'global concurrency concern', tool_guidance: [], file_hint: 'src/foo.ts' },
  ],
};

test('planOutputToGuidance 过滤含路径或 file_hint 的条目', () => {
  const g = planOutputToGuidance(SAMPLE, 'src/foo.ts');
  assert.ok(g.includes('high issue'));
  assert.ok(g.includes('global concurrency'));
  assert.ok(!g.includes('low issue in src/other.ts'));
});

test('planOutputToGuidance 按 severity 降序', () => {
  const g = planOutputToGuidance(SAMPLE, 'src/foo.ts');
  assert.ok(g.indexOf('high') < g.indexOf('medium'));
});

test('planOutputToGuidance 无相关条目返回空串', () => {
  const g = planOutputToGuidance({ change_summary: '', issues: [] }, 'src/foo.ts');
  assert.equal(g, '');
});
