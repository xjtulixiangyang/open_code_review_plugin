#!/usr/bin/env node
/**
 * shebang.mjs - 给 dist/cli/*.mjs 加 shebang + chmod +x，并同步到 bin/。
 * bin/<name> 优先做软链 → dist/cli/<name>.mjs；软链失败时回退为复制。
 * Windows .cmd wrappers are also generated for compatibility.
 */

import { readdir, readFile, writeFile, chmod, symlink, copyFile, unlink, mkdir } from 'node:fs/promises';
import { writeFileSync, chmodSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const cliDir = join(root, 'dist', 'cli');
const binDir = join(root, 'bin');

const SHEBANG = '#!/usr/bin/env node\n';

const stemToBinName = {
  prepare: 'ocr-prepare',
  aggregate: 'ocr-aggregate',
  rules_check: 'ocr-rules-check',
  plan_guidance: 'ocr-plan-guidance',
  filter_apply: 'ocr-filter-apply',
  relocate_apply: 'ocr-relocate-apply',
  post_comments: 'ocr-post-comments',
  orchestrator_start: 'ocr-orchestrator-start',
  orchestrator_claim: 'ocr-orchestrator-claim',
  orchestrator_ack: 'ocr-orchestrator-ack',
  orchestrator_dispatch_fail: 'ocr-orchestrator-dispatch-fail',
  orchestrator_reconcile: 'ocr-orchestrator-reconcile',
  orchestrator_status: 'ocr-orchestrator-status',
};

// Map bin names to their .mjs stem for Windows .cmd wrappers
const binToMjsStem = {
  'ocr-prepare': 'prepare',
  'ocr-aggregate': 'aggregate',
  'ocr-rules-check': 'rules_check',
  'ocr-plan-guidance': 'plan_guidance',
  'ocr-filter-apply': 'filter_apply',
  'ocr-relocate-apply': 'relocate_apply',
  'ocr-post-comments': 'post_comments',
  'code_comment': 'code_comment',
  'task_done': 'task_done',
  'file_read_diff': 'file_read_diff',
  'ocr-orchestrator-start': 'orchestrator_start',
  'ocr-orchestrator-claim': 'orchestrator_claim',
  'ocr-orchestrator-ack': 'orchestrator_ack',
  'ocr-orchestrator-dispatch-fail': 'orchestrator_dispatch_fail',
  'ocr-orchestrator-reconcile': 'orchestrator_reconcile',
  'ocr-orchestrator-status': 'orchestrator_status',
};

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
    const binName = stemToBinName[stem] ?? stem;
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

  // Windows .cmd wrappers
  for (const [name, mjsName] of Object.entries(binToMjsStem)) {
    const cmdPath = join(binDir, `${name}.cmd`);
    writeFileSync(cmdPath, `@echo off\r\nnode "%~dp0..\\dist\\cli\\${mjsName}.mjs" %*\r\n`);
    chmodSync(cmdPath, 0o755);
    console.log(`[shebang] ${name}.cmd -> dist/cli/${mjsName}.mjs`);
  }
}

main().catch((err) => {
  console.error('[shebang] failed:', err);
  process.exit(1);
});
