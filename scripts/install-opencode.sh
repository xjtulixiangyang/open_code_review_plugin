#!/bin/bash
set -euo pipefail
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPN_DIR="${HOME}/.opencode/plugins/open-code-review"
echo "[install-opencode] installing to ${OPN_DIR}"
mkdir -p "${OPN_DIR}/skills" "${OPN_DIR}/agents"
find "${PLUGIN_DIR}/skills/" -name 'SKILL.md' -exec cp {} "${OPN_DIR}/skills/" \;
cp "${PLUGIN_DIR}/agents/ocr-reviewer-opencode.md" "${OPN_DIR}/agents/ocr-reviewer.md"
echo "[install-opencode] done"
