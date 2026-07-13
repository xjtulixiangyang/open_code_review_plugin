#!/usr/bin/env node
/**
 * orchestrator_status — Return the current run state without mutating anything.
 *
 * Usage: node orchestrator_status.ts --runId <runId>
 *
 * Outputs a ReconcileResult JSON object on stdout.
 */

import { parseProtocolArgs, resolveOrchestrator, runProtocolCli } from './orchestrator_helpers.js';

async function main(): Promise<void> {
  const args = parseProtocolArgs(process.argv.slice(2), ['runId']);

  const orchestrator = await resolveOrchestrator(args.runId);
  const result = await orchestrator.status();
  process.stdout.write(JSON.stringify(result) + '\n');
}

runProtocolCli('orchestrator_status', main);
