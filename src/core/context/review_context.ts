import { gitRevParseToplevel, gitDiff } from '../diff/git.js';
import { collectWorkspaceDiff } from '../diff/workspace.js';
import { parseUnifiedDiff } from '../diff/parser.js';
import { isFileInScope } from '../allowlist/allowed_ext.js';
import { loadCustomRules } from '../rules/custom_rules.js';
import { resolveRule } from '../rules/matcher.js';
import { MAX_HUNK_LINES, PLUGIN_VERSION } from '../prompts/constants.js';
import { newRunId } from '../runs/store.js';
import type { ReviewRequest, ReviewContext, FileChange } from '../model/request.js';

export async function buildReviewContext(req: ReviewRequest): Promise<ReviewContext> {
  let repoRoot: string;
  try {
    repoRoot = await gitRevParseToplevel(req.repoRoot);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`OCRP-RUN-010: Not a git repository at ${req.repoRoot}: ${msg}`);
  }

  let diffText: string;
  let rangeLabel: string;
  if (req.mode === 'workspace') {
    diffText = await collectWorkspaceDiff(repoRoot, req.paths);
    rangeLabel = 'workspace';
  } else if (req.mode === 'staged') {
    diffText = await gitDiff({ repoRoot, range: 'staged', paths: req.paths });
    rangeLabel = 'staged';
  } else if (req.mode === 'commit') {
    if (!req.commit) throw new Error('OCRP-RUN-011: --commit required when mode=commit');
    diffText = await gitDiff({ repoRoot, range: `commit:${req.commit}`, paths: req.paths });
    rangeLabel = `commit:${req.commit}`;
  } else {
    // range
    if (!req.from || !req.to) throw new Error('OCRP-RUN-011: --from and --to required when mode=range');
    diffText = await gitDiff({ repoRoot, range: `${req.from}..${req.to}`, paths: req.paths });
    rangeLabel = `${req.from}..${req.to}`;
  }

  const maxHunkLines = req.maxHunkLines ?? MAX_HUNK_LINES;
  let files: FileChange[] = parseUnifiedDiff(diffText, { maxHunkLines });

  // Load custom rules and apply file scoping
  const customRules = await loadCustomRules(repoRoot, req.rulesPath);
  const excludedFiles: Array<{ path: string; reason: string }> = [];
  const scopedFiles: FileChange[] = [];

  for (const f of files) {
    const scope = isFileInScope(f.path, customRules);
    if (!scope.allowed) {
      excludedFiles.push({ path: f.path, reason: scope.reason });
      continue;
    }
    scopedFiles.push(f);
  }
  files = scopedFiles;

  // Resolve rules for each file (custom first, system fallback)
  for (const f of files) {
    const rule = resolveRule(f.path, customRules);
    f.rulesHit = [{
      ruleId: rule.ruleId,
      message: rule.text,
      docPath: rule.docPath,
      source: rule.source,
      text: rule.text,
    }];
  }

  const runId = newRunId();
  return {
    runId,
    repoRoot,
    range: rangeLabel,
    background: req.background ?? '',
    files,
    changeFiles: files.map((f) => f.path),
    rulesSource: customRules.source,
    excludedFiles,
    meta: { generatedAt: new Date().toISOString(), pluginVersion: PLUGIN_VERSION },
  };
}
