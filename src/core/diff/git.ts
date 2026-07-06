import { spawn } from 'node:child_process';

export interface GitRunOpts {
  cwd: string;
  timeoutMs?: number;
  allowExitCodes?: number[];
}

export async function runGit(args: string[], opts: GitRunOpts): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const allow = opts.allowExitCodes ?? [0];
      if (!allow.includes(code ?? -1)) {
        reject(new Error(`git ${args.join(' ')} exit ${code}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function gitRevParseToplevel(cwd: string): Promise<string> {
  const out = await runGit(['rev-parse', '--show-toplevel'], { cwd });
  return out.trim();
}

export interface DiffOpts {
  repoRoot: string;
  /** 'workspace' | 'staged' | 'commit:<sha>' | '<from>..<to>' */
  range: string;
  paths?: string[];
}

export async function gitDiff(opts: DiffOpts): Promise<string> {
  let args: string[];
  if (opts.range === 'workspace') {
    // tracked changes vs HEAD; untracked 单独处理
    args = ['diff', '--find-renames', '--no-color', '-U3', '--no-ext-diff', 'HEAD'];
  } else if (opts.range === 'staged') {
    args = ['diff', '--find-renames', '--no-color', '-U3', '--no-ext-diff', '--cached'];
  } else if (opts.range.startsWith('commit:')) {
    const sha = opts.range.slice('commit:'.length);
    args = ['diff-tree', '-p', '-r', '--find-renames', '--no-color', '-U3', sha];
  } else {
    const [from, to] = opts.range.split('..');
    if (from && to) {
      const mergeBase = (await runGit(['merge-base', from, to], { cwd: opts.repoRoot })).trim();
      args = ['diff', '--find-renames', '--no-color', '-U3', '--no-ext-diff', mergeBase, to];
    } else {
      args = ['diff', '--find-renames', '--no-color', '-U3', '--no-ext-diff', opts.range];
    }
  }
  if (opts.paths && opts.paths.length > 0) {
    args.push('--', ...opts.paths);
  }
  return runGit(args, { cwd: opts.repoRoot });
}
