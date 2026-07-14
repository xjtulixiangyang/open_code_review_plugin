import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import writeFileAtomic from "write-file-atomic";
import type { AuditEvent } from "./types.js";

/**
 * Atomically write a JSON value to a file.
 *
 * Uses write-file-atomic to avoid the partial-write visibility window that
 * exists with unlink-then-rename on POSIX and overwrite-rename on Windows.
 * The value is serialized as pretty-printed JSON with a trailing newline.
 */
export async function atomicWriteJson(
  file: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n", {
    fsync: true,
  });
}

/**
 * Read and parse a JSON file.
 */
export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/**
 * Append an AuditEvent to a JSONL file.
 *
 * This function uses O_APPEND semantics via `appendFile` and is intended to
 * be called while the caller holds the run lock (via `withRunLock`).  The
 * caller is responsible for ensuring mutual exclusion.
 */
export async function appendAuditEvent(
  file: string,
  event: AuditEvent,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(event) + "\n", {
    encoding: "utf8",
    flag: "a",
  });
}
