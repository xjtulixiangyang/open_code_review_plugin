import { readFile, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

export interface LoadedPlansGuidance {
  sourceKind: 'cli' | 'repo' | 'user' | 'none';
  source?: string;
  text: string;
}

export interface LoadPlansGuidanceOptions {
  homeDir?: string;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function readPlansFile(
  absPath: string,
  source: string,
  sourceKind: 'cli' | 'repo' | 'user',
): Promise<LoadedPlansGuidance> {
  let text: string;
  try {
    text = await readFile(absPath, 'utf8');
  } catch (err) {
    throw new Error(`OCRP-PLANS-100: cannot read plans file ${source}: ${(err as Error).message}`);
  }
  return { sourceKind, source, text };
}

export async function loadPlansGuidance(
  repoRoot: string,
  plansPath?: string,
  opts: LoadPlansGuidanceOptions = {},
): Promise<LoadedPlansGuidance> {
  if (plansPath) {
    const abs = isAbsolute(plansPath) ? plansPath : join(repoRoot, plansPath);
    return readPlansFile(abs, plansPath, 'cli');
  }

  const repoDefault = join(repoRoot, '.code-review-plans.md');
  if (await exists(repoDefault)) {
    return readPlansFile(repoDefault, '.code-review-plans.md', 'repo');
  }

  const home = opts.homeDir ?? homedir();
  const userDefault = join(home, '.code-review', 'plans.md');
  if (await exists(userDefault)) {
    return readPlansFile(userDefault, '~/.code-review/plans.md', 'user');
  }

  return { sourceKind: 'none', text: '' };
}
