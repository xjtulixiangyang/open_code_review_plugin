import * as path from "node:path";
import * as fs from "node:fs/promises";
import writeFileAtomic from "write-file-atomic";
import type { AuditEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function auditLogPath(runDir: string): string {
  return path.join(runDir, "audit.jsonl");
}

function lockDirPath(runDir: string): string {
  return path.join(runDir, ".lock");
}

/**
 * Acquire a filesystem lock for the given run directory using mkdir.
 *
 * mkdir is atomic on all major platforms, so this is safe against concurrent
 * processes/threads. Returns `true` if the lock was acquired, `false` if it
 * was already held.
 */
async function acquireLock(runDir: string): Promise<boolean> {
  const lockDir = lockDirPath(runDir);
  try {
    await fs.mkdir(lockDir, { recursive: false });
    // Write PID for diagnostics (best-effort)
    await fs
      .writeFile(path.join(lockDir, "pid"), String(process.pid), "utf-8")
      .catch(() => {});
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

/**
 * Release a filesystem lock for the given run directory.
 */
async function releaseLock(runDir: string): Promise<void> {
  const lockDir = lockDirPath(runDir);
  await fs.rm(lockDir, { recursive: true, force: false });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append an AuditEvent to the run's audit log using an atomic write.
 *
 * Uses write-file-atomic to avoid the partial-write visibility window.
 * Because write-file-atomic does not support true append, we read existing
 * content, append the new line, and write the full content atomically.
 */
export async function appendAuditEvent(
  runDir: string,
  event: AuditEvent,
): Promise<void> {
  const logPath = auditLogPath(runDir);
  const line = JSON.stringify(event) + "\n";

  let existing = "";
  try {
    existing = await fs.readFile(logPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  await writeFileAtomic(logPath, existing + line, "utf-8");
}

/**
 * Read all audit events from a run's audit log, in order.
 *
 * Returns an empty array if the file does not exist.
 */
export async function readAuditEvents(
  runDir: string,
): Promise<AuditEvent[]> {
  const logPath = auditLogPath(runDir);

  let content: string;
  try {
    content = await fs.readFile(logPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }

  const events: AuditEvent[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    events.push(JSON.parse(trimmed) as AuditEvent);
  }
  return events;
}

/**
 * Execute a function while holding an exclusive, non-reentrant filesystem
 * lock on the given run directory.
 *
 * The lock is implemented via mkdir atomicity and is visible to all processes
 * on the same filesystem. If the lock is already held (by this process or
 * another), the call throws immediately.
 *
 * This function is **non-reentrant**: if `fn` attempts to call `withRunLock`
 * again on the same `runDir`, it will throw with a `LOCK_REENTRY` error.
 * Re-entrancy is detected by tracking held locks in a process-local Set.
 */
export async function withRunLock<T>(
  runDir: string,
  fn: () => Promise<T>,
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

  // Acquire filesystem lock
  const acquired = await acquireLock(runDir);
  if (!acquired) {
    throw Object.assign(
      new Error(
        `Could not acquire lock for ${runDir}: lock is held by another process`,
      ),
      { code: "LOCK_BUSY" },
    );
  }

  heldLocks.add(runDir);

  try {
    return await fn();
  } finally {
    heldLocks.delete(runDir);
    await releaseLock(runDir).catch(() => {
      // Swallow cleanup errors
    });
  }
}

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const heldLocks: Set<string> = new Set();
