import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchRule, buildSystemRulePrompt, loadSystemRules, resolveRule } from '../matcher.js';
import type { LoadedCustomRules } from '../custom_rules.js';

test('loadSystemRules 至少有 default + 若干 path rule', () => {
  const r = loadSystemRules();
  assert.equal(r.default_rule, 'default.md');
  assert.ok(Object.keys(r.path_rule_map).length > 0);
});

test('matchRule: .ts 文件命中 ts_js_tsx_jsx.md', () => {
  const m = matchRule('src/foo.ts');
  assert.ok(m);
  assert.equal(m!.docPath, 'ts_js_tsx_jsx.md');
});

test('matchRule: pom.xml 命中 pom_xml.md', () => {
  const m = matchRule('module/pom.xml');
  assert.equal(m!.docPath, 'pom_xml.md');
});

test('matchRule: 未知后缀命中 default.md', () => {
  const m = matchRule('foo.unknown');
  assert.equal(m!.docPath, 'default.md');
});

test('buildSystemRulePrompt 返回 ruleId + docPath + text', () => {
  const p = buildSystemRulePrompt('src/foo.ts');
  assert.equal(p.docPath, 'ts_js_tsx_jsx.md');
  assert.ok(p.text.length > 50, 'rule doc 应有内容');
});

function customRules(rules: Array<{ path: string; rule: string }>): LoadedCustomRules {
  return { source: '.code-review.yaml', sourceKind: 'repo', rules, include: [], exclude: [] };
}

test('resolveRule: custom first-match-wins', () => {
  const r = resolveRule('src/a.ts', customRules([
    { path: 'src/**/*.go', rule: 'go rule' },
    { path: 'src/**/*.ts', rule: 'ts rule' },
  ]));
  assert.equal(r.source, 'custom');
  assert.equal(r.text, 'ts rule');
  assert.equal(r.docPath, undefined);
  assert.ok(r.ruleId.startsWith('custom'));
});

test('resolveRule: custom miss falls back to system', () => {
  const r = resolveRule('src/a.ts', customRules([
    { path: 'src/**/*.go', rule: 'go rule' },
  ]));
  assert.equal(r.source, 'system');
  assert.equal(r.docPath, 'ts_js_tsx_jsx.md');
});

test('resolveRule: null custom uses system only', () => {
  const r = resolveRule('src/a.ts', null);
  assert.equal(r.source, 'system');
  assert.equal(r.docPath, 'ts_js_tsx_jsx.md');
});
