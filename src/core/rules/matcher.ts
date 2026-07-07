import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { globToRegExp } from '../allowlist/allowed_ext.js';
import type { LoadedCustomRules } from './custom_rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface SystemRulesFile {
  default_rule: string;
  path_rule_map: Record<string, string>;
}

let _rules: SystemRulesFile | null = null;

export function loadSystemRules(): SystemRulesFile {
  if (_rules) return _rules;
  const p = join(__dirname, 'system_rules.json');
  _rules = JSON.parse(readFileSync(p, 'utf8')) as SystemRulesFile;
  return _rules;
}

/**
 * 按 path_rule_map 中的**插入顺序**逐条匹配，命中即返回；
 * 未命中返回 default_rule。docPath 是 rule_docs/ 下的文件名 (含 .md)。
 */
export function matchRule(filePath: string): { ruleId: string; docPath: string } {
  const r = loadSystemRules();
  for (const [pattern, doc] of Object.entries(r.path_rule_map)) {
    if (globToRegExp(pattern).test(filePath)) {
      return { ruleId: doc.replace(/\.md$/, ''), docPath: doc };
    }
  }
  return { ruleId: r.default_rule.replace(/\.md$/, ''), docPath: r.default_rule };
}

const docCache = new Map<string, string>();

export function loadRuleDocText(docFileName: string): string {
  const cached = docCache.get(docFileName);
  if (cached !== undefined) return cached;
  // assets/rule_docs/ 在仓库根，从 __dirname (= dist/core/rules/ 运行时 / src/core/rules/ 测试时) 回到根
  const candidates = [
    join(__dirname, '..', '..', '..', 'assets', 'rule_docs', docFileName), // src 测试时
    join(__dirname, '..', '..', '..', '..', 'assets', 'rule_docs', docFileName), // dist 运行时
    join(process.cwd(), 'assets', 'rule_docs', docFileName), // CLI 入口运行时兜底
  ];
  let text = '';
  for (const p of candidates) {
    try {
      text = readFileSync(p, 'utf8');
      break;
    } catch {
      /* try next */
    }
  }
  if (!text) {
    throw new Error(`rule doc not found: ${docFileName}`);
  }
  docCache.set(docFileName, text);
  return text;
}

export function buildSystemRulePrompt(filePath: string): {
  ruleId: string;
  docPath: string;
  text: string;
} {
  const m = matchRule(filePath);
  return { ...m, text: loadRuleDocText(m.docPath) };
}

export interface ResolvedRule {
  ruleId: string;
  text: string;
  docPath?: string;
  source: 'custom' | 'system';
}

/**
 * Resolve the applicable rule for a file path.
 * Checks custom rules first (by path pattern matching); falls back to system rules.
 */
export function resolveRule(
  filePath: string,
  custom: LoadedCustomRules,
): ResolvedRule {
  // Try custom rules first
  for (const entry of custom.rules) {
    if (globToRegExp(entry.path).test(filePath)) {
      return {
        ruleId: `custom:${entry.path}`,
        text: entry.rule,
        source: 'custom',
      };
    }
  }

  // Fall back to system rule
  const sys = buildSystemRulePrompt(filePath);
  return {
    ruleId: sys.ruleId,
    text: sys.text,
    docPath: sys.docPath,
    source: 'system',
  };
}
