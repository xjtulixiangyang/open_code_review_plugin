import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRunLock } from "../lock.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "orc-lock-"));
  tempDirs.push(d);
  return d;
}

after(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// withRunLock
// ---------------------------------------------------------------------------

describe("withRunLock", () => {
  test("executes the function and returns its value", async () => {
    const dir = await tmpDir();
    const result = await withRunLock(dir, async () => "hello");
    assert.equal(result, "hello");
  });

  test("releases the lock after successful execution", async () => {
    const dir = await tmpDir();
    await withRunLock(dir, async () => "ok");
    // Acquiring again should succeed (lock was released)
    await withRunLock(dir, async () => "again");
  });

  test("releases the lock when the function throws", async () => {
    const dir = await tmpDir();
    const err = new Error("fn error");
    await assert.rejects(
      withRunLock(dir, async () => {
        throw err;
      }),
      err,
    );

    // Lock should be released — we can acquire it again
    await withRunLock(dir, async () => "recovered");
  });

  test("is non-reentrant (throws LOCK_REENTRY on re-entry)", async () => {
    const dir = await tmpDir();
    await assert.rejects(
      withRunLock(dir, async () => {
        await withRunLock(dir, async () => "nested");
      }),
      { code: "LOCK_REENTRY" },
    );
  });

  test("only one concurrent mutation enters the critical section", async () => {
    const dir = await tmpDir();
    let inside = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        withRunLock(dir, async () => {
          inside += 1;
          peak = Math.max(peak, inside);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inside -= 1;
        }),
      ),
    );

    assert.equal(peak, 1);
  });

  test("supports concurrent locks on different directories", async () => {
    const dirA = await tmpDir();
    const dirB = await tmpDir();

    const [resultA, resultB] = await Promise.all([
      withRunLock(dirA, async () => "A"),
      withRunLock(dirB, async () => "B"),
    ]);
    assert.equal(resultA, "A");
    assert.equal(resultB, "B");
  });

  test("uses .orchestrator.lock directory", async () => {
    const dir = await tmpDir();
    await withRunLock(dir, async () => "done");

    // Lock directory should be cleaned up
    const lockDir = join(dir, ".orchestrator.lock");
    await assert.rejects(readFile(join(lockDir, "owner.json"), "utf-8"), {
      code: "ENOENT",
    });
  });

  test("owner-preserving release: does not remove lock if owner changed", async () => {
    const dir = await tmpDir();
    const lockDir = join(dir, ".orchestrator.lock");

    // Manually create a lock with a different owner
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({
        ownerId: "other-owner",
        pid: 99999,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      "utf-8",
    );

    // Try to acquire — should fail with LOCK_BUSY (valid owner)
    await assert.rejects(
      withRunLock(dir, async () => "should not run"),
      { code: "LOCK_BUSY" },
    );

    // The lock directory should still exist (not removed by failed acquire)
    const owner = JSON.parse(
      await readFile(join(lockDir, "owner.json"), "utf-8"),
    );
    assert.equal(owner.ownerId, "other-owner");
  });

  test("stale takeover: acquires lock after owner expires", async () => {
    const dir = await tmpDir();
    const lockDir = join(dir, ".orchestrator.lock");

    // Manually create a stale lock (expired 10 seconds ago)
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({
        ownerId: "stale-owner",
        pid: 99999,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        expiresAt: new Date(Date.now() - 10_000).toISOString(),
      }),
      "utf-8",
    );

    // Should successfully acquire (stale lock is taken over)
    await withRunLock(dir, async () => "took over stale lock");

    // Lock directory should be cleaned up
    await assert.rejects(readFile(join(lockDir, "owner.json"), "utf-8"), {
      code: "ENOENT",
    });
  });

  test("stale takeover: tombstone is cleaned up by winner", async () => {
    const dir = await tmpDir();
    const lockDir = join(dir, ".orchestrator.lock");

    // Create a stale lock
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({
        ownerId: "stale-owner",
        pid: 99999,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        expiresAt: new Date(Date.now() - 10_000).toISOString(),
      }),
      "utf-8",
    );

    // Acquire (triggers stale takeover)
    await withRunLock(dir, async () => "done");

    // No tombstone files should remain
    const entries = await readFile(
      "/dev/null",
    ).catch(() => []); // just a noop

    // List directory to check for tombstones
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    const tombstones = files.filter((f) =>
      f.startsWith(".orchestrator.lock.tombstone."),
    );
    assert.equal(tombstones.length, 0);
  });

  test("LOCK_BUSY when lock is held by valid owner", async () => {
    const dir = await tmpDir();
    const lockDir = join(dir, ".orchestrator.lock");

    // Manually create a valid lock
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, "owner.json"),
      JSON.stringify({
        ownerId: "valid-owner",
        pid: 99999,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      "utf-8",
    );

    await assert.rejects(
      withRunLock(dir, async () => "should not run"),
      { code: "LOCK_BUSY" },
    );
  });
});
