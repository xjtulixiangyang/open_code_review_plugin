# Task 3 Report: Short-circuit /review preview mode and update docs

**Status**: Completed

**Commit**: `241283e1a20b8eb0ac3a749fff32fa2770d91987`

## Changes Made

### `commands/review.md`
- **Step 1**: Updated prepare stdout field list to include `preview`, `dryRun`, `rulesSource`, and `excludedFileCount`
- **Preview short-circuit**: Added block after no-changes handling (before Step 2) that checks `preview == true` or `dryRun == true`, reads `context.json`, replies with structured preview summary, and stops without running Steps 2-4
- **Error table**: Updated `OCRP-RUN-011` from "unsupported P0 flag" to "unsupported flag" and removed reference to `--preview/--dry-run`

### `README.md`
- **Flags table**: Added `--preview`, `-p` and `--dry-run` rows with descriptions
- **Replaced stale P1 wording**: Removed "P1 planned flags ... rejected in P0" paragraph, replaced with paragraph documenting preview/dry-run as supported prepare-only mode
- **Troubleshooting table**: Updated `OCRP-RUN-011` row to remove stale P1 language

## Validation

- Grep for stale unsupported patterns (`planned for P1 preview mode`, `preview.*unsupported`, `dry-run.*unsupported`, `avoid P1 flags such as --preview`) returned no matches across `commands/review.md`, `README.md`, and `src/cli/prepare.ts`

## Files Modified
- `commands/review.md`
- `README.md`
