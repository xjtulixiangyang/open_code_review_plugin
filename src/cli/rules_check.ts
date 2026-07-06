#!/usr/bin/env node
import { buildSystemRulePrompt } from '../core/rules/matcher.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    process.stderr.write('[ocr-rules-check] usage: ocr-rules-check <path>\n');
    process.exit(2);
  }
  const p = args[0];
  const m = buildSystemRulePrompt(p);
  process.stdout.write(
    JSON.stringify({ path: p, ruleId: m.ruleId, docPath: m.docPath, textPreview: m.text.slice(0, 200) }, null, 2) + '\n',
  );
}

main().catch((err) => {
  process.stderr.write(`[ocr-rules-check] ${err?.message ?? err}\n`);
  process.exit(1);
});
