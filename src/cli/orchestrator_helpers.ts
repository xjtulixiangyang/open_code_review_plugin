/**
 * Shared argument parsing and helper utilities for orchestrator protocol CLIs.
 *
 * All protocol CLIs use --runId plus operation-specific flags.
 * JSON-only stdout; stable [<stem>] prefix on stderr; exit 2 for malformed args.
 */

import { resolveExistingRunDir } from '../core/runs/store.js';
import { Orchestrator } from '../core/orchestrator/orchestrator.js';

export interface ParsedProtocolArgs {
  runId: string;
  [key: string]: string | undefined;
}

/**
 * Parse --flag value pairs from argv.
 * Returns a record of flag -> value.
 * All flags must be prefixed with --.
 */
export function parseProtocolArgs(argv: string[], requiredFlags: string[]): ParsedProtocolArgs {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`Missing value for --${key}`);
      }
      args[key] = val;
      i++; // skip the value
    }
  }

  for (const flag of requiredFlags) {
    if (!(flag in args)) {
      throw new Error(`Missing required flag: --${flag}`);
    }
  }

  return args as ParsedProtocolArgs;
}

/**
 * Resolve the run directory and create an Orchestrator instance.
 * Throws if the run directory does not exist.
 */
export async function resolveOrchestrator(runId: string): Promise<Orchestrator> {
  const runDir = await resolveExistingRunDir(runId);
  if (!runDir) {
    throw new Error(`Run directory not found for ${runId}`);
  }
  return new Orchestrator(runDir);
}

/**
 * Run a protocol CLI main function with standard error handling.
 * - Catches errors, writes [<stem>] prefixed message to stderr, exits 2.
 * - Ensures JSON-only stdout on success.
 */
export function runProtocolCli(stem: string, main: () => Promise<void>): void {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[${stem}] ${message}\n`);
    process.exit(2);
  });
}
