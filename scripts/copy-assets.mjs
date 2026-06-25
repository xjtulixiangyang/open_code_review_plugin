#!/usr/bin/env node
import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const srcDir = join(root, 'src');
const distDir = join(root, 'dist');

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else yield full;
  }
}

for await (const file of walk(srcDir)) {
  if (!file.endsWith('.json') && !file.endsWith('.md')) continue;
  const rel = relative(srcDir, file);
  const target = join(distDir, rel);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(file, target);
  console.log(`[copy-assets] ${rel}`);
}
