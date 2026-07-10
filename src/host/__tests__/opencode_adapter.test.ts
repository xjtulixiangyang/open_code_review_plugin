import { test } from 'node:test';
import assert from 'node:assert/strict';
import { opencodeAdapter } from '../opencode/adapter.js';
import { claudeCodeAdapter } from '../claude-code/adapter.js';

test('opencodeAdapter name is opencode', () => {
  assert.equal(opencodeAdapter.name, 'opencode');
});

test('opencodeAdapter agentTools are lowercase', () => {
  assert.deepEqual(opencodeAdapter.agentTools, ['read', 'glob', 'grep', 'bash']);
});

test('claudeCodeAdapter name is claude-code', () => {
  assert.equal(claudeCodeAdapter.name, 'claude-code');
});

test('claudeCodeAdapter agentTools are PascalCase', () => {
  assert.deepEqual(claudeCodeAdapter.agentTools, ['Read', 'Glob', 'Grep', 'Bash']);
});
