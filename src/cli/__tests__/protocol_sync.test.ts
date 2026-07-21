import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

test('commands/review.md is a thin shell that delegates to review.ts', async () => {
  const claude = await readFile(join(ROOT, 'commands/review.md'), 'utf8');
  // The thin shell delegates all decisions to the TS engine
  assert.match(claude, /dist\/commands\/review\.mjs/, 'must delegate to review.ts engine');
  assert.match(claude, /\$ARGUMENTS/, 'must pass through arguments');
  assert.match(claude, /phase/, 'must reference the protocol phase field');
  assert.match(claude, /dispatch|wait|done/, 'must reference the three protocol phases');
  // Must NOT contain the old inline protocol (it moved to review.ts)
  assert.doesNotMatch(claude, /ORCHESTRATOR-PROTOCOL:START/, 'protocol must not be inline in .md');
  assert.doesNotMatch(claude, /ORCHESTRATOR-PROTOCOL:END/, 'protocol must not be inline in .md');
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