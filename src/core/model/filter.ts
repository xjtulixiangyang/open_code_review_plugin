export interface FilterDecision {
  comment_id: string;
  action: 'hide';
  reason: string;
}

export interface FilterFileResult {
  path: string;
  decisions: FilterDecision[];
  _meta?: {
    source: 'review_filter_task';
    subagent?: string;
    ts?: string;
  };
}

export interface FilterWarning {
  kind: string;
  path?: string;
  detail: string;
}

export interface ReadFilterResultsOutput {
  results: FilterFileResult[];
  warnings: FilterWarning[];
}
