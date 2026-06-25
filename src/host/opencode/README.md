# opencode HostAdapter (placeholder, P1+)

This directory is reserved for the future opencode HostAdapter implementation.
P0 of open-code-review-plugin only targets Claude Code (see ../claude-code/).

To add opencode support later:
1. Mirror `../claude-code/hook_handler.ts` to `./hook_handler.ts`.
2. Add a `commands/`, `agents/`, `skills/` set appropriate to opencode's plugin
   contract (the design assumes the same `bin/` CLI shape works unchanged).
3. Update `.claude-plugin/plugin.json` or add a sibling `.opencode-plugin/plugin.json`.

See `docs/superpowers/specs/2026-06-24-opencodereview-plugin-design.md` §1 for the cross-host alignment rationale.
