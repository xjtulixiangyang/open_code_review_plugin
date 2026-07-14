import * as path from "node:path";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Name of the lock directory inside a run directory. */
const LOCK_DIR_NAME = ".orchestrator.lock";

/** Name of the owner metadata file inside the lock directory. */
const OWNER_FILE = "owner.json";

/** Default lease duration in milliseconds (30 s). */
const DEFAULT_LEASE_MS = 30_000;

/** Maximum number of acquisition attempts before giving up. */
const MAX_ATTEMPTS = 20;

/** Base retry delay in milliseconds. */
const BASE_DELAY_MS = 50;

/** Maximum retry delay in milliseconds. */
const MAX_DELAY_MS = 1_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LockOwner {
  ownerId: string;
  pid: number;
  createdAt: string; // ISO-8601
  expiresAt: string; // ISO-8601
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function lockDirPath(runDir: string): string {
  return path.join(runDir, LOCK_DIR_NAME);
}

function ownerFilePath(runDir: string): string {
  return path.join(lockDirPath(runDir), OWNER_FILE);
}

/**
 * Generate a unique tombstone path for a stale lock directory.
 * The tombstone is placed as a sibling of the lock directory so the rename
 * is an atomic operation on the same filesystem.
 */
function tombstonePath(runDir: string): string {
  return path.join(runDir, `.orchestrator.lock.tombstone.${randomUUID()}`);
}

/**
 * Read and parse the owner.json from a lock directory.
 * Returns `null` if the file does not exist or cannot be parsed.
 */
async function readOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    const raw = await fs.readFile(path.join(lockDir, OWNER_FILE), "utf-8");
    return JSON.parse(raw) as LockOwner;
  } catch {
    return null;
  }
}

/**
 * Check whether a lock owner is still valid (not expired).
 */
function isOwnerValid(owner: LockOwner): boolean {
  return Date.parse(owner.expiresAt) > Date.now();
}

/**
 * Write the owner.json file into an already-created lock directory.
 */
async function writeOwner(lockDir: string, owner: LockOwner): Promise<void> {
  await fs.writeFile(
    path.join(lockDir, OWNER_FILE),
    JSON.stringify(owner, null, 2) + "\n",
    "utf-8",
  );
}

/**
 * Build a LockOwner object for the current contender.
 */
function makeOwner(ownerId: string, leaseMs: number): LockOwner {
  const now = Date.now();
  return {
    ownerId,
    pid: process.pid,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + leaseMs).toISOString(),
  };
}

/**
 * Create a temporary directory with owner.json inside it, then atomically
 * rename it to the lock directory name.
 *
 * This avoids the race between mkdir and writeOwner: the owner.json is
 * written before the rename, so any contender that sees the lock directory
 * also sees a complete owner.json.
 */
async function createLockDir(
  lockDir: string,
  owner: LockOwner,
): Promise<boolean> {
  // Create a unique temp directory as a sibling of the target
  const tmpDir = lockDir + ".tmp." + randomUUID();
  try {
    await fs.mkdir(tmpDir, { recursive: false });
    await writeOwner(tmpDir, owner);
    // Atomic rename: the temp dir (with owner.json inside) becomes the lock dir
    await fs.rename(tmpDir, lockDir);
    return true;
  } catch {
    // Clean up temp dir on any failure
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return false;
  }
}

/**
 * Try to acquire the lock by creating the lock directory atomically.
 *
 * - If createLockDir succeeds, we own the lock. Return true.
 * - If createLockDir fails with EEXIST, someone else holds it (or it's stale).
 *   Read owner.json: if stale, attempt atomic rename to a tombstone.
 *   If rename succeeds, retry createLockDir. If rename fails, someone else
 *   took it.
 * - Other errors are propagated.
 */
async function tryAcquire(
  runDir: string,
  ownerId: string,
  leaseMs: number,
): Promise<boolean> {
  const lockDir = lockDirPath(runDir);
  const owner = makeOwner(ownerId, leaseMs);

  // Attempt 1: create lock dir atomically (mkdir + owner.json via rename)
  const created = await createLockDir(lockDir, owner);
  if (created) return true;

  // createLockDir failed — lock dir may exist. Check if it's stale.
  const existing = await readOwner(lockDir);
  if (existing !== null && isOwnerValid(existing)) {
    // Lock is held by a valid owner — cannot acquire.
    return false;
  }

  // Lock is stale (or owner.json is missing/unparseable).
  // Attempt atomic rename of the entire lock directory to a tombstone.
  const tombstone = tombstonePath(runDir);
  try {
    await fs.rename(lockDir, tombstone);
  } catch {
    // rename failed — someone else took over the stale lock or removed it.
    return false;
  }

  // We successfully renamed the stale lock to a tombstone.
  // Now try createLockDir again. If it succeeds, we own the lock and will
  // clean up the tombstone ourselves. If it fails, someone else raced past.
  const claimed = await createLockDir(lockDir, owner);
  if (claimed) {
    // Clean up our tombstone — we are the winner.
    await fs.rm(tombstone, { recursive: true, force: true }).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Acquire the lock with bounded retry and jitter.
 *
 * Throws if the lock cannot be acquired within the retry budget.
 */
async function acquire(
  runDir: string,
  ownerId: string,
  leaseMs: number,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const acquired = await tryAcquire(runDir, ownerId, leaseMs);
    if (acquired) return;

    // Bounded exponential backoff with jitter
    const delay = Math.min(
      BASE_DELAY_MS * Math.pow(1.5, attempt) + Math.random() * BASE_DELAY_MS,
      MAX_DELAY_MS,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }

  throw Object.assign(
    new Error(
      `Could not acquire lock for ${runDir} after ${MAX_ATTEMPTS} attempts`,
    ),
    { code: "LOCK_BUSY" },
  );
}

/** Renew the lock lease only while the same owner still holds it. */
async function renewIfOwner(runDir: string, ownerId: string, leaseMs: number): Promise<void> {
  const lockDir = lockDirPath(runDir);
  const owner = await readOwner(lockDir);
  if (!owner || owner.ownerId !== ownerId) return;
  owner.expiresAt = new Date(Date.now() + leaseMs).toISOString();
  await writeOwner(lockDir, owner);
}

/**
 * Release the lock if we are still the owner.
 *
 * Reads owner.json; if the ownerId matches, removes the lock directory.
 * If the ownerId does not match (e.g. our lease expired and someone else
 * took over), this is a no-op — the new owner is responsible.
 *
 * Non-ENOENT errors are propagated (not swallowed).
 */
async function releaseIfOwner(
  runDir: string,
  ownerId: string,
): Promise<void> {
  const lockDir = lockDirPath(runDir);
  let owner: LockOwner | null;
  try {
    owner = await readOwner(lockDir);
  } catch (err: unknown) {
    // ENOENT means the lock directory is already gone — nothing to do.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }

  if (owner === null || owner.ownerId !== ownerId) {
    // Not our lock anymore — someone else took over.
    return;
  }

  // We are still the owner — remove the lock directory.
  // Use force:true to handle the case where another process's fs.rm races
  // with our own — rmdir can fail with ENOTEMPTY if the directory was
  // replaced between stat and unlink.
  await fs.rm(lockDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a function while holding an exclusive, non-reentrant filesystem
 * lock on the given run directory.
 *
 * The lock is implemented via mkdir atomicity (`.orchestrator.lock/`) with
 * an `owner.json` containing a random UUID, PID, creation time, and expiry.
 *
 * **Stale lock recovery**: If the lock directory exists but its owner has
 * expired, the contender atomically renames the entire directory to a unique
 * tombstone path and then creates a fresh lock directory.  Only the
 * contender that successfully renamed the stale directory removes its
 * tombstone; orphaned tombstones are inert and can be cleaned up lazily.
 *
 * **Retry with jitter**: If the lock is held by a valid owner, the caller
 * retries with bounded exponential backoff (50 ms base, 1 s max, up to 20
 * attempts) before throwing `LOCK_BUSY`.
 *
 * **Non-reentrant**: If `fn` attempts to call `withRunLock` again on the
 * same `runDir`, it throws `LOCK_REENTRY` immediately.  Re-entrancy is
 * detected by tracking held locks in a process-local Set.
 */
export async function withRunLock<T>(
  runDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  // Non-reentrancy check (process-local)
  if (heldLocks.has(runDir)) {
    throw Object.assign(
      new Error(
        `Non-reentrant lock violation: lock already held for ${runDir}`,
      ),
      { code: "LOCK_REENTRY" },
    );
  }

  // Serialize acquire/release per-directory so that a release from a previous
  // call finishes before the next call starts acquiring.  This prevents races
  // between fs.rm in releaseIfOwner and fs.rename in createLockDir.
  const prev = serialQueues.get(runDir) ?? Promise.resolve();
  let releaseNext!: () => void;
  const next = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  serialQueues.set(runDir, next);

  // Wait for the previous operation to fully complete (including release)
  await prev;

  let ownerId: string | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    ownerId = randomUUID();
    await acquire(runDir, ownerId, DEFAULT_LEASE_MS);

    heldLocks.add(runDir);
    const heartbeatOwnerId = ownerId;
    heartbeat = setInterval(() => {
      void renewIfOwner(runDir, heartbeatOwnerId, DEFAULT_LEASE_MS);
    }, Math.floor(DEFAULT_LEASE_MS / 3));
    heartbeat.unref();

    try {
      return await operation();
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      heldLocks.delete(runDir);
      if (ownerId) {
        await releaseIfOwner(runDir, ownerId);
      }
    }
  } finally {
    // Signal that this operation (including release or failure) is done.
    releaseNext();
    if (serialQueues.get(runDir) === next) serialQueues.delete(runDir);
  }
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const heldLocks: Set<string> = new Set();

/**
 * Per-directory serialization queue.
 * Maps runDir to a promise that resolves when the previous acquire/release
 * cycle for that directory has completed.
 */
const serialQueues = new Map<string, Promise<void>>();
