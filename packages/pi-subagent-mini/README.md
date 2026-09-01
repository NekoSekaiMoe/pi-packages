# pi-subagent-mini

Lean single-tool subagent extension for [pi](https://github.com/earendil-works/pi).
**Zero runtime dependencies** — no node_modules needed.

One tool (`subagent`), four actions, ~296 prompt tokens (vs 1,563 for the
5-tool suite it replaces):

| action | what it does |
| --- | --- |
| `spawn` | Start an isolated child pi session (`pi --mode json -p --no-session -ne`) with a tool allowlist; returns a `jobId` immediately |
| `wait` | Block until done (max 120s), return full report |
| `status` | State + report tail |
| `kill` | Stop it |

On completion a `subagent-complete` steering message delivers the report as a
**new turn** — the main conversation only ever sees the final report, never the
child's intermediate work.

## Parameters

- `action`: spawn / wait / status / kill
- `task` (spawn): full task incl. role, e.g. "You are a code reviewer; review X and report findings"
- `tools` (spawn): comma list, default `read,bash,grep,find,ls`; add `write,edit` only when the child should modify files
- `cwd` (spawn): working directory (default: session cwd)
- `model` / `timeoutSec` (spawn): optional; timeout default 600s
- `jobId` (wait/status/kill)

Design trade-offs (deliberate, to stay lean): no agent registry, no mailbox —
follow-up questions are handled by spawning a new subagent with context from
the previous report (stated in the tool description so the model knows).
Max 4 concurrent subagents. `-ne` in children also prevents recursive spawning.

## Notes

- Children are fully isolated: own minimal prompt (~1.7k tokens), ephemeral
  (`--no-session`), results truncated at 6k chars in the notification
  (`action=status` shows the rest).
- Uses the same subprocess mechanism as the big suites (`--mode json` NDJSON
  events), just without the orchestration/TUI/config layers.
