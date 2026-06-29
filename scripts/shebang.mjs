#!/usr/bin/env node
/**
 * shebang.mjs - 给 dist/cli/*.mjs 加 shebang + chmod +x，并同步到 bin/。
 * bin/<name> 优先做软链 → dist/cli/<name>.mjs；软链失败时回退为复制。
 */

import { readdir, readFile, writeFile, chmod, symlink, copyFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const cliDir = join(root, 'dist', 'cli');
const binDir = join(root, 'bin');

const SHEBANG = '#!/usr/bin/env node\n';

async function main() {
  await mkdir(binDir, { recursive: true });

  let files = [];
  try {
    files = await readdir(cliDir);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.error('[shebang] dist/cli/ not found. Did you run build:tsc + build:mjs first?');
      process.exit(1);
    }
    throw err;
  }

  let count = 0;
  for (const f of files) {
    if (!f.endsWith('.mjs')) continue;
    const full = join(cliDir, f);
    const body = await readFile(full, 'utf8');
    const withShebang = body.startsWith('#!') ? body : SHEBANG + body;
    if (withShebang !== body) {
      await writeFile(full, withShebang, 'utf8');
    }
    await chmod(full, 0o755);

    const stem = basename(f, '.mjs');
    const map = {
      prepare: 'ocr-prepare',
      aggregate: 'ocr-aggregate',
      rules_check: 'ocr-rules-check',
      plan_guidance: 'ocr-plan-guidance',
    };
    const binName = map[stem] ?? stem;
    const target = join(binDir, binName);

    try { await unlink(target); } catch { /* not exist */ }

    const rel = join('..', 'dist', 'cli', f);
    try {
      await symlink(rel, target);
    } catch {
      await copyFile(full, target);
      await chmod(target, 0o755);
    }
    console.log(`[shebang] ${binName} -> dist/cli/${f}`);
    count++;
  }
  console.log(`[shebang] done. processed ${count} file(s).`);
}

main().catch((err) => {
  console.error('[shebang] failed:', err);
  process.exit(1);
});
