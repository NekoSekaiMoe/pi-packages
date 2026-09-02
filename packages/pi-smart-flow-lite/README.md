# @NekoSekaiMoe/pi-smart-flow-lite

The slimmed sibling of [`pi-smart-flow`](../pi-smart-flow/) for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) — same delegation experience, smaller prompt footprint. Three components, no orchestration runtime:

## 1. Delegation nudge (slimmed)

Appends a compact `<delegation_guidance>` block to the system prompt on every agent start — *only* when the `subagent_spawn` tool (from `pi-subagents`) is actually active, so the guidance never points at a tool the model cannot call.

Slimmed 2026-09: every bullet already covered by `pi-subagents`' own tool guidelines (work-inline-when, async-first, role picking, file-only outputMode) was removed. What remains is the unique guidance (~90 tokens, down from ~250): when exploration/bulk output would flood the main context, the GOAL / CONTEXT / EXPECTED OUTPUT / STOP RULES contract, single-writer discipline, and the three-failures stop rule.

- Constant string → stable prompt-cache prefix.
- Disable with `PI_SMART_FLOW_NUDGE=0` (does not affect the other components).

## 2. `bash_bg` — adaptive shell

Identical to `pi-smart-flow`'s. Six actions: `run | start | status | wait | kill | list`.

- `run` (recommended default) blocks like the built-in `bash` tool for up to `timeout` seconds; if the command is still running it auto-backgrounds and returns a `jobId`. Completion injects a `bash-bg-complete` message with `triggerTurn`, so the agent wakes up on its own — no polling.
- Output is captured to a temp log file (16 MB cap, 64 KB in-memory tail); `kill` terminates the whole process tree (SIGTERM → SIGKILL escalation; `taskkill /T /F` on Windows).
- Re-announces running jobs after compaction; kills all jobs on session shutdown (no orphans).
- Emits `bash-bg:update` / answers `bash-bg:query` events for any UI that wants a live job panel.

## 3. Compact thinking

Identical to `pi-smart-flow`'s. `/compact-thinking [on|off]` toggles a mode (persisted in `<agentDir>/pi-smart-flow.json`, default off) that hides raw thinking blocks and replaces them with a `• Thought 12s`-style transcript row: traces of ≤3 non-empty lines are shown verbatim, longer ones are summarized by a nested call to the current model. Summaries are TUI-only entries — the assistant message and its thinking signatures are never modified.

## What was removed relative to pi-smart-flow

- **`observe` tool** — dropped 2026-09 (no other observation providers exist; `bash_bg` `wait` covers the need, saving ~659 prompt tokens). The tool file is gone; `observation.ts` stays on disk because `bash_bg` still uses it as its internal provider/wait engine.
- **Full-length nudge** — see above (`nudge.ts.bak` keeps the original).

## Usage

```bash
pi -e ./src/index.ts          # from this package directory
pi install npm:@NekoSekaiMoe/pi-smart-flow-lite
```

No configuration files. All three components activate on load (the nudge only when `subagent_spawn` is active).

## Attribution

`src/bash-bg.ts`, `src/observation.ts`, and `src/quiet-render.ts` are ported from [pi-maestro-flow](https://github.com/catlog22/pi-maestro-flow) (MIT, Copyright (c) 2026 catlog22), decoupled from its teammate runtime.

## License

BSD-2-Clause (ported files remain MIT © catlog22, as noted in their headers).
