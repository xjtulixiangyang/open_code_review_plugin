#!/usr/bin/env node
/**
 * orchestrator_start — CLI entry point for starting a review orchestration run.
 *
 * Usage: node orchestrator_start.ts <candidateRunId>
 *
 * Reads the candidate's context.json and launch.json, computes fingerprints,
 * selects the effective run (resume or new), writes immutable manifest, and
 * outputs JSON with the result.
 */

import { startCandidate } from '../core/orchestrator/manifest.js';

async function main(): Promise<void> {
  const candidateRunId = process.argv[2];
  if (!candidateRunId) {
    console.error('Usage: orchestrator_start <candidateRunId>');
    process.exit(1);
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
    process.exit(1);
  }
}

main();
