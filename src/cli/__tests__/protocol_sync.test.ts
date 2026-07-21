import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

test('both host commands are thin shells delegating to review.ts', async () => {
  for (const path of ['commands/review.md', 'commands/review-opencode.md']) {
    const text = await readFile(join(ROOT, path), 'utf8');
    // The thin shell delegates all decisions to the TS engine
    assert.match(text, /dist\/commands\/review\.mjs/, `${path}: must delegate to review.ts engine`);
    assert.match(text, /\$ARGUMENTS/, `${path}: must pass through arguments`);
    assert.match(text, /phase/, `${path}: must reference the protocol phase field`);
    assert.match(text, /dispatch|wait|done/, `${path}: must reference the three protocol phases`);
    // Must NOT contain the old inline protocol (it moved to review.ts)
    assert.doesNotMatch(text, /ORCHESTRATOR-PROTOCOL:START/, `${path}: protocol must not be inline`);
    assert.doesNotMatch(text, /ORCHESTRATOR-PROTOCOL:END/, `${path}: protocol must not be inline`);
  }
});

test('review.ts engine contains the deterministic orchestration protocol', async () => {
  const engine = await readFile(join(ROOT, 'src/commands/review.ts'), 'utf8');
  // Programmatic API calls (review.ts imports directly, not shell-out)
  for (const required of [
    'startCandidate',
    'effectiveRunId',
    'Orchestrator',
    '.reconcile(',
    '.claim(',
    'nextLeaseDeadline',
    'readAcceptedComments',
    // Phase protocol
    'phase:',
    'DispatchPhase',
    'WaitPhase',
    'DonePhase',
    "'dispatch'",
    "'wait'",
    "'done'",
  ]) {
    assert.ok(engine.includes(required), `engine missing: ${required}`);
  }
});

test('reviewer contracts require lease-bound comments and explicit completion outcome', async () => {
  for (const path of ['agents/ocr-reviewer.md', 'agents/ocr-reviewer-opencode.md', 'skills/ocr-review-file/SKILL.md']) {
    const text = await readFile(join(ROOT, path), 'utf8');
    for (const field of ['taskId', 'attemptId', 'leaseToken', 'filePath', 'diffFingerprint', 'outcome', 'summary']) {
      assert.match(text, new RegExp(field), `${path} missing ${field}`);
    }
    assert.match(text, /findings/);
    assert.match(text, /no_findings/);
  }
});