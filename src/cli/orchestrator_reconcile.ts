#!/usr/bin/env node
/**
 * orchestrator_reconcile — Reconcile lease deadlines and recompute run state.
 *
 * Usage: node orchestrator_reconcile.ts --runId <runId>
 *
 * Outputs a ReconcileResult JSON object on stdout.
 */

import { parseProtocolArgs, resolveOrchestrator, runProtocolCli } from './orchestrator_helpers.js';

async function main(): Promise<void> {
  const args = parseProtocolArgs(process.argv.slice(2), ['runId']);

  const orchestrator = await resolveOrchestrator(args.runId);
  const result = await orchestrator.reconcile();
  process.stdout.write(JSON.stringify(result) + '\n');
}

runProtocolCli('orchestrator_reconcile', main);
