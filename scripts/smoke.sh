#!/usr/bin/env bash
# scripts/smoke.sh — 集成冒烟测试。不依赖 Claude Code，仅验证 bin/ CLI 串联可用。
# 通过：① ocr-prepare 能产出 context.json；② code_comment + task_done 写 jsonl/done；
# ③ ocr-aggregate 渲染 report.md/.json 且 partial=false。

set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d -t ocrp-smoke-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

echo "[smoke] plugin root: $PLUGIN_ROOT"
echo "[smoke] tmp repo:    $TMP"

cd "$TMP"
git init -q -b main 2>/dev/null || { git init -q && git checkout -q -b main; }
git config user.email smoke@test.local
git config user.name "smoke"

cat > a.ts <<'TS'
export function hello() {
  return "world";
}
TS
git add a.ts
git commit -q -m "init"

# 产生一个 modified diff
cat > a.ts <<'TS'
export function hello() {
  return "WORLD";
}
TS

# 跑 prepare
SUMMARY="$($PLUGIN_ROOT/bin/ocr-prepare workspace)"
echo "[smoke] prepare summary: $SUMMARY"
RUNID="$(echo "$SUMMARY" | grep -o '"runId": "[^"]*"' | head -1 | cut -d'"' -f4)"
if [ -z "$RUNID" ]; then
  echo "[smoke] FAIL: no runId in prepare output"
  exit 1
fi
if [ ! -f ".ocr-runs/$RUNID/context.json" ]; then
  echo "[smoke] FAIL: context.json missing"
  exit 1
fi

# --- Test 2: line relocation via ocr-relocate-apply ---
echo ""
echo "=== Test 2: line relocation ==="

# Create a comment with existing_code but wrong line number (99 instead of 1)
COMMENT_RELOCATE="$($PLUGIN_ROOT/bin/code_comment --runId "$RUNID" --path a.ts --start 99 --end 99 --content "Use const" --existing-code "export function hello() {" --subagent reviewer-b)"
RELOCATE_ID="$(echo "$COMMENT_RELOCATE" | grep -o '"comment_id":"[^"]*"' | head -1 | cut -d'"' -f4)"
if [ -z "$RELOCATE_ID" ]; then
  echo "FAIL: no comment_id in code_comment output"
  exit 1
fi
echo "Created comment $RELOCATE_ID with wrong line 99"

# Run ocr-relocate-apply
RELOCATE_OUTPUT=$("$PLUGIN_ROOT/bin/ocr-relocate-apply" --runId "$RUNID" --path a.ts 2>&1)
echo "ocr-relocate-apply output: $RELOCATE_OUTPUT"

# Check that relocation was written
RELOCATION_FILE=".ocr-runs/$RUNID/relocations/a.ts.json"
if [ ! -f "$RELOCATION_FILE" ]; then
  echo "FAIL: relocation file not found at $RELOCATION_FILE"
  ls -la ".ocr-runs/$RUNID/relocations/" 2>/dev/null || echo "no relocations dir"
  exit 1
fi
echo "PASS: relocation file created"

# Check that the line was relocated from 99 to 1
RELOCATED_LINE=$(cat "$RELOCATION_FILE" | grep -o '"resolved_start_line": [0-9]*' | head -1 | grep -o '[0-9]*')
if [ "$RELOCATED_LINE" != "1" ]; then
  echo "FAIL: Expected resolved line 1, got $RELOCATED_LINE"
  cat "$RELOCATION_FILE"
  exit 1
fi
echo "PASS: ocr-relocate-apply relocated line from 99 to 1"

# 模拟 reviewer subagent 行为
COMMENT_KEEP="$($PLUGIN_ROOT/bin/code_comment --runId "$RUNID" --path a.ts --start 2 --end 2 --content "Magic string" --subagent reviewer-a)"
COMMENT_HIDE="$($PLUGIN_ROOT/bin/code_comment --runId "$RUNID" --path a.ts --start 2 --end 2 --content "Duplicate noise" --subagent reviewer-a)"
HIDE_ID="$(echo "$COMMENT_HIDE" | grep -o '"comment_id":"[^"]*"' | head -1 | cut -d'"' -f4)"
if [ -z "$HIDE_ID" ]; then
  echo "[smoke] FAIL: no comment_id in code_comment output"
  exit 1
fi
FILTER_INPUT="{\"path\":\"a.ts\",\"decisions\":[{\"comment_id\":\"$HIDE_ID\",\"action\":\"hide\",\"reason\":\"duplicate smoke comment\"}]}"
"$PLUGIN_ROOT/bin/ocr-filter-apply" --runId "$RUNID" --path a.ts --input "$FILTER_INPUT" --subagent filter-a >/dev/null
"$PLUGIN_ROOT/bin/task_done" --runId "$RUNID" --subagent reviewer-a --file a.ts >/dev/null
"$PLUGIN_ROOT/bin/task_done" --runId "$RUNID" --subagent reviewer-b --file a.ts >/dev/null

# 跑 aggregate
AGG="$($PLUGIN_ROOT/bin/ocr-aggregate --runId "$RUNID")"
echo "[smoke] aggregate: $AGG"

if [ ! -f ".ocr-runs/$RUNID/report.md" ]; then
  echo "[smoke] FAIL: report.md missing"
  exit 1
fi
if [ ! -f ".ocr-runs/$RUNID/report.json" ]; then
  echo "[smoke] FAIL: report.json missing"
  exit 1
fi

grep -q "Magic string" ".ocr-runs/$RUNID/report.md" || { echo "[smoke] FAIL: kept comment not in report.md"; exit 1; }
if grep -q "Duplicate noise" ".ocr-runs/$RUNID/report.md"; then
  echo "[smoke] FAIL: hidden comment present in report.md"
  exit 1
fi
grep -q '"status": "success"' ".ocr-runs/$RUNID/report.json" || { echo "[smoke] FAIL: report.json status != success"; exit 1; }
grep -q '"filtered_comments": 1' ".ocr-runs/$RUNID/report.json" || { echo "[smoke] FAIL: report.json filtered_comments != 1"; exit 1; }

# rules_check 冒烟
RC="$($PLUGIN_ROOT/bin/ocr-rules-check a.ts)"
echo "[smoke] rules-check: $RC"
echo "$RC" | grep -q '"docPath": "ts_js_tsx_jsx.md"' || { echo "[smoke] FAIL: rules-check docPath"; exit 1; }

echo "[smoke] PASS"
