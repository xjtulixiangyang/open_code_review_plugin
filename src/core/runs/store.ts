import { mkdir, writeFile, readFile, readdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FilterFileResult, ReadFilterResultsOutput } from '../model/filter.js';

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

/** 返回 `<cwd>/.ocr-runs/<runId>/` 的绝对路径。若需要不同 root，由调用方在调用前 chdir 即可。 */
export function runDir(runId: string): string {
  return join(process.cwd(), '.ocr-runs', runId);
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
  const body = await readFile(join(runDir(runId), 'context.json'), 'utf8');
  return JSON.parse(body) as T;
}

export async function appendComment(runId: string, c: unknown): Promise<void> {
  await appendJsonl(join(runDir(runId), 'comments.jsonl'), c);
}

export async function readComments<T = unknown>(runId: string): Promise<T[]> {
  const file = join(runDir(runId), 'comments.jsonl');
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
  const dir = runDir(runId);
  await ensureDir(dir);
  await writeFile(join(dir, 'plan.json'), JSON.stringify(p, null, 2), 'utf8');
}

export async function readPlan<T = unknown>(runId: string): Promise<T | null> {
  try {
    const body = await readFile(join(runDir(runId), 'plan.json'), 'utf8');
    return JSON.parse(body) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export async function appendEvent(runId: string, e: object): Promise<void> {
  await appendJsonl(join(runDir(runId), 'events.jsonl'), {
    ts: new Date().toISOString(),
    ...e,
  });
}

export async function markDone(
  runId: string,
  subagent: string,
  file: string,
): Promise<void> {
  const dir = join(runDir(runId), 'done');
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
  const dir = join(runDir(runId), 'done');
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
  const dir = runDir(runId);
  await ensureDir(dir);
  await writeFile(join(dir, name), body, 'utf8');
}

export function safePathKey(path: string): string {
  return encodeURIComponent(path);
}

export async function writeFilterResult(runId: string, result: FilterFileResult): Promise<void> {
  const dir = join(runDir(runId), 'filters');
  await ensureDir(dir);
  await writeFile(join(dir, `${safePathKey(result.path)}.json`), JSON.stringify(result, null, 2), 'utf8');
}

export async function readFilterResults(runId: string): Promise<ReadFilterResultsOutput> {
  const dir = join(runDir(runId), 'filters');
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
