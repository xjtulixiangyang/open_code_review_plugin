/** Mirrors open-code-review TaskDone: validate structured completion args. */
export function parseTaskDone(args: Record<string, unknown>): { subagent: string; file: string } {
  const subagent = typeof args['subagent'] === 'string' ? (args['subagent'] as string).trim() : '';
  if (!subagent) throw new Error("[task_done] missing --args.subagent");
  const file = typeof args['file'] === 'string' ? (args['file'] as string).trim() : '';
  if (!file) throw new Error("[task_done] missing --args.file");
  return { subagent, file };
}
