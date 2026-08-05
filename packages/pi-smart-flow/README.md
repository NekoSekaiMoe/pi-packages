# @NekoSekaiMoe/pi-smart-flow

A lightweight delegation-experience layer for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), built to complement [pi-subagents](https://www.npmjs.com/package/pi-subagents). Three pieces, no orchestration runtime:

## 1. Delegation nudge

Appends a compact `<delegation_guidance>` block to the system prompt on every agent start — when to delegate (multi-file exploration, bulk output, independent workstreams) vs. work inline (known-file read, single-symbol lookup), how to write the task contract (GOAL / CONTEXT / EXPECTED OUTPUT / STOP RULES), and async-first usage.

- Only injected when the `subagent` tool is actually active (no pi-subagents → no misleading guidance).
- Constant string: keeps the prompt-cache prefix stable.
- Disable with `PI_SMART_FLOW_NUDGE=0`.

## 2. `bash_bg` — adaptive shell

Ported from pi-maestro-flow. Six actions: `run | start | status | wait | kill | list`.

- `run` (recommended default) blocks like the built-in `bash` tool for up to `timeout` seconds; if the command is still running it auto-backgrounds and returns a `jobId`. Completion injects a `bash-bg-complete` message with `triggerTurn`, so the agent wakes up on its own — no polling.
- Output is captured to a temp log file (16 MB cap, 64 KB in-memory tail); `kill` terminates the whole process tree (SIGTERM → SIGKILL escalation; `taskkill /T /F` on Windows).
- Re-announces running jobs after compaction; kills all jobs on session shutdown (no orphans).
- Emits `bash-bg:update` / answers `bash-bg:query` events for any UI that wants a live job panel.

## 3. `observe` — blocking observation

Ported from pi-maestro-flow. One status/wait/watch interface over pluggable observation providers:

- `status`: one-shot snapshot · `wait`: block on an all/any/count barrier (default timeout 10 min) · `watch`: poll and return the full status-transition timeline.
- Targets are `{ kind, id }`. `bash_bg` registers itself as a provider automatically; other extensions can join via `registerObservationProvider` (see `src/observation.ts`).

## Usage

```bash
pi -e ./src/index.ts
pi install npm:@NekoSekaiMoe/pi-smart-flow
```

No commands, no config files. All three pieces activate on load.

## Attribution

`src/bash-bg.ts`, `src/observation.ts`, `src/observe.ts`, and `src/quiet-render.ts` are ported from [pi-maestro-flow](https://github.com/catlog22/pi-maestro-flow) (MIT, Copyright (c) 2026 catlog22), decoupled from its teammate runtime. The nudge wording is inspired by its `.pi/SYSTEM.md`.

## License

BSD-2-Clause (ported files remain MIT © catlog22, as noted in their headers).
