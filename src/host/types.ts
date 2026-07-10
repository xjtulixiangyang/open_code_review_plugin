/**
 * HostAdapter — allows review tools to adapt to different AI coding hosts.
 */
export interface HostAdapter {
  name: 'claude-code' | 'opencode';
  agentTools: string[];
}

/**
 * HostManifest — static metadata for a host-specific installation.
 */
export interface HostManifest {
  adapter: HostAdapter;
  /** Directory containing command .md files. */
  commandsDir: string;
  /** Directory containing skill files or directories. */
  skillsDir: string;
  /** Directory containing agent .md files. */
  agentsDir: string;
  /** Tool name mapping between host conventions. */
  toolNameMap: Record<string, string>;
}

export const CLAUDE_CODE_MANIFEST: HostManifest = {
  adapter: {
    name: 'claude-code',
    agentTools: ['Read', 'Glob', 'Grep', 'Bash'],
  },
  commandsDir: 'commands',
  skillsDir: 'skills',
  agentsDir: 'agents',
  toolNameMap: { read: 'Read', glob: 'Glob', grep: 'Grep', bash: 'Bash' },
};

export const OPENCODE_MANIFEST: HostManifest = {
  adapter: {
    name: 'opencode',
    agentTools: ['read', 'glob', 'grep', 'bash'],
  },
  commandsDir: '~/.config/opencode/commands',
  skillsDir: '~/.config/opencode/skills',
  agentsDir: '~/.config/opencode/agents',
  toolNameMap: { Read: 'read', Glob: 'glob', Grep: 'grep', Bash: 'bash' },
};
