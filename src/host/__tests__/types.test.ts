import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLAUDE_CODE_MANIFEST, OPENCODE_MANIFEST } from '../types.js';

test('CLAUDE_CODE_MANIFEST adapter uses PascalCase tools', () => {
  assert.equal(CLAUDE_CODE_MANIFEST.adapter.name, 'claude-code');
  assert.deepEqual(CLAUDE_CODE_MANIFEST.adapter.agentTools, ['Read', 'Glob', 'Grep', 'Bash']);
});

test('OPENCODE_MANIFEST adapter uses lowercase tools', () => {
  assert.equal(OPENCODE_MANIFEST.adapter.name, 'opencode');
  assert.deepEqual(OPENCODE_MANIFEST.adapter.agentTools, ['read', 'glob', 'grep', 'bash']);
});

test('toolNameMap mappings are consistent', () => {
  assert.equal(CLAUDE_CODE_MANIFEST.toolNameMap.read, 'Read');
  assert.equal(OPENCODE_MANIFEST.toolNameMap.Bash, 'bash');
});
