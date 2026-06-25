#!/usr/bin/env node
import { readContext } from '../core/runs/store.js';
import type { ReviewContext } from '../core/model/request.js';

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] ?? '';
      out[k] = v;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  for (const r of ['runId', 'path']) {
    if (!f[r]) {
      process.stderr.write(`[file_read_diff] missing --${r}\n`);
      process.exit(2);
    }
  }
  const ctx = await readContext<ReviewContext>(f.runId);
  const file = ctx.files.find((x) => x.path === f.path);
  if (!file) {
    process.stderr.write(`[file_read_diff] path not in context: ${f.path}\n`);
    process.exit(3);
  }
  process.stdout.write(file.diff + (file.truncated ? '\n... (truncated)\n' : '\n'));
}

main().catch((err) => {
  process.stderr.write(`[file_read_diff] ${err?.message ?? err}\n`);
  process.exit(1);
});
