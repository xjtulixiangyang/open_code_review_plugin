#!/usr/bin/env node
import { parseToolArgs } from '../core/tools/args.js';
import { parseComments, persistComments } from '../core/tools/code_comment.js';

async function main(): Promise<void> {
  const { runId, args } = parseToolArgs(process.argv.slice(2));
  const { records, error } = parseComments(args);
  if (error) {
    // Mirrors Go: return the error message as a normal result, exit 0.
    process.stdout.write(error + '\n');
    return;
  }
  const ids = await persistComments(runId, records);
  process.stdout.write(JSON.stringify({ ok: true, count: ids.length, comment_ids: ids }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[code_comment] ${err?.message ?? err}\n`);
  process.exit(1);
});
