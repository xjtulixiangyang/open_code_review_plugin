import type { FileStatus, ReviewMode } from '../types.js';

export interface DiffLine {
  kind: '+' | '-' | ' ';
  oldLineNo: number;
  newLineNo: number;
  text: string;
}

export interface Hunk {
  id: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface RuleHit {
  ruleId: string;
  message: string;
  docPath?: string;
}

export interface FileChange {
  path: string;
  oldPath?: string;
  status: FileStatus;
  diff: string;
  truncated: boolean;
  hunks: Hunk[];
  rulesHit: RuleHit[];
}

export interface ReviewRequest {
  repoRoot: string;
  mode: ReviewMode;
  commit?: string;
  from?: string;
  to?: string;
  paths?: string[];
  background?: string;
  rulesPath?: string;
  dryRun?: boolean;
  format?: 'markdown' | 'json' | 'both';
  concurrency?: number;
  maxHunkLines?: number;
}

export interface ReviewContext {
  runId: string;
  repoRoot: string;
  range: string;
  background: string;
  files: FileChange[];
  changeFiles: string[];
  meta: {
    generatedAt: string;
    pluginVersion: string;
  };
}
