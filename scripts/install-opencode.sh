#!/bin/bash
set -euo pipefail
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPN_DIR="${HOME}/.config/opencode"

echo "[install-opencode] installing to ${OPN_DIR}"

# commands — /review entry
mkdir -p "${OPN_DIR}/commands"
cp "${PLUGIN_DIR}/commands/review-opencode.md" "${OPN_DIR}/commands/review.md"
echo "  command: ${OPN_DIR}/commands/review.md"

# skills (subdirectory for the review skill group)
mkdir -p "${OPN_DIR}/skills/open-code-review"
for skill in ocr-plan ocr-relocate ocr-review-file ocr-review-filter; do
  cp "${PLUGIN_DIR}/skills/${skill}/SKILL.md" "${OPN_DIR}/skills/open-code-review/${skill}.md"
  echo "  skill: ${OPN_DIR}/skills/open-code-review/${skill}.md"
done

# agent
mkdir -p "${OPN_DIR}/agents"
cp "${PLUGIN_DIR}/agents/ocr-reviewer-opencode.md" "${OPN_DIR}/agents/ocr-reviewer.md"
echo "  agent: ${OPN_DIR}/agents/ocr-reviewer.md"

echo "[install-opencode] done"
