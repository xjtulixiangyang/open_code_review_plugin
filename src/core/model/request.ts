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
  source?: 'custom' | 'system';
  text?: string;
}

export interface FileChange {
  path: string;
  oldPath?: string;
  status: FileStatus;
  diff: string;
  truncated: boolean;
  hunks: Hunk[];
  rulesHit: RuleHit[];
  skipped?: boolean;
  skipReason?: string;
  skippedLines?: number;
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
  plansPath?: string;
  preview?: boolean;
  dryRun?: boolean;
  resumeRunId?: string;
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
  rulesSource?: string;
  plansGuidanceSource?: string;
  plansGuidanceText?: string;
  excludedFiles?: Array<{ path: string; reason: string }>;
  preview?: boolean;
  dryRun?: boolean;
  resumed?: boolean;
  remainingFileCount?: number;
  meta: {
    generatedAt: string;
    pluginVersion: string;
  };
}
