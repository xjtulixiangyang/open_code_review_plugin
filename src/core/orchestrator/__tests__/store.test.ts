import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAuditEvent,
  readAuditEvents,
  withRunLock,
} from "../store.js";
import type { AuditEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "orc-store-"));
  tempDirs.push(d);
  return d;
}

after(async () => {
  for (const d of tempDirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

function makeEvent(seq: number, kind = "test"): AuditEvent {
  return {
    schemaVersion: 1,
    eventId: `evt-${seq}`,
    type: kind,
    ts: new Date().toISOString(),
    runId: "test-run",
    data: { seq },
  };
}

// ---------------------------------------------------------------------------
// appendAuditEvent / readAuditEvents
// ---------------------------------------------------------------------------

describe("appendAuditEvent / readAuditEvents", () => {
  test("writes a single event and reads it back", async () => {
    const runDir = await tmpDir();
    const event = makeEvent(1);
    await appendAuditEvent(runDir, event);

    const events = await readAuditEvents(runDir);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventId, "evt-1");
  });

  test("appends multiple events in order", async () => {
    const runDir = await tmpDir();
    await appendAuditEvent(runDir, makeEvent(1));
    await appendAuditEvent(runDir, makeEvent(2));
    await appendAuditEvent(runDir, makeEvent(3));

    const events = await readAuditEvents(runDir);
    assert.equal(events.length, 3);
    assert.equal(events[0].eventId, "evt-1");
    assert.equal(events[1].eventId, "evt-2");
    assert.equal(events[2].eventId, "evt-3");
  });

  test("returns empty array when no events exist", async () => {
    const runDir = await tmpDir();
    const events = await readAuditEvents(runDir);
    assert.deepEqual(events, []);
  });

  test("writes valid JSONL (one JSON object per line)", async () => {
    const runDir = await tmpDir();
    await appendAuditEvent(runDir, makeEvent(1));
    await appendAuditEvent(runDir, makeEvent(2));

    const raw = await readFile(join(runDir, "audit.jsonl"), "utf-8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 2);

    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });
});

// ---------------------------------------------------------------------------
// withRunLock
// ---------------------------------------------------------------------------

describe("withRunLock", () => {
  test("executes the function and returns its value", async () => {
    const runDir = await tmpDir();
    const result = await withRunLock(runDir, async () => "hello");
    assert.equal(result, "hello");
  });

  test("releases the lock after successful execution", async () => {
    const runDir = await tmpDir();
    await withRunLock(runDir, async () => "ok");
    // Acquiring again should succeed (lock was released)
    await withRunLock(runDir, async () => "again");
  });

  test("releases the lock when the function throws", async () => {
    const runDir = await tmpDir();
    const err = new Error("fn error");
    await assert.rejects(
      withRunLock(runDir, async () => {
        throw err;
      }),
      err,
    );

    // Lock should be released — we can acquire it again
    await withRunLock(runDir, async () => "recovered");
  });

  test("is non-reentrant (throws LOCK_REENTRY on re-entry)", async () => {
    const runDir = await tmpDir();
    await assert.rejects(
      withRunLock(runDir, async () => {
        await withRunLock(runDir, async () => "nested");
      }),
      { code: "LOCK_REENTRY" },
    );
  });

  test("throws LOCK_BUSY when another process holds the lock", async () => {
    const runDir = await tmpDir();
    const lockDir = join(runDir, ".lock");
    await mkdir(lockDir, { recursive: true });

    await assert.rejects(
      withRunLock(runDir, async () => "should not run"),
      { code: "LOCK_BUSY" },
    );
  });

  test("cleans up the lock directory after execution", async () => {
    const runDir = await tmpDir();
    await withRunLock(runDir, async () => "done");
    const lockDir = join(runDir, ".lock");
    await assert.rejects(
      // The lock directory should not exist
      readFile(join(lockDir, "pid"), "utf-8"),
      { code: "ENOENT" },
    );
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
});
