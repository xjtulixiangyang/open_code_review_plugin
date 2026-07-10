# opencode HostAdapter

Cross-host adapter for OpenCode. Review command, skills, and agents are
installed to `~/.config/opencode/` via `scripts/install-opencode.sh`.

## Installation

```bash
./scripts/install-opencode.sh
```

## Differences from Claude Code

| Feature | Claude Code | OpenCode |
|---|---|---|
| Parallel review | ✅ batches of `reviewConcurrency` | ❌ sequential (single-agent) |
| Event bus | ✅ events.jsonl + hooks | ❌ not available |
| Custom rules | ✅ (same CLI) | ✅ (same CLI) |
| Resume | ✅ (same CLI) | ✅ (same CLI) |
| Preview / dry-run | ✅ | ✅ |

## Tool name convention

OpenCode uses **lowercase** tool names (`allowed-tools` frontmatter). The
adapter and agent definitions export this mapping automatically.

## Testing

After install, verify with:

```bash
opencode debug skill                 # should list open-code-review skills
opencode debug agent ocr-reviewer    # should show reviewer agent
```
