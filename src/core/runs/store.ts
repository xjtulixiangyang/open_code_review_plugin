import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir, open, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { FilterFileResult, ReadFilterResultsOutput } from '../model/filter.js';
import type { RelocationFileResult, ReadRelocationResultsOutput } from '../model/relocation.js';
import type { LaunchConfig } from '../orchestrator/types.js';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function rand4(): string {
  let s = '';
  for (let i = 0; i < 4; i++) {
    s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return s;
}

function ts(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

export function newRunId(): string {
  return `${ts()}-${rand4()}`;
}

function worktreeParentRunDir(runId: string): string | null {
  const marker = `${join('.claude', 'worktrees')}/`;
  const cwd = process.cwd();
  const markerIndex = cwd.lastIndexOf(marker);
  if (markerIndex === -1) return null;
  const repoRoot = cwd.slice(0, markerIndex).replace(/\/$/, '');
  if (!repoRoot) return null;
  return join(repoRoot, '.ocr-runs', runId);
}

function containingRunDir(runId: string): string | null {
  const cwd = process.cwd();
  const suffix = `${sep}.ocr-runs${sep}${runId}`;
  const idx = cwd.lastIndexOf(suffix);
  if (idx === -1) return null;
  return cwd.slice(0, idx + suffix.length);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/** 返回 `<cwd>/.ocr-runs/<runId>/` 的绝对路径。若需要不同 root，由调用方在调用前 chdir 即可。 */
export function runDir(runId: string): string {
  return join(process.cwd(), '.ocr-runs', runId);
}

export async function resolveExistingRunDir(runId: string): Promise<string | null> {
  const containing = containingRunDir(runId);
  if (containing && await fileExists(join(containing, 'context.json'))) return containing;
  const current = runDir(runId);
  if (await fileExists(join(current, 'context.json'))) return current;
  const parent = worktreeParentRunDir(runId);
  if (parent && await fileExists(join(parent, 'context.json'))) return parent;
  return null;
}

async function resolveRunDir(runId: string): Promise<string> {
  return await resolveExistingRunDir(runId) ?? runDir(runId);
}

async function ensureDir(p: string): Promise<void> {
  await mkdir(p, { recursive: true });
}

async function appendJsonl(file: string, obj: unknown): Promise<void> {
  await ensureDir(dirname(file));
  // O_APPEND 原子追加 (spec §9 风险表 / §5.1 容错点)
  const fh = await open(file, 'a');
  try {
    await fh.appendFile(JSON.stringify(obj) + '\n', 'utf8');
  } finally {
    await fh.close();
  }
}

export async function writeContext(runId: string, ctx: unknown): Promise<void> {
  const dir = runDir(runId);
  await ensureDir(dir);
  await writeFile(join(dir, 'context.json'), JSON.stringify(ctx, null, 2), 'utf8');
}

export async function readContext<T = unknown>(runId: string): Promise<T> {
  const body = await readFile(join(await resolveRunDir(runId), 'context.json'), 'utf8');
  return JSON.parse(body) as T;
}

export async function appendComment(runId: string, c: unknown): Promise<void> {
  await appendJsonl(join(await resolveRunDir(runId), 'comments.jsonl'), c);
}

export async function readComments<T = unknown>(runId: string): Promise<T[]> {
  const file = join(await resolveRunDir(runId), 'comments.jsonl');
  let body: string;
  try {
    body = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return body
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

export async function writePlan(runId: string, p: unknown): Promise<void> {
  const dir = await resolveRunDir(runId);
  await ensureDir(dir);
  await writeFile(join(dir, 'plan.json'), JSON.stringify(p, null, 2), 'utf8');
}

export async function readPlan<T = unknown>(runId: string): Promise<T | null> {
  try {
    const body = await readFile(join(await resolveRunDir(runId), 'plan.json'), 'utf8');
    return JSON.parse(body) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function writeFilePlan(runId: string, path: string, plan: unknown): Promise<void> {
  const dir = join(await resolveRunDir(runId), 'plans');
  await ensureDir(dir);
  await writeFile(join(dir, `${safePathKey(path)}.json`), JSON.stringify(plan, null, 2), 'utf8');
}

export async function readFilePlan<T = unknown>(runId: string, path: string): Promise<T | null> {
  try {
    const body = await readFile(join(await resolveRunDir(runId), 'plans', `${safePathKey(path)}.json`), 'utf8');
    return JSON.parse(body) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function appendEvent(runId: string, e: object): Promise<void> {
  await appendJsonl(join(await resolveRunDir(runId), 'events.jsonl'), {
    ts: new Date().toISOString(),
    ...e,
  });
}

export async function readEvents<T = unknown>(runId: string): Promise<T[]> {
  const file = join(await resolveRunDir(runId), 'events.jsonl');
  let body: string;
  try {
    body = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return body
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as T];
      } catch {
        return [];
      }
    });
}

export async function markDone(
  runId: string,
  subagent: string,
  file: string,
): Promise<void> {
  const dir = join(await resolveRunDir(runId), 'done');
  await ensureDir(dir);
  await writeFile(
    join(dir, `${subagent}.json`),
    JSON.stringify({ subagent, file, ts: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

export async function listDone(
  runId: string,
): Promise<Array<{ subagent: string; file: string }>> {
  const dir = join(await resolveRunDir(runId), 'done');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Array<{ subagent: string; file: string }> = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const body = await readFile(join(dir, n), 'utf8');
    const j = JSON.parse(body) as { subagent: string; file: string };
    out.push({ subagent: j.subagent, file: j.file });
  }
  return out;
}

export async function writeReport(
  runId: string,
  name: 'report.md' | 'report.json',
  body: string,
): Promise<void> {
  const dir = await resolveRunDir(runId);
  await ensureDir(dir);
  await writeFile(join(dir, name), body, 'utf8');
}

export async function listRunDirsNear(runId: string): Promise<string[]> {
  const candidate = await resolveExistingRunDir(runId);
  const root = dirname(candidate ?? runDir(runId));
  const names = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return names.sort().map((name) => join(root, name));
}

export async function writeLaunchConfig(runId: string, config: LaunchConfig): Promise<void> {
  const dir = runDir(runId);
  await ensureDir(dir);
  await writeFile(join(dir, 'launch.json'), JSON.stringify(config, null, 2), 'utf8');
}

export async function readLaunchConfig(runId: string): Promise<LaunchConfig> {
  const dir = await resolveRunDir(runId);
  return JSON.parse(await readFile(join(dir, 'launch.json'), 'utf8')) as LaunchConfig;
}

const WINDOWS_RESERVED_NAMES = new Set(['con', 'prn', 'aux', 'nul', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9']);

export function safePathKey(path: string): string {
  const encoded = encodeURIComponent(path);
  const segments = path.replace(/\\/g, '/').split('/');
  const reserved = segments.some((segment) => WINDOWS_RESERVED_NAMES.has(segment.replace(/\.[^/.]+$/, '').toLowerCase()));
  if (!reserved && Buffer.byteLength(encoded, 'utf8') <= 200) return encoded;
  const digest = createHash('sha256').update(path, 'utf8').digest('hex');
  const prefix = encoded.slice(0, Math.max(1, 199 - digest.length - 1));
  return `${prefix}-${digest}`;
}

export async function writeFilterResult(runId: string, result: FilterFileResult): Promise<void> {
  const dir = join(await resolveRunDir(runId), 'filters');
  await ensureDir(dir);
  await writeFile(join(dir, `${safePathKey(result.path)}.json`), JSON.stringify(result, null, 2), 'utf8');
}

export async function readFilterResults(runId: string): Promise<ReadFilterResultsOutput> {
  const dir = join(await resolveRunDir(runId), 'filters');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { results: [], warnings: [] };
    throw err;
  }

  const out: ReadFilterResultsOutput = { results: [], warnings: [] };
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = join(dir, n);
    try {
      const body = await readFile(file, 'utf8');
      out.results.push(JSON.parse(body) as FilterFileResult);
    } catch (err) {
      out.warnings.push({
        kind: 'filter_parse_error',
        path: n,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

export async function writeRelocationResult(runId: string, result: RelocationFileResult): Promise<void> {
  const dir = join(await resolveRunDir(runId), 'relocations');
  await ensureDir(dir);
  await writeFile(join(dir, `${safePathKey(result.path)}.json`), JSON.stringify(result, null, 2), 'utf8');
}

export async function readRelocationResults(runId: string): Promise<ReadRelocationResultsOutput> {
  const dir = join(await resolveRunDir(runId), 'relocations');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { results: [], warnings: [] };
    throw err;
  }

  const out: ReadRelocationResultsOutput = { results: [], warnings: [] };
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const file = join(dir, n);
    try {
      const body = await readFile(file, 'utf8');
      out.results.push(JSON.parse(body) as RelocationFileResult);
    } catch (err) {
      out.warnings.push({
        kind: 'relocation_parse_error',
        path: n,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
