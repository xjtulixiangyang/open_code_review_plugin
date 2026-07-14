import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, readJson, appendAuditEvent } from "../storage.js";
import { withRunLock } from "../lock.js";
import type { AuditEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function tmpDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "orc-storage-"));
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
// atomicWriteJson / readJson
// ---------------------------------------------------------------------------

describe("atomicWriteJson / readJson", () => {
  test("writes and reads back a JSON value", async () => {
    const dir = await tmpDir();
    const file = join(dir, "config.json");
    const value = { name: "test", count: 42 };

    await atomicWriteJson(file, value);
    const loaded = await readJson<typeof value>(file);
    assert.deepEqual(loaded, value);
  });

  test("replacement leaves valid JSON (no partial writes)", async () => {
    const dir = await tmpDir();
    const file = join(dir, "data.json");

    await atomicWriteJson(file, { version: 1 });
    await atomicWriteJson(file, { version: 2, payload: "x".repeat(100_000) });

    // Read back — must be valid JSON, not a mix of old and new
    const loaded = await readJson<{ version: number }>(file);
    assert.equal(loaded.version, 2);

    // Verify the raw file is parseable as a single JSON value
    const raw = await readFile(file, "utf-8");
    assert.doesNotThrow(() => JSON.parse(raw));
  });

  test("readJson throws ENOENT for missing file", async () => {
    const dir = await tmpDir();
    await assert.rejects(
      readJson(join(dir, "nonexistent.json")),
      { code: "ENOENT" },
    );
  });
});

// ---------------------------------------------------------------------------
// appendAuditEvent (with run lock for concurrent safety)
// ---------------------------------------------------------------------------

describe("appendAuditEvent (locked)", () => {
  test("appends a single event under lock", async () => {
    const dir = await tmpDir();
    const file = join(dir, "audit.jsonl");
    const event = makeEvent(1);

    await withRunLock(dir, async () => {
      await appendAuditEvent(file, event);
    });

    const raw = await readFile(file, "utf-8");
    const lines = raw.trim().split("\n");
    assert.equal(lines.length, 1);
    assert.doesNotThrow(() => JSON.parse(lines[0]));
  });

  test("concurrent locked appends retain every event ID", async () => {
    const dir = await tmpDir();
    const file = join(dir, "audit.jsonl");
    const N = 20;

    // Spawn N concurrent tasks, each holding the lock, each appending one event
    const tasks = Array.from({ length: N }, (_, i) =>
      withRunLock(dir, async () => {
        await appendAuditEvent(file, makeEvent(i));
      }),
    );
    await Promise.all(tasks);

    // Read back — must have exactly N events, all distinct
    const raw = await readFile(file, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, N);

    const ids = new Set(lines.map((l) => (JSON.parse(l) as AuditEvent).eventId));
    assert.equal(ids.size, N);
  });

  test("appends multiple events in order under lock", async () => {
    const dir = await tmpDir();
    const file = join(dir, "audit.jsonl");

    await withRunLock(dir, async () => {
      for (let i = 0; i < 5; i++) {
        await appendAuditEvent(file, makeEvent(i));
      }
    });

    const raw = await readFile(file, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 5);
    for (let i = 0; i < 5; i++) {
      const evt = JSON.parse(lines[i]) as AuditEvent;
      assert.equal(evt.eventId, `evt-${i}`);
    }
  });
});
