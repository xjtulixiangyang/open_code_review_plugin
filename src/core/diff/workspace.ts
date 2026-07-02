import { spawn } from 'node:child_process';
import { runGit, gitDiff } from './git.js';

async function rawGitDiffNoIndex(repoRoot: string, file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['diff', '--no-color', '-U3', '--no-index', '--', '/dev/null', file], {
      cwd: repoRoot,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      // 0 = 无差异, 1 = 有差异（正常），其他视为错误
      if (code === 0 || code === 1) resolve(stdout);
      else reject(new Error(`git diff --no-index exit ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * 等价于 OCR `workspace` 模式：tracked 改动 + untracked 文件（作为"新增"）拼成一份 unified diff。
 * untracked 文件通过 `git diff --no-index /dev/null <file>` 生成 diff。
 */
export async function collectWorkspaceDiff(repoRoot: string, paths?: string[]): Promise<string> {
  const tracked = await gitDiff({ repoRoot, range: 'workspace', paths });

  // 列 untracked 文件
  const lsArgs = ['ls-files', '--others', '--exclude-standard'];
  if (paths && paths.length > 0) lsArgs.push('--', ...paths);
  const lsOut = await runGit(lsArgs, { cwd: repoRoot });
  const untracked = lsOut.split('\n').map((s) => s.trim()).filter(Boolean);

  let extra = '';
  for (const f of untracked) {
    extra += await rawGitDiffNoIndex(repoRoot, f);
  }
  return tracked + extra;
}
