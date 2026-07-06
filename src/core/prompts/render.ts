export function renderTemplate(tpl: string, vars: Record<string, string>): string {
  // 先替换 {{key}}（贪婪匹配），再替换 {key}（仅 word chars，避免吞 { }）
  let out = tpl.replace(/\{\{(\w+)\}\}/g, (_m, k) => (vars[k] ?? ''));
  out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
  return out;
}
