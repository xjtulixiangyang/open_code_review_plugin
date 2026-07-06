import type { HostAdapter } from '../claude-code/adapter.js';

export const opencodeAdapter: HostAdapter = {
  name: 'opencode',
  agentTools: ['read', 'glob', 'grep', 'bash'],
};
