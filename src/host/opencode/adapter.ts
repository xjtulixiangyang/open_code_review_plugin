import type { HostAdapter } from '../types.js';

export type { HostAdapter };

export const opencodeAdapter: HostAdapter = {
  name: 'opencode',
  agentTools: ['read', 'glob', 'grep', 'bash'],
};
