import { gitRevParseToplevel, gitDiff } from '../diff/git.js';
import { collectWorkspaceDiff } from '../diff/workspace.js';
import { parseUnifiedDiff } from '../diff/parser.js';
import { isFileInScope } from '../allowlist/allowed_ext.js';
import { resolveRule } from '../rules/matcher.js';
import { loadCustomRules } from '../rules/custom_rules.js';
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

  const custom = await loadCustomRules(repoRoot, req.rulesPath);

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
  const parsed: FileChange[] = parseUnifiedDiff(diffText, { maxHunkLines });

  // scope 过滤：扩展名 + include/exclude + 默认排除
  const files: FileChange[] = [];
  const excludedFiles: Array<{ path: string; reason: string }> = [];
  for (const f of parsed) {
    const scope = isFileInScope(f.path, custom);
    if (scope.allowed) {
      files.push(f);
    } else {
      excludedFiles.push({ path: f.path, reason: scope.reason });
    }
  }

  // 规则匹配：自定义优先，内置回退
  for (const f of files) {
    const rule = resolveRule(f.path, custom);
    f.rulesHit = [{
      ruleId: rule.ruleId,
      message: rule.source === 'custom' ? rule.text : '',
      docPath: rule.docPath,
    }];
  }

  const runId = newRunId();
  const ctx: ReviewContext = {
    runId,
    repoRoot,
    range: rangeLabel,
    background: req.background ?? '',
    files,
    changeFiles: files.map((f) => f.path),
    meta: { generatedAt: new Date().toISOString(), pluginVersion: PLUGIN_VERSION },
    rulesSource: custom.source,
    excludedFiles: excludedFiles.length > 0 ? excludedFiles : undefined,
  };
  if (req.preview) ctx.preview = true;
  if (req.dryRun) ctx.dryRun = true;
  return ctx;
}
