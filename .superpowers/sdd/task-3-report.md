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
