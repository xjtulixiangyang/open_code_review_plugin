/**
 * HostAdapter interface — allows review tools to adapt to different AI coding hosts.
 */
export interface HostAdapter {
  name: 'claude-code' | 'opencode';
  agentTools: string[];
}

export const claudeCodeAdapter: HostAdapter = {
  name: 'claude-code',
  agentTools: ['Read', 'Glob', 'Grep', 'Bash'],
};
