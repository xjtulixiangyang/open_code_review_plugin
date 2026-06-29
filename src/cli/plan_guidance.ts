#!/usr/bin/env node
import { readPlan } from '../core/runs/store.js';
import { planOutputToGuidance } from '../core/prompts/plan_guidance.js';
import type { PlanOutput } from '../core/model/plan.js';

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
      process.stderr.write(`[ocr-plan-guidance] missing --${r}\n`);
      process.exit(2);
    }
  }

  const plan = await readPlan<PlanOutput>(f.runId);
  const guidance = plan ? planOutputToGuidance(plan, f.path) : '';
  process.stdout.write(JSON.stringify({ guidance }, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[ocr-plan-guidance] ${err?.message ?? err}\n`);
  process.exit(1);
});
