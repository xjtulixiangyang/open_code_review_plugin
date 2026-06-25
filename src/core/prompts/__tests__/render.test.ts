import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderTemplate } from '../render.js';

test('renderTemplate 替换 {{key}}', () => {
  const out = renderTemplate('hello {{name}}!', { name: 'world' });
  assert.equal(out, 'hello world!');
});

test('renderTemplate 替换 {key}', () => {
  const out = renderTemplate('hi {n}', { n: 'a' });
  assert.equal(out, 'hi a');
});

test('renderTemplate 未提供的 key 替换为空串', () => {
  const out = renderTemplate('a={{a}} b={{b}}', { a: '1' });
  assert.equal(out, 'a=1 b=');
});

test('renderTemplate 同名多次替换', () => {
  const out = renderTemplate('{{x}} {{x}} {{x}}', { x: '7' });
  assert.equal(out, '7 7 7');
});

test('renderTemplate 不替换字面 { } 单字符', () => {
  const out = renderTemplate('keep { } as is', {});
  assert.equal(out, 'keep { } as is');
});
