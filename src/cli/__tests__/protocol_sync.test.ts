import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = process.cwd();

function extractProtocol(text: string): string {
  const match = text.match(/<!-- ORCHESTRATOR-PROTOCOL:START -->([\s\S]*?)<!-- ORCHESTRATOR-PROTOCOL:END -->/);
  assert.ok(match, 'missing orchestrator protocol markers');
  return match[1].trim();
}

test('Claude Code and OpenCode commands share the exact orchestration protocol', async () => {
  const claude = await readFile(join(ROOT, 'commands/review.md'), 'utf8');
  const opencode = await readFile(join(ROOT, 'commands/review-opencode.md'), 'utf8');
  assert.equal(extractProtocol(claude), extractProtocol(opencode));
});

test('shared protocol uses effective run, pull claims, reconciliation, and strict aggregation', async () => {
  const command = await readFile(join(ROOT, 'commands/review.md'), 'utf8');
  const protocol = extractProtocol(command);
  for (const required of [
    'ocr-orchestrator-start',
    'effectiveRunId',
    'ocr-orchestrator-reconcile',
    'ocr-orchestrator-claim',
    'ocr-orchestrator-ack',
    'ocr-orchestrator-dispatch-fail',
    'ocr-aggregate --runId <effectiveRunId> --format <format> --strict true',
    'nextLeaseDeadline',
  ]) assert.match(protocol, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
