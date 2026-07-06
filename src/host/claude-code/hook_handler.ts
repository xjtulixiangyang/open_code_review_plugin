#!/usr/bin/env node
import { appendEvent } from '../../core/runs/store.js';

export interface ToolCallExtraction {
  tool: 'code_comment' | 'task_done' | 'file_read_diff';
  args: Record<string, string>;
}

export interface HookInput {
  tool_name?: string;
  tool_input?: { command?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export function parseHookInput(raw: string): HookInput | null {
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return null;
  }
}

const TARGET_TOOLS = ['code_comment', 'task_done', 'file_read_diff'] as const;

/**
 * 从 Bash command 字符串提取目标工具调用。
 * 支持简单的 `--key value` 形式 (值含空格时必须用引号；本提取器简化处理：
 *  使用 shell 词法极简版 — 空格分隔，"..." 内空格保留)。
 */
function splitArgs(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: '"' | "'" | null = null;
  for (const c of cmd) {
    if (q) {
      if (c === q) q = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      q = c;
    } else if (c === ' ') {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function extractToolCall(cmd: string): ToolCallExtraction | null {
  const parts = splitArgs(cmd);
  if (parts.length === 0) return null;
  const head = parts[0];
  if (!TARGET_TOOLS.includes(head as typeof TARGET_TOOLS[number])) return null;
  const args: Record<string, string> = {};
  let parsedArgs: Record<string, unknown> | null = null;
  for (let i = 1; i < parts.length; i++) {
    const a = parts[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = parts[i + 1] ?? '';
      i++;
      if (key === 'args') {
        try {
          const p = JSON.parse(val);
          if (typeof p === 'object' && p !== null && !Array.isArray(p)) parsedArgs = p as Record<string, unknown>;
        } catch { /* ignore malformed args in hook best-effort path */ }
      } else {
        args[key] = val;
      }
    }
  }
  if (parsedArgs) {
    for (const [k, v] of Object.entries(parsedArgs)) {
      if (typeof v === 'string') args[k] = v;
      else if (typeof v === 'number') args[k] = String(v);
    }
    // best-effort first-comment line range for progress display
    const comments = parsedArgs['comments'];
    if (Array.isArray(comments) && comments.length > 0 && typeof comments[0] === 'object' && comments[0] !== null) {
      const first = comments[0] as Record<string, unknown>;
      if (typeof first['start_line'] === 'number') args['start'] = String(first['start_line']);
      if (typeof first['end_line'] === 'number') args['end'] = String(first['end_line']);
    }
    // flatten path_array[0] -> path for file_read_diff progress display
    const pathArray = parsedArgs['path_array'];
    if (Array.isArray(pathArray) && pathArray.length > 0 && typeof pathArray[0] === 'string') {
      args['path'] = pathArray[0];
    }
  }
  return { tool: head as ToolCallExtraction['tool'], args };
}

export function formatProgressLine(t: ToolCallExtraction): string {
  if (t.tool === 'code_comment') {
    return `💬 ${t.args.subagent ?? '?'} → ${t.args.path}:${t.args.start} 提交评论`;
  }
  if (t.tool === 'task_done') {
    return `✅ ${t.args.subagent ?? '?'} 完成 ${t.args.file ?? ''}`;
  }
  return `📖 ${t.args.path ?? '?'} 读取 diff`;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const j = parseHookInput(raw);
  if (!j || j.tool_name !== 'Bash') return; // 静默忽略
  const cmd = j.tool_input?.command;
  if (!cmd) return;
  const tc = extractToolCall(cmd);
  if (!tc) return;
  // 持久化总线：写 events.jsonl（最佳努力，失败不阻塞）
  try {
    if (tc.args.runId) {
      await appendEvent(tc.args.runId, { type: 'tool_call', tool: tc.tool, args: tc.args });
    }
  } catch {
    /* OCRP-HOOK-060: hook 失败不阻塞 */
  }
  // 事件总线：stdout 写一行进度提示
  process.stdout.write(formatProgressLine(tc) + '\n');
}

// 仅当作为 entry 运行时才执行 main；测试 import 时不应运行
const isMain = process.argv[1] && process.argv[1].endsWith('hook_handler.mjs');
if (isMain || (process.argv[1] && process.argv[1].endsWith('hook_handler.ts'))) {
  main().catch(() => process.exit(0)); // 永远不阻塞宿主
}
