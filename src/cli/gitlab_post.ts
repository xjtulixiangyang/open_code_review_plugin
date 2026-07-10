import { spawn } from 'node:child_process';
import type { CommentRecord } from '../core/model/comment.js';
import type { ReviewContext } from '../core/model/request.js';
import type { PostDetail, PostResult } from './github_post.js';

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface MrVersion {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

function exec(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }));
    p.on('error', (e) => resolve({ ok: false, stdout, stderr: e.message }));
  });
}

async function getMrVersion(projectId: string, pr: string, token: string): Promise<MrVersion> {
  const r = await exec('curl', [
    '--silent',
    '--show-error',
    '--header',
    `PRIVATE-TOKEN: ${token}`,
    `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/${pr}/versions`,
  ]);
  if (!r.ok) throw new Error(`Failed to fetch MR versions: ${r.stderr}`);
  const data = JSON.parse(r.stdout) as Array<{
    base_commit_sha: string;
    start_commit_sha: string;
    head_commit_sha: string;
  }>;
  if (data.length === 0) throw new Error('No MR versions found');
  const latest = data[data.length - 1];
  return {
    base_sha: latest.base_commit_sha,
    start_sha: latest.start_commit_sha,
    head_sha: latest.head_commit_sha,
  };
}

function body(ctx: ReviewContext, c: CommentRecord): string {
  let out = `**${ctx.range}** · \`${c.path}:${c.start_line}-${c.end_line}\`\n\n${c.content}`;
  if (c.suggestion_code) {
    out += `\n\n\`\`\`suggestion\n${c.suggestion_code}\n\`\`\``;
  }
  return out;
}

async function postDiscussion(
  projectId: string,
  pr: string,
  token: string,
  version: MrVersion,
  ctx: ReviewContext,
  comment: CommentRecord,
): Promise<boolean> {
  const args = [
    '--silent',
    '--show-error',
    '--request',
    'POST',
    `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/${pr}/discussions`,
    '--header',
    `PRIVATE-TOKEN: ${token}`,
  ];
  const fields: Array<[string, string]> = [
    ['body', body(ctx, comment)],
    ['position[position_type]', 'text'],
    ['position[new_path]', comment.path],
    ['position[old_path]', comment.path],
    ['position[new_line]', String(comment.end_line)],
    ['position[base_sha]', version.base_sha],
    ['position[start_sha]', version.start_sha],
    ['position[head_sha]', version.head_sha],
  ];
  for (const [key, value] of fields) {
    args.push('--data-urlencode', `${key}=${value}`);
  }
  const r = await exec('curl', args);
  return r.ok;
}

async function postNote(projectId: string, pr: string, token: string, ctx: ReviewContext, comment: CommentRecord): Promise<boolean> {
  const r = await exec('curl', [
    '--silent',
    '--show-error',
    '--request',
    'POST',
    `https://gitlab.com/api/v4/projects/${projectId}/merge_requests/${pr}/notes`,
    '--header',
    `PRIVATE-TOKEN: ${token}`,
    '--data-urlencode',
    `body=${body(ctx, comment)}`,
  ]);
  return r.ok;
}

export async function gitlabPostComments(
  comments: CommentRecord[],
  ctx: ReviewContext,
  pr: string,
  token: string,
  projectId: string,
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
  let version: MrVersion;
  try {
    version = await getMrVersion(projectId, pr, token);
  } catch {
    return {
      posted: 0,
      failed: comments.length,
      skipped: 0,
      details: comments.map((c) => ({ path: c.path, line: c.end_line, ok: false, fallbackLevel: 0 })),
    };
  }

  const details: PostDetail[] = [];
  let posted = 0;
  let failed = 0;

  for (const c of comments) {
    let ok = false;
    for (let attempt = 0; attempt <= retry; attempt++) {
      ok = await postDiscussion(projectId, pr, token, version, ctx, c);
      if (ok) break;
    }
    if (ok) {
      posted++;
      details.push({ path: c.path, line: c.end_line, ok: true, fallbackLevel: 1 });
      continue;
    }

    ok = await postNote(projectId, pr, token, ctx, c);
    if (ok) {
      posted++;
      details.push({ path: c.path, line: c.end_line, ok: true, fallbackLevel: 2 });
    } else {
      failed++;
      details.push({ path: c.path, line: c.end_line, ok: false, fallbackLevel: 0 });
    }
  }

  return { posted, failed, skipped: 0, details };
}
