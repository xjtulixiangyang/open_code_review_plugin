#!/usr/bin/env node
/**
 * orchestrator_claim — Claim up to `capacity` queued tasks from a run.
 *
 * Usage: node orchestrator_claim.ts --runId <runId> --capacity <n>
 *
 * Outputs a JSON array of ClaimResult objects on stdout.
 */

import { parseProtocolArgs, resolveOrchestrator, runProtocolCli } from './orchestrator_helpers.js';

async function main(): Promise<void> {
  const args = parseProtocolArgs(process.argv.slice(2), ['runId', 'capacity']);
  const capacity = parseInt(args['capacity']!, 10);
  if (isNaN(capacity)) {
    throw new Error(`Invalid capacity: ${args['capacity']}`);
  }

  const orchestrator = await resolveOrchestrator(args.runId);
  const claims = await orchestrator.claim(capacity);
  process.stdout.write(JSON.stringify(claims) + '\n');
}

runProtocolCli('orchestrator_claim', main);
