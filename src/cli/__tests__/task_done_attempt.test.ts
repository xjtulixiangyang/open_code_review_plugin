import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseStructuredCompletion } from '../../core/tools/task_done.js';

// ---------------------------------------------------------------------------
// Tests for parseStructuredCompletion
// ---------------------------------------------------------------------------

describe('parseStructuredCompletion', () => {
  it('parses valid findings submission', () => {
    const result = parseStructuredCompletion({
      taskId: 'task-0',
      attemptId: 'attempt-1',
      leaseToken: 'abc123',
      filePath: 'src/foo.ts',
      diffFingerprint: 'fp1',
      outcome: 'findings',
      summary: 'Found 3 issues',
    }, 'test-run');
    assert.equal(result.runId, 'test-run');
    assert.equal(result.taskId, 'task-0');
    assert.equal(result.attemptId, 'attempt-1');
    assert.equal(result.outcome, 'findings');
    assert.equal(result.summary, 'Found 3 issues');
    assert.equal(typeof result.completionDigest, 'string');
    assert.ok(result.completionDigest.length > 0);
  });

  it('parses valid no_findings submission', () => {
    const result = parseStructuredCompletion({
      taskId: 'task-0',
      attemptId: 'attempt-1',
      leaseToken: 'abc123',
      filePath: 'src/foo.ts',
      diffFingerprint: 'fp1',
      outcome: 'no_findings',
      summary: 'Clean review',
    }, 'test-run');
    assert.equal(result.outcome, 'no_findings');
  });

  it('rejects invalid outcome', () => {
    assert.throws(
      () => parseStructuredCompletion({
        taskId: 'task-0',
        attemptId: 'attempt-1',
        leaseToken: 'abc123',
        filePath: 'src/foo.ts',
        diffFingerprint: 'fp1',
        outcome: 'invalid',
        summary: 'test',
      }, 'test-run'),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects empty summary', () => {
    assert.throws(
      () => parseStructuredCompletion({
        taskId: 'task-0',
        attemptId: 'attempt-1',
        leaseToken: 'abc123',
        filePath: 'src/foo.ts',
        diffFingerprint: 'fp1',
        outcome: 'findings',
        summary: '',
      }, 'test-run'),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects summary exceeding 500 code points', () => {
    assert.throws(
      () => parseStructuredCompletion({
        taskId: 'task-0',
        attemptId: 'attempt-1',
        leaseToken: 'abc123',
        filePath: 'src/foo.ts',
        diffFingerprint: 'fp1',
        outcome: 'findings',
        summary: 'x'.repeat(501),
      }, 'test-run'),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects missing taskId', () => {
    assert.throws(
      () => parseStructuredCompletion({
        attemptId: 'attempt-1',
        leaseToken: 'abc123',
        filePath: 'src/foo.ts',
        diffFingerprint: 'fp1',
        outcome: 'findings',
        summary: 'test',
      } as any, 'test-run'),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects missing attemptId', () => {
    assert.throws(
      () => parseStructuredCompletion({
        taskId: 'task-0',
        leaseToken: 'abc123',
        filePath: 'src/foo.ts',
        diffFingerprint: 'fp1',
        outcome: 'findings',
        summary: 'test',
      } as any, 'test-run'),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects missing leaseToken', () => {
    assert.throws(
      () => parseStructuredCompletion({
        taskId: 'task-0',
        attemptId: 'attempt-1',
        filePath: 'src/foo.ts',
        diffFingerprint: 'fp1',
        outcome: 'findings',
        summary: 'test',
      } as any, 'test-run'),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects missing filePath', () => {
    assert.throws(
      () => parseStructuredCompletion({
        taskId: 'task-0',
        attemptId: 'attempt-1',
        leaseToken: 'abc123',
        diffFingerprint: 'fp1',
        outcome: 'findings',
        summary: 'test',
      } as any, 'test-run'),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('rejects missing diffFingerprint', () => {
    assert.throws(
      () => parseStructuredCompletion({
        taskId: 'task-0',
        attemptId: 'attempt-1',
        leaseToken: 'abc123',
        filePath: 'src/foo.ts',
        outcome: 'findings',
        summary: 'test',
      } as any, 'test-run'),
      /OCRP-ORCH-INVALID-COMPLETION/,
    );
  });

  it('completion digest excludes plaintext token but includes token SHA-256', () => {
    const result1 = parseStructuredCompletion({
      taskId: 'task-0',
      attemptId: 'attempt-1',
      leaseToken: 'token-a',
      filePath: 'src/foo.ts',
      diffFingerprint: 'fp1',
      outcome: 'findings',
      summary: 'Found 3 issues',
    }, 'test-run');

    const result2 = parseStructuredCompletion({
      taskId: 'task-0',
      attemptId: 'attempt-1',
      leaseToken: 'token-b', // different token
      filePath: 'src/foo.ts',
      diffFingerprint: 'fp1',
      outcome: 'findings',
      summary: 'Found 3 issues',
    }, 'test-run');

    // Different tokens should produce different digests because token SHA-256 is included
    assert.notEqual(result1.completionDigest, result2.completionDigest);
  });

  it('identical submissions produce identical completion digest', () => {
    const result1 = parseStructuredCompletion({
      taskId: 'task-0',
      attemptId: 'attempt-1',
      leaseToken: 'token-a',
      filePath: 'src/foo.ts',
      diffFingerprint: 'fp1',
      outcome: 'findings',
      summary: 'Found 3 issues',
    }, 'test-run');

    const result2 = parseStructuredCompletion({
      taskId: 'task-0',
      attemptId: 'attempt-1',
      leaseToken: 'token-a',
      filePath: 'src/foo.ts',
      diffFingerprint: 'fp1',
      outcome: 'findings',
      summary: 'Found 3 issues',
    }, 'test-run');

    assert.equal(result1.completionDigest, result2.completionDigest);
  });
});
