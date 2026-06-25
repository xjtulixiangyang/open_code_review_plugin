#!/usr/bin/env node
import { markDone } from '../core/runs/store.js';

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
  for (const r of ['runId', 'subagent', 'file']) {
    if (!f[r]) {
      process.stderr.write(`[task_done] missing --${r}\n`);
      process.exit(2);
    }
  }
  await markDone(f.runId, f.subagent, f.file);
  process.stdout.write(JSON.stringify({ ok: true, subagent: f.subagent, file: f.file }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[task_done] ${err?.message ?? err}\n`);
  process.exit(1);
});
