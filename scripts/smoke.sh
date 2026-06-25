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

# 模拟 reviewer subagent 行为
"$PLUGIN_ROOT/bin/code_comment" --runId "$RUNID" --path a.ts --start 2 --end 2 --content "Magic string" --subagent reviewer-a >/dev/null
"$PLUGIN_ROOT/bin/task_done" --runId "$RUNID" --subagent reviewer-a --file a.ts >/dev/null

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

grep -q "Magic string" ".ocr-runs/$RUNID/report.md" || { echo "[smoke] FAIL: comment not in report.md"; exit 1; }
grep -q '"status": "ok"' ".ocr-runs/$RUNID/report.json" || { echo "[smoke] FAIL: report.json status != ok"; exit 1; }

# rules_check 冒烟
RC="$($PLUGIN_ROOT/bin/ocr-rules-check a.ts)"
echo "[smoke] rules-check: $RC"
echo "$RC" | grep -q '"docPath": "ts_js_tsx_jsx.md"' || { echo "[smoke] FAIL: rules-check docPath"; exit 1; }

echo "[smoke] PASS"
