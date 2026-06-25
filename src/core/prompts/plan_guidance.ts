import type { PlanOutput, PlanIssue } from '../model/plan.js';

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function isRelevant(issue: PlanIssue, currentFilePath: string): boolean {
  if (issue.file_hint && issue.file_hint === currentFilePath) return true;
  if (issue.description.includes(currentFilePath)) return true;
  // tool_guidance 中 arguments / reason 含 path
  for (const tg of issue.tool_guidance ?? []) {
    if ((tg.arguments || '').includes(currentFilePath)) return true;
    if ((tg.reason || '').includes(currentFilePath)) return true;
  }
  return false;
}

/**
 * 把 PlanOutput 文本化为 MAIN_TASK 模板的 {{plan_guidance}} 占位字符串。
 * 规则：
 *   - 仅保留 file_hint == currentFilePath、或 description/tool_guidance 提及该 path 的 issue
 *   - 按 severity 降序 (high > medium > low)
 *   - 渲染为 Markdown 列表
 *   - 无相关条目 → 返回空串
 */
export function planOutputToGuidance(plan: PlanOutput, currentFilePath: string): string {
  const filtered = (plan.issues ?? []).filter((i) => isRelevant(i, currentFilePath));
  if (filtered.length === 0) return '';
  filtered.sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 99) - (SEVERITY_RANK[b.severity] ?? 99),
  );
  const lines: string[] = [];
  if (plan.change_summary) lines.push(`**Summary**: ${plan.change_summary}`, '');
  for (const i of filtered) {
    lines.push(`- [${i.severity}] ${i.description}`);
  }
  return lines.join('\n');
}
