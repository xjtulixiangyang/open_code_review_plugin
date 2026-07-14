#!/usr/bin/env node
/**
 * orchestrator_start — CLI entry point for starting a review orchestration run.
 *
 * Usage: node orchestrator_start.ts --runId <candidateRunId>
 *
 * Reads the candidate's context.json and launch.json, computes fingerprints,
 * selects the effective run (resume or new), writes immutable manifest, and
 * outputs JSON with the result.
 */

import { startCandidate } from '../core/orchestrator/manifest.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runIdIndex = argv.indexOf('--runId');
  const candidateRunId = runIdIndex >= 0 ? argv[runIdIndex + 1] : (argv[0]?.startsWith('--') ? undefined : argv[0]);
  if (!candidateRunId) {
    console.error('[orchestrator_start] missing --runId');
    process.exit(2);
  }

  try {
    const result = await startCandidate(candidateRunId);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(
      JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
        candidateRunId,
      }),
    );
    process.exit(2);
  }
}

main();
