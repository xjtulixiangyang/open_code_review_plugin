#!/usr/bin/env node
import { readContext, readFilePlan, readPlan } from '../core/runs/store.js';
import { combinePlanGuidance, planOutputToGuidance } from '../core/prompts/plan_guidance.js';
import type { PlanOutput } from '../core/model/plan.js';
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
      process.stderr.write(`[ocr-plan-guidance] missing --${r}\n`);
      process.exit(2);
    }
  }

  const plan = await readFilePlan<PlanOutput>(f.runId, f.path) ?? await readPlan<PlanOutput>(f.runId);
  const planGuidance = plan ? planOutputToGuidance(plan, f.path) : '';
  let customPlansText = '';
  try {
    const ctx = await readContext<ReviewContext>(f.runId);
    customPlansText = ctx.plansGuidanceText ?? '';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const guidance = combinePlanGuidance(planGuidance, customPlansText);
  process.stdout.write(JSON.stringify({
    path: f.path,
    guidance,
    hasPlan: planGuidance.length > 0,
    hasCustomPlans: customPlansText.length > 0,
  }, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[ocr-plan-guidance] ${err?.message ?? err}\n`);
  process.exit(1);
});
