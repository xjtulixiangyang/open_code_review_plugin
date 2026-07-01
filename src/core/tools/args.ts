/**
 * Shared CLI arg parsing for the three review tools.
 * All tools use: <tool> --runId <runId> --args '<json object>'.
 */

export interface ParsedToolArgs {
  runId: string;
  args: Record<string, unknown>;
}

function scanValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  return argv[i + 1];
}

export function parseToolArgs(argv: string[]): ParsedToolArgs {
  const runId = scanValue(argv, '--runId');
  if (!runId) throw new Error(`[tool] missing --runId`);
  const raw = scanValue(argv, '--args');
  if (raw === undefined) throw new Error(`[tool] missing --args`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`[tool] --args is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`[tool] --args must be a JSON object`);
  }
  return { runId, args: parsed as Record<string, unknown> };
}
