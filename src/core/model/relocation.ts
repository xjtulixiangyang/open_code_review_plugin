export type RelocationSource =
  | 'unchanged'
  | 'existing_code_diff'
  | 'existing_code_file'
  | 'line_clamped'
  | 'llm_relocation'
  | 'fallback_original';

export interface RelocationDecision {
  comment_id: string;
  original_start_line: number;
  original_end_line: number;
  resolved_start_line: number;
  resolved_end_line: number;
  source: RelocationSource;
  reason: string;
}

export interface RelocationFileResult {
  path: string;
  decisions: RelocationDecision[];
  _meta?: {
    source: 'line_resolver' | 're_location_task';
    subagent?: string;
    ts?: string;
  };
}

export interface RelocationWarning {
  kind: string;
  path?: string;
  comment_id?: string;
  detail: string;
}

export interface ReadRelocationResultsOutput {
  results: RelocationFileResult[];
  warnings: RelocationWarning[];
}
