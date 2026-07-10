#!/usr/bin/env node
import { readComments, readContext } from '../core/runs/store.js';
import type { CommentRecord } from '../core/model/comment.js';
import type { ReviewContext } from '../core/model/request.js';
import { githubPostComments } from './github_post.js';
import { gitlabPostComments } from './gitlab_post.js';

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    if (key === 'dry-run') {
      out[key] = 'true';
      continue;
    }
    out[key] = argv[i + 1] ?? '';
    i++;
  }
  return out;
}

function requirePr(provider: string, pr: string | undefined): void {
  if (!pr) {
    process.stderr.write(`[ocr-post-comments] --pr required for ${provider}\n`);
    process.exit(2);
  }
}

async function main(): Promise<void> {
  const args = parseFlags(process.argv.slice(2));
  if (!args.runId) {
    process.stderr.write('[ocr-post-comments] missing --runId\n');
    process.exit(2);
  }

  const provider = args.provider || 'github';
  const pr = args.pr;
  if (provider !== 'github' && provider !== 'gitlab') {
    process.stderr.write(`[ocr-post-comments] unknown provider: ${provider}\n`);
    process.exit(2);
  }
  requirePr(provider, pr);

  const comments = await readComments<CommentRecord>(args.runId);
  const ctx = await readContext<ReviewContext>(args.runId);
  const dryRun = args['dry-run'] === 'true';
  const retry = args.retry ? Number.parseInt(args.retry, 10) : 1;

  if (dryRun) {
    const preview = comments.map((c) => ({
      path: c.path,
      line: `${c.start_line}-${c.end_line}`,
      content: c.content.slice(0, 200),
      suggestion_code: c.suggestion_code?.slice(0, 200),
    }));
    process.stdout.write(JSON.stringify({ dryRun: true, comments: preview, count: comments.length }) + '\n');
    return;
  }

  if (provider === 'github') {
    const result = await githubPostComments(comments, ctx, pr, { dryRun, retry });
    process.stdout.write(JSON.stringify(result) + '\n');
    return;
  }

  const token = process.env.GITLAB_TOKEN;
  if (!token) {
    process.stderr.write('[ocr-post-comments] GITLAB_TOKEN env var required for gitlab provider\n');
    process.exit(2);
  }
  const projectId = process.env.CI_PROJECT_ID;
  if (!projectId) {
    process.stderr.write('[ocr-post-comments] CI_PROJECT_ID env var required for gitlab provider\n');
    process.exit(2);
  }

  const result = await gitlabPostComments(comments, ctx, pr, token, projectId, { dryRun, retry });
  process.stdout.write(JSON.stringify(result) + '\n');
}

main().catch((err) => {
  process.stderr.write(`[ocr-post-comments] ${(err as Error).message}\n`);
  process.exit(1);
});
