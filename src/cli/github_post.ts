import { spawn } from 'node:child_process';
import type { CommentRecord } from '../core/model/comment.js';
import type { ReviewContext } from '../core/model/request.js';

export interface PostDetail {
  path: string;
  line: number;
  ok: boolean;
  fallbackLevel: number;
}

export interface PostResult {
  posted: number;
  failed: number;
  skipped: number;
  details: PostDetail[];
}

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function exec(cmd: string, args: string[], stdin?: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    if (stdin !== undefined) {
      p.stdin.write(stdin);
    }
    p.stdin.end();
    p.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
    p.on('error', (e) => resolve({ ok: false, stdout, stderr: e.message }));
  });
}

async function getRepo(): Promise<{ owner: string; repo: string }> {
  const r = await exec('gh', ['repo', 'view', '--json', 'nameWithOwner']);
  if (!r.ok) throw new Error(`gh repo view failed: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout) as { nameWithOwner: string };
  const [owner, repo] = parsed.nameWithOwner.split('/');
  if (!owner || !repo) throw new Error(`gh repo view returned invalid nameWithOwner: ${parsed.nameWithOwner}`);
  return { owner, repo };
}

async function getHeadSha(pr: string): Promise<string> {
  const r = await exec('gh', ['pr', 'view', pr, '--json', 'headRefOid']);
  if (!r.ok) throw new Error(`gh pr view failed: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout) as { headRefOid: string };
  return parsed.headRefOid;
}

function commentBody(c: CommentRecord): string {
  let body = `**${c.start_line}-${c.end_line}** · ${c.content}`;
  if (c.suggestion_code) {
    body += `\n\n\`\`\`suggestion\n${c.suggestion_code}\n\`\`\``;
  }
  return body;
}

function issueBody(ctx: ReviewContext, c: CommentRecord): string {
  let body = `**${ctx.range}** · \`${c.path}:${c.start_line}-${c.end_line}\`\n\n${c.content}`;
  if (c.suggestion_code) {
    body += `\n\n\`\`\`suggestion\n${c.suggestion_code}\n\`\`\``;
  }
  return body;
}

function reviewPayload(headSha: string, comments: CommentRecord[]): string {
  return JSON.stringify({
    commit_id: headSha,
    event: 'COMMENT',
    comments: comments.map((c) => ({
      path: c.path,
      body: commentBody(c),
      line: c.end_line,
      start_line: c.start_line,
      side: 'RIGHT',
      start_side: 'RIGHT',
    })),
  });
}

async function postReview(owner: string, repo: string, pr: string, headSha: string, comments: CommentRecord[]): Promise<boolean> {
  const r = await exec('gh', [
    'api',
    `repos/${owner}/${repo}/pulls/${pr}/reviews`,
    '--method',
    'POST',
    '--input',
    '-',
  ], reviewPayload(headSha, comments));
  return r.ok;
}

async function postIssueComment(pr: string, body: string): Promise<boolean> {
  const r = await exec('gh', ['pr', 'comment', pr, '--body', body]);
  return r.ok;
}

export async function githubPostComments(
  comments: CommentRecord[],
  ctx: ReviewContext,
  pr: string,
  opts: { dryRun?: boolean; retry?: number } = {},
): Promise<PostResult> {
  if (comments.length === 0) return { posted: 0, failed: 0, skipped: 0, details: [] };

  if (opts.dryRun) {
    return {
      posted: 0,
      failed: 0,
      skipped: comments.length,
      details: comments.map((c) => ({ path: c.path, line: c.end_line, ok: false, fallbackLevel: 0 })),
    };
  }

  const retry = opts.retry ?? 1;
  const { owner, repo } = await getRepo();
  const headSha = await getHeadSha(pr);

  if (await postReview(owner, repo, pr, headSha, comments)) {
    return {
      posted: comments.length,
      failed: 0,
      skipped: 0,
      details: comments.map((c) => ({ path: c.path, line: c.end_line, ok: true, fallbackLevel: 1 })),
    };
  }

  const details: PostDetail[] = [];
  let posted = 0;
  let failed = 0;

  for (const c of comments) {
    let ok = false;
    for (let attempt = 0; attempt <= retry; attempt++) {
      ok = await postReview(owner, repo, pr, headSha, [c]);
      if (ok) break;
    }
    if (ok) {
      posted++;
      details.push({ path: c.path, line: c.end_line, ok: true, fallbackLevel: 2 });
      continue;
    }

    ok = await postIssueComment(pr, issueBody(ctx, c));
    if (ok) {
      posted++;
      details.push({ path: c.path, line: c.end_line, ok: true, fallbackLevel: 3 });
    } else {
      failed++;
      details.push({ path: c.path, line: c.end_line, ok: false, fallbackLevel: 0 });
    }
  }

  return { posted, failed, skipped: 0, details };
}
