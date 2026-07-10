import type { HostAdapter } from '../types.js';

export type { HostAdapter };

export const claudeCodeAdapter: HostAdapter = {
  name: 'claude-code',
  agentTools: ['Read', 'Glob', 'Grep', 'Bash'],
};
