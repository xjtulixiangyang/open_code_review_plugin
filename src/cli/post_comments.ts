#!/usr/bin/env node
import { readComments, readContext } from '../core/runs/store.js';
import { spawn } from 'node:child_process';
import type { CommentRecord } from '../core/model/comment.js';
import type { ReviewContext } from '../core/model/request.js';

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1] ?? '';
      i++;
    }
  }
  return out;
}

function exec(cmd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('close', (code) => resolve({ ok: code === 0, stderr }));
    p.on('error', (e) => resolve({ ok: false, stderr: e.message }));
  });
}

async function main(): Promise<void> {
  const args = parseFlags(process.argv.slice(2));
  if (!args.runId) {
    process.stderr.write('[ocr-post-comments] missing --runId\n');
    process.exit(2);
  }
  const provider = args.provider || 'github';
  const pr = args.pr;

  const comments = await readComments<CommentRecord>(args.runId);
  const ctx = await readContext<ReviewContext>(args.runId);

  let posted = 0;
  let failed = 0;

  for (const c of comments) {
    let body = `**${ctx.range}** · \`${c.path}:${c.start_line}-${c.end_line}\`\n\n${c.content}`;
    if (c.suggestion_code) {
      body += `\n\n\`\`\`suggestion\n${c.suggestion_code}\n\`\`\``;
    }

    let result: { ok: boolean };
    if (provider === 'github') {
      if (!pr) {
        process.stderr.write('[ocr-post-comments] --pr required for github\n');
        process.exit(2);
      }
      result = await exec('gh', ['pr', 'comment', pr, '--body', body]);
    } else if (provider === 'gitlab') {
      if (!pr) {
        process.stderr.write('[ocr-post-comments] --pr required for gitlab\n');
        process.exit(2);
      }
      const token = process.env.GITLAB_TOKEN || '';
      result = await exec('curl', [
        '--request', 'POST',
        `https://gitlab.com/api/v4/projects/${process.env.CI_PROJECT_ID || '0'}/merge_requests/${pr}/notes`,
        '--header', `PRIVATE-TOKEN: ${token}`,
        '--data-urlencode', `body=${body}`,
      ]);
    } else {
      process.stderr.write(`[ocr-post-comments] unknown provider: ${provider}\n`);
      process.exit(2);
    }
    result.ok ? posted++ : failed++;
  }

  process.stdout.write(JSON.stringify({ posted, failed, skipped: 0 }) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[ocr-post-comments] ${(err as Error).message}\n`);
  process.exit(1);
});
