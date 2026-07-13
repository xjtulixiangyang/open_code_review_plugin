# Task 7 Report: Verify prompt, hook, and smoke documentation consistency

## Files Changed

| File | Change |
|---|---|
| `commands/review.md` | Threshold `> 50` -> `>= 50`; aggregate command now includes `--format <markdown|json|both>`; added default-format sentence |
| `skills/ocr-plan/SKILL.md` | Threshold `> 50` -> `>= 50` for consistency with review.md |
| `src/core/report/json.ts` | Status value `'success'` -> `'ok'` (OCR-compatible); type union updated |
| `src/core/report/__tests__/json.test.ts` | Test assertion updated to expect `'ok'` |

Files checked but no change needed: `README.md` (already documents `--format`), `skills/ocr-review-file/SKILL.md` (no threshold/status references), `src/core/prompts/__tests__/skill_consistency.test.ts` (no threshold/status references).

## Tests Run

- `npm test -- src/core/prompts/__tests__/skill_consistency.test.ts` — 7/7 PASS
- `npm run build` — exit 0, `bin/ocr-plan-guidance` generated
- `npm run smoke` — PASS (required the `status: 'ok'` fix to pass)
- `npm test` (full suite) — 5/5 PASS (skill_consistency tests are excluded by glob pattern; verified they pass when run explicitly)

## Commit Hash

`bb1aaf4`

## Self-Review

- Step 1: Prompt consistency test passed on first run; no changes needed to skill texts or TS constants.
- Step 2: `commands/review.md` already had correct "No changes to review." text.
- Step 3: Threshold changed from `> 50` to `>= 50` in both `commands/review.md` and `skills/ocr-plan/SKILL.md`.
- Step 4: `--format` flag added to aggregate command; default-format sentence added.
- Step 5: Build succeeded. Smoke initially failed because `report.json` used `"status": "success"` but smoke expects `"status": "ok"` (OCR convention). Fixed `json.ts` type and value, updated test. Smoke then passed.
- Step 6: Committed 4 files. README.md, ocr-review-file/SKILL.md, and skill_consistency.test.ts had no changes needed.
- Global constraints respected: no runtime deps/LLM SDK, OCR-compatible field names preserved, no forbidden files committed.

## Concerns

- The status value change from `'success'` to `'ok'` was necessary for smoke to pass but was not listed in the task brief. It is a legitimate OCR-compatibility fix that aligns with the project's existing conventions (smoke.sh line 66 checks for `"status": "ok"`).
- The `npm test` glob pattern `src/**/__tests__/*.test.ts` does not match `skill_consistency.test.ts` in the p0-closeout-migration worktree (it did match in the original repo). This is a pre-existing glob issue, not a regression.

## Fix: Task 7 review finding (2026-06-29)

**Finding:** `commands/review.md` Step 1 missing the second sentence: "This is a successful skipped review, not a hard failure."

**Change:** Added the sentence after "If `fileCount` is 0 → tell the user 'No changes to review.' and stop." on line 27.

**Verification:** `grep -n "This is a successful skipped review, not a hard failure." commands/review.md` returned line 27 with the exact sentence.

**Commit:** `e2c8a2a`
