---
name: verify
description: Drive the built review orchestration CLI through a real temporary git repository.
---

# Verify deterministic review orchestration

1. Run `npm run build`.
2. Create a temporary git repository with at least two committed files, then modify both.
3. Drive only `bin/` commands: `ocr-prepare`, `ocr-orchestrator-start --runId`, claim, ack, structured `code_comment`, structured `task_done`, reconcile, and `ocr-aggregate --strict true`.
4. Observe both `findings` and `no_findings` outcomes and require completed state plus strict exit 0.
5. Prepare/start the unchanged snapshot twice and require the second start to return the first `effectiveRunId` with `resumed: true`.
6. Change one diff and require a new run plus old run state `superseded`.
7. Exhaust two dispatch attempts for one file, complete the other file, and require strict aggregate exit 1 with failed path, `attemptsUsed: 2`, and `retry_exhausted`.
8. Confirm `.ocr-runs/**` never appears in a subsequent prepare's review files.

Use a private temp directory and remove it on exit. Capture JSON stdout for evidence; tests and typecheck are not runtime verification.
