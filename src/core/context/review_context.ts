import { gitRevParseToplevel, gitDiff } from '../diff/git.js';
import { collectWorkspaceDiff } from '../diff/workspace.js';
import { parseUnifiedDiff } from '../diff/parser.js';
import { isAllowed } from '../allowlist/allowed_ext.js';
import { buildSystemRulePrompt } from '../rules/matcher.js';
import { MAX_HUNK_LINES, PLUGIN_VERSION } from '../prompts/constants.js';
import { newRunId } from '../runs/store.js';
import type { ReviewRequest, ReviewContext, FileChange } from '../model/request.js';

export async function buildReviewContext(req: ReviewRequest): Promise<ReviewContext> {
  const repoRoot = await gitRevParseToplevel(req.repoRoot);

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

  // allowlist 过滤
  files = files.filter((f) => isAllowed(f.path));

  // 规则匹配
  for (const f of files) {
    const rule = buildSystemRulePrompt(f.path);
    f.rulesHit = [{ ruleId: rule.ruleId, message: '', docPath: rule.docPath }];
  }

  const runId = newRunId();
  return {
    runId,
    repoRoot,
    range: rangeLabel,
    background: req.background ?? '',
    files,
    changeFiles: files.map((f) => f.path),
    meta: { generatedAt: new Date().toISOString(), pluginVersion: PLUGIN_VERSION },
  };
}
