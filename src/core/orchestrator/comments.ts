import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommentRecord } from '../model/comment.js';
import { readComments, resolveExistingRunDir } from '../runs/store.js';
import { Orchestrator } from './orchestrator.js';
import { ORCHESTRATOR_SCHEMA_VERSION } from './types.js';

/** Read the authoritative comment view for post-processing. */
export async function readReviewComments(runId: string): Promise<CommentRecord[]> {
  const runDir = await resolveExistingRunDir(runId);
  if (!runDir) return readComments<CommentRecord>(runId);

  let raw: string;
  try {
    raw = await readFile(join(runDir, 'run.json'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return readComments<CommentRecord>(runId);
    }
    throw err;
  }

  const run = JSON.parse(raw) as { schemaVersion?: unknown };
  if (run.schemaVersion !== ORCHESTRATOR_SCHEMA_VERSION) {
    throw new Error(`Unsupported orchestrator schemaVersion: ${String(run.schemaVersion)}`);
  }
  return (await new Orchestrator(runDir).readAcceptedComments()).comments;
}
