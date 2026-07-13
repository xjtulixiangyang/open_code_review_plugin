# Task 3 Report: Immutable Manifests and Effective Run Selection

**Status**: Completed

**Commit**: `6200d7f feat(orchestrator): add manifest and effective run selection`

## Files Changed

| File | Action |
|------|--------|
| `src/core/orchestrator/fingerprint.ts` | Created |
| `src/core/orchestrator/manifest.ts` | Created |
| `src/cli/orchestrator_start.ts` | Created |
| `src/core/orchestrator/__tests__/manifest.test.ts` | Created |
| `src/cli/__tests__/orchestrator_start.test.ts` | Created |

## Tests

### manifest.test.ts (17 tests, all pass)

- **canonicalJson** (3 tests): sorts keys recursively, preserves array order, handles nested arrays/objects
- **sha256** (2 tests): produces hex digest, deterministic
- **repositoryIdentity** (1 test): stable hash for git repo
- **buildManifest** (4 tests): stable manifest with correct fingerprints, file order matches context order, diff fingerprint sensitive to file content order, diff fingerprint unambiguous across file boundaries
- **manifestDigest** (1 test): deterministic hash
- **selectEffectiveRun** (5 tests): fresh start (no prior runs), resume compatible active run, supersede on changed diff, never resume without schema-1 manifest, never resume completed/failed runs
- **startCandidate** (1 test): high-level API returns compatible active run

<<<<<<< Updated upstream
### orchestrator_start.test.ts (3 tests, all pass)

- Fresh start JSON output
- Resume compatible active run via CLI
- Supersede on changed diff via CLI

## Commands and Results

```bash
# Run manifest tests
node --import tsx --test --test-concurrency=1 src/core/orchestrator/__tests__/manifest.test.ts
# Result: 17 pass, 0 fail

# Run CLI tests
node --import tsx --test --test-concurrency=1 src/cli/__tests__/orchestrator_start.test.ts
# Result: 3 pass, 0 fail

# Typecheck
npm run typecheck
# Result: 0 errors
```

## Self-Review

### Architecture
- `fingerprint.ts` provides pure functions for canonical JSON, SHA-256 hashing, repository identity, file fingerprints, full diff fingerprints, args fingerprints, manifest building, and manifest digest
- `manifest.ts` provides `selectEffectiveRun` (core selection logic) and `startCandidate` (high-level entry point)
- `orchestrator_start.ts` is a thin CLI wrapper around `startCandidate`
- Existing interfaces (`types.ts`, `storage.ts`, `lock.ts`, `store.ts`) are unchanged

### Key Design Decisions
1. **Canonical JSON**: Object keys sorted recursively, array order preserved. Ensures deterministic fingerprinting regardless of key insertion order.
2. **Repository identity**: SHA-256 of normalized repo root + origin URL + HEAD commit. Stable across runs on the same repo.
3. **Full diff fingerprint**: Hashes canonical array of `{path, oldPath, status, diff, truncated}` entries. Unambiguous across file boundaries because each file is a separate object element, not concatenated strings.
4. **Resume conditions**: Only active schema-1 runs with matching repo/args/diff fingerprints and valid manifest integrity (digest check) can be resumed.
5. **Supersede**: When a new candidate has a different diff, the newest active schema-1 run for the same repo identity is superseded (state set to `superseded`, `supersededBy` and `supersededAt` recorded).
6. **Candidate stays diagnostic**: When resuming, the candidate context directory is left as-is (not overwritten). The old manifest and tasks are never modified.

### Concerns
- `resolveExistingRunDir` in `store.ts` depends on `process.cwd()`. Tests must `chdir()` to the temp root before calling `selectEffectiveRun` or `startCandidate`. This is consistent with how other tests in the codebase work.
- The `startCandidate` function reads `context.repoRoot` from the stored context. If the repo root changes between prepare and start, the repository identity will differ and resume will not match. This is correct behavior.
=======
## Files Modified
- `commands/review.md`
- `README.md`

## Step 1: Fix review.md duplicate retry bullets — COMPLETE

**What was done:**
- Removed the old duplicate retry bullets (old lines 111-113) from `commands/review.md`:
  - `4. Retry reviewer dispatch at most once for the same file when the subagent errors, times out, or returns without a matching ...`
  - `5. If both attempts fail, continue to the next file and let ocr-aggregate report the file as partial ...`
  - (plus the blank line between old and new items)
- Kept only the new exact wording (now at lines 111-116):
  - `4. Retry reviewer dispatch exactly once for the same file when any of these happens:`
  - `5. If both attempts fail, continue to the next file and let ocr-aggregate report the file as partial (OCRP-SUB-050/051). A partial file means review did not complete for that file; it must not be described as a clean no-issue result.`

**Verification:**
```
$ grep -n "Retry reviewer dispatch\|must not be described as a clean no-issue result\|Do not summarize the run as" commands/review.md
111:4. Retry reviewer dispatch exactly once for the same file when any of these happens:
115:5. If both attempts fail, continue to the next file and let `ocr-aggregate` report the file as partial (`OCRP-SUB-050/051`). A partial file means review did not complete for that file; it must not be described as a clean no-issue result.
168:If `partial == true`, prefix your message with: `⚠️ Some files did not complete review; see Warnings section.` Do not summarize the run as "no issues found" without also saying the review was incomplete for `partialFiles[]`.
```
Only one occurrence of each retry phrase remains. The "Do not summarize" line at line 168 is in Step 5 (final response) and is correct/expected.

**Commit:**
```
2d9a9a6..a4b4b35  main -> main
fix(review): remove duplicate retry bullets, keep exact wording
```
>>>>>>> Stashed changes
