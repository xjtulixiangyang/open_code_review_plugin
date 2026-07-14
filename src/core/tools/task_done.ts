import { createHash } from 'node:crypto';
import { sha256 } from '../orchestrator/fingerprint.js';
import type { CompletionOutcome, CompletionSubmission } from '../orchestrator/types.js';

/** Mirrors open-code-review TaskDone: validate structured completion args. */
export function parseTaskDone(args: Record<string, unknown>): { subagent: string; file: string } {
  const subagent = typeof args['subagent'] === 'string' ? (args['subagent'] as string).trim() : '';
  if (!subagent) throw new Error("[task_done] missing --args.subagent");
  const file = typeof args['file'] === 'string' ? (args['file'] as string).trim() : '';
  if (!file) throw new Error("[task_done] missing --args.file");
  return { subagent, file };
}

// ---------------------------------------------------------------------------
// Structured completion
// ---------------------------------------------------------------------------

const VALID_OUTCOMES: ReadonlySet<string> = new Set(['findings', 'no_findings']);
const MAX_SUMMARY_CODEPOINTS = 500;

/**
 * Parse and canonicalize a structured completion submission.
 *
 * Requires every field, exact outcome enum, non-empty summary, and at most
 * 500 Unicode code points. Computes a completion digest from the canonical
 * payload excluding the plaintext lease token but including its SHA-256
 * digest.
 *
 * Returns a normalized CompletionSubmission with a completionDigest field.
 */
export function parseStructuredCompletion(
  args: Record<string, unknown>,
  runId: string,
): CompletionSubmission & { completionDigest: string } {
  // Require every field
  const taskId = typeof args['taskId'] === 'string' ? args['taskId'].trim() : undefined;
  if (!taskId) {
    throw new Error('[OCRP-ORCH-INVALID-COMPLETION] Missing or invalid taskId');
  }

  const attemptId = typeof args['attemptId'] === 'string' ? args['attemptId'].trim() : undefined;
  if (!attemptId) {
    throw new Error('[OCRP-ORCH-INVALID-COMPLETION] Missing or invalid attemptId');
  }

  const leaseToken = typeof args['leaseToken'] === 'string' ? args['leaseToken'] : undefined;
  if (!leaseToken) {
    throw new Error('[OCRP-ORCH-INVALID-COMPLETION] Missing or invalid leaseToken');
  }

  const filePath = typeof args['filePath'] === 'string' ? args['filePath'].trim() : undefined;
  if (!filePath) {
    throw new Error('[OCRP-ORCH-INVALID-COMPLETION] Missing or invalid filePath');
  }

  const diffFingerprint = typeof args['diffFingerprint'] === 'string' ? args['diffFingerprint'].trim() : undefined;
  if (!diffFingerprint) {
    throw new Error('[OCRP-ORCH-INVALID-COMPLETION] Missing or invalid diffFingerprint');
  }

  // Exact outcome enum
  const outcomeRaw = typeof args['outcome'] === 'string' ? args['outcome'].trim() : '';
  if (!VALID_OUTCOMES.has(outcomeRaw)) {
    throw new Error(
      `[OCRP-ORCH-INVALID-COMPLETION] Invalid outcome "${outcomeRaw}": must be "findings" or "no_findings"`,
    );
  }
  const outcome = outcomeRaw as CompletionOutcome;

  // Non-empty summary
  const summary = typeof args['summary'] === 'string' ? args['summary'] : '';
  if (summary.length === 0) {
    throw new Error('[OCRP-ORCH-INVALID-COMPLETION] Summary must not be empty');
  }

  // At most 500 Unicode code points
  const codePointLen = [...summary].length;
  if (codePointLen > MAX_SUMMARY_CODEPOINTS) {
    throw new Error(
      `[OCRP-ORCH-INVALID-COMPLETION] Summary exceeds ${MAX_SUMMARY_CODEPOINTS} Unicode code points (${codePointLen})`,
    );
  }

  // Compute completion digest from canonical payload excluding plaintext token
  // but including its SHA-256 digest
  const tokenDigest = sha256(leaseToken);
  const digestPayload = {
    runId,
    taskId,
    attemptId,
    tokenDigest,
    filePath,
    diffFingerprint,
    outcome,
    summary,
  };
  const completionDigest = sha256(JSON.stringify(digestPayload, Object.keys(digestPayload).sort()));

  return {
    runId,
    taskId,
    attemptId,
    leaseToken,
    filePath,
    diffFingerprint,
    outcome,
    summary,
    completionDigest,
  };
}
