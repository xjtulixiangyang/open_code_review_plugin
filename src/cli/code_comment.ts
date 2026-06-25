#!/usr/bin/env node
import { appendComment } from '../core/runs/store.js';
import type { CommentRecord } from '../core/model/comment.js';

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] ?? '';
      out[k] = v;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const f = parseFlags(process.argv.slice(2));
  const required = ['runId', 'path', 'start', 'end', 'content'];
  for (const r of required) {
    if (!f[r]) {
      process.stderr.write(`[code_comment] missing --${r}\n`);
      process.exit(2);
    }
  }
  const rec: CommentRecord = {
    path: f.path,
    start_line: parseInt(f.start, 10),
    end_line: parseInt(f.end, 10),
    content: f.content,
  };
  if (f['suggestion-code']) rec.suggestion_code = f['suggestion-code'];
  if (f['existing-code']) rec.existing_code = f['existing-code'];
  if (f.thinking) rec.thinking = f.thinking;
  rec._meta = {
    subagent: f.subagent ?? 'unknown',
    ts: new Date().toISOString(),
  };
  await appendComment(f.runId, rec);
  process.stdout.write(
    JSON.stringify({ ok: true, path: rec.path, start: rec.start_line, end: rec.end_line }) + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(`[code_comment] ${err?.message ?? err}\n`);
  process.exit(1);
});
