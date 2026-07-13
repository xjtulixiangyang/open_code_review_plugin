#!/usr/bin/env node
/**
 * orchestrator_ack — Acknowledge that a leased task has been dispatched.
 *
 * Usage: node orchestrator_ack.ts --runId <runId> --taskId <taskId> --attemptId <attemptId>
 *
 * Outputs {"ok": true} on stdout on success.
 */

import { parseProtocolArgs, resolveOrchestrator, runProtocolCli } from './orchestrator_helpers.js';

async function main(): Promise<void> {
  const args = parseProtocolArgs(process.argv.slice(2), ['runId', 'taskId', 'attemptId']);

  const orchestrator = await resolveOrchestrator(args.runId);
  await orchestrator.acknowledgeDispatch(args.taskId!, args.attemptId!);
  process.stdout.write(JSON.stringify({ ok: true }) + '\n');
}

runProtocolCli('orchestrator_ack', main);
