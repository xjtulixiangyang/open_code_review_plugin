import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planOutputToGuidance, combinePlanGuidance } from '../plan_guidance.js';
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


test('combinePlanGuidance returns empty string when both inputs are empty', () => {
  assert.equal(combinePlanGuidance('', ''), '');
});

test('combinePlanGuidance returns custom section when only custom plans exist', () => {
  const g = combinePlanGuidance('', 'custom guidance');
  assert.match(g, /Custom plans guidance:/);
  assert.match(g, /custom guidance/);
  assert.doesNotMatch(g, /PLAN guidance:/);
});

test('combinePlanGuidance combines plan and custom sections', () => {
  const g = combinePlanGuidance('plan guidance', 'custom guidance');
  assert.match(g, /PLAN guidance:/);
  assert.match(g, /plan guidance/);
  assert.match(g, /Custom plans guidance:/);
  assert.match(g, /custom guidance/);
});
