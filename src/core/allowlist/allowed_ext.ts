import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import type { LoadedCustomRules } from '../rules/custom_rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _exts: string[] | null = null;
let _excludes: string[] | null = null;

export function loadSupportedExtensions(): string[] {
  if (_exts) return _exts;
  const p = join(__dirname, 'supported_file_types.json');
  _exts = JSON.parse(readFileSync(p, 'utf8')) as string[];
  return _exts;
}

export function loadDefaultExcludes(): string[] {
  if (_excludes) return _excludes;
  const p = join(__dirname, 'default_exclude_patterns.json');
  _excludes = JSON.parse(readFileSync(p, 'utf8')) as string[];
  return _excludes;
}

/**
 * 简化版 glob → RegExp，支持 ** / * / ? / { , }。
 * 仅用于 path-pattern 匹配，不是完整 minimatch。
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` 匹配任意层级 (含 0)；`**` 匹配 .*
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else if (c === '{') {
      const close = glob.indexOf('}', i);
      if (close === -1) {
        re += '\\{';
        i += 1;
      } else {
        const inner = glob.slice(i + 1, close);
        const opts = inner.split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&'));
        re += '(?:' + opts.join('|') + ')';
        i = close + 1;
      }
    } else if ('.+^$()|[]\\'.includes(c)) {
      re += '\\' + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

function matchAny(path: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (globToRegExp(p).test(path)) return true;
  }
  return false;
}

export function isAllowed(path: string, extraExclude: string[] = []): boolean {
  const ext = extname(path);
  const exts = loadSupportedExtensions();
  if (!exts.includes(ext)) return false;
  if (matchAny(path, loadDefaultExcludes())) return false;
  if (extraExclude.length > 0 && matchAny(path, extraExclude)) return false;
  return true;
}

export type FileScopeReason =
  | 'unsupported-ext'
  | 'user-exclude'
  | 'not-in-include'
  | 'default-exclude'
  | 'ok';

/**
 * 组合判断文件是否进入 review：
 * 1. 扩展名不在 supported list → excluded
 * 2. 命中用户 exclude → excluded
 * 3. 配置了 include 时，未命中 → excluded
 * 4. include 命中 → reviewed (跳过默认 exclude)
 * 5. 无 include 时命中默认 exclude → excluded
 * 6. 否则 reviewed
 */
export function isFileInScope(
  filePath: string,
  custom: LoadedCustomRules | null,
): { allowed: boolean; reason: FileScopeReason } {
  const ext = extname(filePath);
  const exts = loadSupportedExtensions();
  if (!exts.includes(ext)) return { allowed: false, reason: 'unsupported-ext' };

  const exclude = custom?.exclude ?? [];
  if (exclude.length > 0 && matchAny(filePath, exclude)) {
    return { allowed: false, reason: 'user-exclude' };
  }

  const include = custom?.include ?? [];
  if (include.length > 0) {
    if (!matchAny(filePath, include)) {
      return { allowed: false, reason: 'not-in-include' };
    }
    return { allowed: true, reason: 'ok' };
  }

  if (matchAny(filePath, loadDefaultExcludes())) {
    return { allowed: false, reason: 'default-exclude' };
  }

  return { allowed: true, reason: 'ok' };
}
