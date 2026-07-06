import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowed, loadSupportedExtensions, loadDefaultExcludes } from '../allowed_ext.js';

test('loadSupportedExtensions 至少含常见后缀', () => {
  const exts = loadSupportedExtensions();
  for (const e of ['.ts', '.tsx', '.js', '.java', '.go', '.py']) {
    assert.ok(exts.includes(e), `missing ${e}`);
  }
});

test('loadDefaultExcludes 至少含测试文件 glob', () => {
  const ex = loadDefaultExcludes();
  assert.ok(ex.some((p) => p.includes('_test.go')));
  assert.ok(ex.some((p) => p.includes('test')));
});

test('isAllowed: 已知支持的 .ts 文件返回 true', () => {
  assert.equal(isAllowed('src/foo.ts'), true);
});

test('isAllowed: 不支持的后缀返回 false', () => {
  assert.equal(isAllowed('foo.unknownext'), false);
});

test('isAllowed: 命中默认排除返回 false', () => {
  assert.equal(isAllowed('src/foo.test.ts'), false);
});

test('isAllowed: extraExclude 生效', () => {
  assert.equal(isAllowed('src/foo.ts', ['src/**']), false);
});

test('isAllowed: 目录形式排除', () => {
  assert.equal(isAllowed('dist/foo.js', ['dist/**']), false);
});
