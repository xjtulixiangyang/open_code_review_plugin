#!/usr/bin/env node
/**
 * orchestrator_dispatch_fail — Report that a dispatch attempt failed.
 *
 * Usage: node orchestrator_dispatch_fail.ts --runId <runId> --taskId <taskId> --attemptId <attemptId>
 *
 * Outputs a ReconcileResult JSON object on stdout.
 */

import { parseProtocolArgs, resolveOrchestrator, runProtocolCli } from './orchestrator_helpers.js';

async function main(): Promise<void> {
  const args = parseProtocolArgs(process.argv.slice(2), ['runId', 'taskId', 'attemptId']);

  const orchestrator = await resolveOrchestrator(args.runId);
  const result = await orchestrator.reportDispatchFailure(args.taskId!, args.attemptId!);
  process.stdout.write(JSON.stringify(result) + '\n');
}

runProtocolCli('orchestrator_dispatch_fail', main);
