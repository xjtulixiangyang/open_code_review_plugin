import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnifiedDiff } from '../parser.js';

const SAMPLE = `diff --git a/src/foo.ts b/src/foo.ts
index e69de29..b48beac 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -0,0 +1,3 @@
+export function hello() {
+  return 'world';
+}
diff --git a/src/bar.ts b/src/bar.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/bar.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const X = 1;
-export const Y = 2;
diff --git a/img.png b/img.png
new file mode 100644
index 0000000..abc
Binary files /dev/null and b/img.png differ
diff --git a/src/old.ts b/src/new.ts
similarity index 60%
rename from src/old.ts
rename to src/new.ts
--- a/src/old.ts
+++ b/src/new.ts
@@ -1,3 +1,3 @@
 line1
-line2
+line2-changed
 line3
`;

test('parseUnifiedDiff 识别 4 类状态', () => {
  const files = parseUnifiedDiff(SAMPLE);
  assert.equal(files.length, 4);
  const byPath = Object.fromEntries(files.map((f) => [f.path, f]));

  assert.equal(byPath['src/foo.ts'].status, 'added');
  assert.equal(byPath['src/bar.ts'].status, 'deleted');
  assert.equal(byPath['img.png'].status, 'binary');
  assert.equal(byPath['src/new.ts'].status, 'renamed');
  assert.equal(byPath['src/new.ts'].oldPath, 'src/old.ts');
});

test('parseUnifiedDiff added 文件 hunk 行号正确', () => {
  const files = parseUnifiedDiff(SAMPLE);
  const foo = files.find((f) => f.path === 'src/foo.ts')!;
  assert.equal(foo.hunks.length, 1);
  const h = foo.hunks[0];
  assert.equal(h.newStart, 1);
  assert.equal(h.newLines, 3);
  assert.equal(h.lines.length, 3);
  for (const ln of h.lines) assert.equal(ln.kind, '+');
});

test('parseUnifiedDiff renamed 文件 hunk 含 +/-/ 三类', () => {
  const files = parseUnifiedDiff(SAMPLE);
  const r = files.find((f) => f.path === 'src/new.ts')!;
  const kinds = r.hunks[0].lines.map((l) => l.kind).sort();
  assert.deepEqual(kinds, [' ', ' ', '+', '-']);
});

test('parseUnifiedDiff 行号映射正确', () => {
  const files = parseUnifiedDiff(SAMPLE);
  const r = files.find((f) => f.path === 'src/new.ts')!;
  const lines = r.hunks[0].lines;
  // line1 是 context，oldLineNo=1, newLineNo=1
  assert.equal(lines[0].text, 'line1');
  assert.equal(lines[0].oldLineNo, 1);
  assert.equal(lines[0].newLineNo, 1);
  // line2 删除
  const del = lines.find((l) => l.kind === '-')!;
  assert.equal(del.oldLineNo, 2);
  // line2-changed 新增
  const add = lines.find((l) => l.kind === '+')!;
  assert.equal(add.newLineNo, 2);
});

test('parseUnifiedDiff Hunk.id 稳定 + 唯一', () => {
  const a = parseUnifiedDiff(SAMPLE);
  const b = parseUnifiedDiff(SAMPLE);
  const ids = a.flatMap((f) => f.hunks.map((h) => h.id));
  assert.equal(new Set(ids).size, ids.length, 'ids unique');
  const idsB = b.flatMap((f) => f.hunks.map((h) => h.id));
  assert.deepEqual(ids, idsB, 'ids stable');
});

test('parseUnifiedDiff maxHunkLines 截断标记', () => {
  const big = 'diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1,100 +1,100 @@\n' +
    Array.from({ length: 100 }, (_, i) => `+line${i}`).join('\n') + '\n';
  const files = parseUnifiedDiff(big, { maxHunkLines: 10 });
  assert.equal(files[0].truncated, true);
});
