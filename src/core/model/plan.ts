import type { Severity } from '../types.js';

/**
 * PlanOutput - 与 OCR task_template.json::PLAN_TASK 的 Output Format 一致。
 */
export interface PlanIssue {
  severity: Severity;
  description: string;
  tool_guidance: Array<{
    name: string;
    reason: string;
    arguments: string;
  }>;
  /** 可选扩展：插件层为定位文件而新增的提示字段；OCR 原版无此字段，仅向后兼容追加。 */
  file_hint?: string;
}

export interface PlanOutput {
  change_summary: string;
  issues: PlanIssue[];
}
