import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReviewContext, FileChange } from '../model/request.js';
import type { LaunchConfig, ReviewManifest, ManifestFile } from './types.js';
import { ORCHESTRATOR_SCHEMA_VERSION } from './types.js';

// ---------------------------------------------------------------------------
// Canonical JSON serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a value to canonical JSON: object keys are sorted recursively,
 * array order is preserved, no extra whitespace.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, sortKeys);
}

function sortKeys(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

// ---------------------------------------------------------------------------
// SHA-256 hashing
// ---------------------------------------------------------------------------

/**
 * Return the hex-encoded SHA-256 digest of a string.
 */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Repository identity
// ---------------------------------------------------------------------------

/**
 * Compute a stable repository identity by hashing:
 * - Normalized repo root
 * - Origin URL (if present)
 * - Current HEAD commit
 */
export async function repositoryIdentity(repoRoot: string): Promise<string> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);

  const normRoot = repoRoot.replace(/\/+$/, '').toLowerCase();

  let originUrl = '';
  try {
    const { stdout } = await execFileAsync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: repoRoot,
      timeout: 5000,
    });
    originUrl = stdout.trim();
  } catch {
    // No origin URL — that's fine
  }

  let headHash = '';
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      timeout: 5000,
    });
    headHash = stdout.trim();
  } catch {
    // No HEAD — empty repo
  }

  const h = createHash('sha256');
  h.update(normRoot, 'utf8');
  h.update('\0', 'utf8');
  h.update(originUrl, 'utf8');
  h.update('\0', 'utf8');
  h.update(headHash, 'utf8');
  return h.digest('hex');
}

// ---------------------------------------------------------------------------
// File fingerprint
// ---------------------------------------------------------------------------

/**
 * Compute the fingerprint for a single file's diff.
 * Hashes the canonical form of { path, oldPath, status, diff, truncated }.
 */
export function fileFingerprint(file: FileChange): string {
  const entry: Record<string, unknown> = {
    path: file.path,
    status: file.status,
    diff: file.diff,
    truncated: file.truncated,
  };
  if (file.oldPath) {
    entry.oldPath = file.oldPath;
  }
  return sha256(canonicalJson(entry));
}

// ---------------------------------------------------------------------------
// Full diff fingerprint
// ---------------------------------------------------------------------------

/**
 * Compute the full diff fingerprint by hashing canonical ordered entries.
 * Each entry is { path, oldPath, status, diff, truncated }.
 * This approach is unambiguous across file boundaries because each file's
 * data is a separate object in an array, not concatenated strings.
 */
export function fullDiffFingerprint(files: FileChange[]): string {
  const entries = files.map((f) => {
    const entry: Record<string, unknown> = {
      path: f.path,
      status: f.status,
      diff: f.diff,
      truncated: f.truncated,
    };
    if (f.oldPath) {
      entry.oldPath = f.oldPath;
    }
    return entry;
  });
  return sha256(canonicalJson(entries));
}

// ---------------------------------------------------------------------------
// Args fingerprint
// ---------------------------------------------------------------------------

/**
 * Compute the arguments fingerprint by hashing the canonical form of the
 * LaunchConfig (excluding concurrency which is runtime-only).
 */
export function argsFingerprint(launch: LaunchConfig): string {
  // Only hash the semantically meaningful fields for resume matching
  const relevant: Record<string, unknown> = {
    schemaVersion: launch.schemaVersion,
    mode: launch.mode,
  };
  if (launch.commit !== undefined) relevant.commit = launch.commit;
  if (launch.from !== undefined) relevant.from = launch.from;
  if (launch.to !== undefined) relevant.to = launch.to;
  if (launch.paths !== undefined) relevant.paths = launch.paths;
  if (launch.background !== undefined) relevant.background = launch.background;
  if (launch.rulesPath !== undefined) relevant.rulesPath = launch.rulesPath;
  if (launch.plansPath !== undefined) relevant.plansPath = launch.plansPath;
  if (launch.format !== undefined) relevant.format = launch.format;
  if (launch.maxAttempts !== undefined) relevant.maxAttempts = launch.maxAttempts;
  if (launch.leaseDurationMs !== undefined) relevant.leaseDurationMs = launch.leaseDurationMs;
  return sha256(canonicalJson(relevant));
}

// ---------------------------------------------------------------------------
// Manifest building
// ---------------------------------------------------------------------------

/**
 * Build an immutable ReviewManifest from the review context and launch config.
 *
 * The manifest captures the exact state of the review at start time:
 * - Repository identity
 * - Arguments fingerprint
 * - Full diff fingerprint (sensitive to file order)
 * - Per-file fingerprints and metadata
 */
export function buildManifest(
  context: ReviewContext,
  launch: LaunchConfig,
  effectiveRunId: string,
  repoIdentity: string,
): ReviewManifest {
  const files: ManifestFile[] = context.files.map((f, i) => {
    const diff = f.diff;
    const changedLines = diff
      .split('\n')
      .filter((line) => line.startsWith('+') || line.startsWith('-'))
      .length;

    return {
      manifestIndex: i,
      path: f.path,
      diffFingerprint: fileFingerprint(f),
      changedLines,
      status: f.status,
    };
  });

  const excludedFiles = (context.excludedFiles ?? []).map((ef) => ({
    path: ef.path,
    reason: ef.reason,
  }));

  return {
    schemaVersion: ORCHESTRATOR_SCHEMA_VERSION,
    runId: effectiveRunId,
    repoIdentity,
    argsFingerprint: argsFingerprint(launch),
    diffFingerprint: fullDiffFingerprint(context.files),
    files,
    excludedFiles,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Manifest digest
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic digest of the entire manifest for integrity checking.
 */
export function manifestDigest(manifest: ReviewManifest): string {
  return sha256(canonicalJson(manifest));
}
