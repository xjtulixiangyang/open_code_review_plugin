import { spawn } from 'node:child_process';

export interface GitSplitOpts {
  cwd: string;
  timeoutMs?: number;
  allowExitCodes?: number[];
}

export interface GitSplitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function runGitSplit(args: string[], opts: GitSplitOpts): Promise<GitSplitResult> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`git ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const actualCode = code ?? -1;
      const allow = opts.allowExitCodes ?? [0];
      if (!allow.includes(actualCode)) {
        reject(new Error(`git ${args.join(' ')} exit ${actualCode}: ${stderr.trim()}`));
        return;
      }
      resolve({ stdout, stderr, code: actualCode });
    });
  });
}
