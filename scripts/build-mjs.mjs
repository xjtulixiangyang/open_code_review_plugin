#!/usr/bin/env node
/**
 * build-mjs.mjs — post-process tsc output so the published artifact is
 * pure ESM `.mjs` files.
 *
 * Steps:
 *   1. Walk every `*.js` produced by `tsc` under `dist/`.
 *   2. Rewrite each file's relative `import`/`export … from '…'` specifiers
 *      so any `./foo` or `./foo.js` becomes `./foo.mjs`.
 *   3. Rename the file from `.js` to `.mjs`.
 *
 * The script is intentionally dependency-free so it can run in any Node
 * 18+ environment without `npm install` of devDeps beyond `typescript`.
 */

import { readdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, '..', 'dist');

/**
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && /** @type {{ code?: string }} */ (err).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

/**
 * Rewrite `import …from './x'` / `export … from './x.js'` to `.mjs`.
 * @param {string} source
 * @returns {string}
 */
function rewriteRelativeSpecifiers(source) {
  return source.replace(
    /((?:import|export)\s[^'"`;]*?from\s*|import\s*\(\s*)(['"])(\.{1,2}\/[^'"`]+)\2/g,
    (_match, prefix, quote, specifier) => {
      let next = specifier;
      if (next.endsWith('.js')) next = next.slice(0, -3) + '.mjs';
      else if (!next.endsWith('.mjs') && !/\.[a-zA-Z0-9]+$/.test(next)) next += '.mjs';
      return `${prefix}${quote}${next}${quote}`;
    },
  );
}

async function main() {
  try {
    await stat(distDir);
  } catch {
    console.error(`[build-mjs] dist/ not found at ${distDir}. Did you run 'npm run build:tsc' first?`);
    process.exit(1);
  }

  let count = 0;
  for await (const file of walk(distDir)) {
    if (!file.endsWith('.js')) continue;
    const original = await readFile(file, 'utf8');
    const rewritten = rewriteRelativeSpecifiers(original);
    const target = file.slice(0, -3) + '.mjs';
    await writeFile(target, rewritten, 'utf8');
    if (target !== file) {
      // Remove the original `.js` so only `.mjs` ships.
      await rename(file, file + '.removed');
    }
    count += 1;
    console.log(`[build-mjs] ${relative(distDir, target)}`);
  }
  // Best-effort cleanup of `.removed` markers.
  for await (const file of walk(distDir)) {
    if (file.endsWith('.removed')) {
      try {
        await (await import('node:fs/promises')).unlink(file);
      } catch {
        /* ignore */
      }
    }
  }
  console.log(`[build-mjs] done. converted ${count} file(s).`);
}

main().catch((err) => {
  console.error('[build-mjs] failed:', err);
  process.exit(1);
});
