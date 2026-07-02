import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import YAML from 'yaml';

export interface CustomRuleEntry {
  path: string;
  rule: string;
}

export interface CustomRuleFile {
  rules?: CustomRuleEntry[];
  include?: string[];
  exclude?: string[];
}

export interface LoadedCustomRules {
  source: string;
  sourceKind: 'cli' | 'repo' | 'none';
  rules: CustomRuleEntry[];
  include: string[];
  exclude: string[];
}

const REPO_CANDIDATES = ['.code-review.yaml', '.code-review.yml', '.code-review.json'] as const;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isRuleEntry(v: unknown): v is CustomRuleEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['path'] === 'string' && typeof o['rule'] === 'string';
}

function validateRoot(raw: unknown, source: string): CustomRuleFile {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`OCRP-RULES-092: rule file ${source} root must be an object`);
  }
  const o = raw as Record<string, unknown>;
  const rules = o['rules'];
  if (rules !== undefined) {
    if (!Array.isArray(rules) || !rules.every(isRuleEntry)) {
      throw new Error(`OCRP-RULES-093: rule file ${source} has invalid rules[] entries (each needs string path and rule)`);
    }
  }
  if (o['include'] !== undefined && !isStringArray(o['include'])) {
    throw new Error(`OCRP-RULES-093: rule file ${source} include must be a string array`);
  }
  if (o['exclude'] !== undefined && !isStringArray(o['exclude'])) {
    throw new Error(`OCRP-RULES-093: rule file ${source} exclude must be a string array`);
  }
  return {
    rules: (rules as CustomRuleEntry[] | undefined) ?? [],
    include: (o['include'] as string[] | undefined) ?? [],
    exclude: (o['exclude'] as string[] | undefined) ?? [],
  };
}

function parseContent(text: string, source: string): CustomRuleFile {
  let raw: unknown;
  if (source.endsWith('.json')) {
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`OCRP-RULES-091: failed to parse JSON ${source}: ${(err as Error).message}`);
    }
  } else {
    try {
      raw = YAML.parse(text);
    } catch (err) {
      throw new Error(`OCRP-RULES-091: failed to parse YAML ${source}: ${(err as Error).message}`);
    }
  }
  return validateRoot(raw, source);
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function loadFile(absPath: string, sourceLabel: string, sourceKind: 'cli' | 'repo'): Promise<LoadedCustomRules> {
  let text: string;
  try {
    text = await readFile(absPath, 'utf8');
  } catch (err) {
    throw new Error(`OCRP-RULES-090: cannot read rule file ${sourceLabel}: ${(err as Error).message}`);
  }
  const f = parseContent(text, sourceLabel);
  return {
    source: sourceLabel,
    sourceKind,
    rules: f.rules ?? [],
    include: f.include ?? [],
    exclude: f.exclude ?? [],
  };
}

export async function loadCustomRules(repoRoot: string, rulesPath?: string): Promise<LoadedCustomRules> {
  if (rulesPath) {
    const abs = join(repoRoot, rulesPath);
    return loadFile(abs, rulesPath, 'cli');
  }
  for (const name of REPO_CANDIDATES) {
    const abs = join(repoRoot, name);
    if (await exists(abs)) {
      return loadFile(abs, name, 'repo');
    }
  }
  return { source: 'system', sourceKind: 'none', rules: [], include: [], exclude: [] };
}
