# @NekoSekaiMoe/pi-smart-flow

A lightweight workflow extension for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). It improves delegation guidance and long-running command handling without introducing its own orchestration runtime.

The package contains three independent pieces:

1. a system-prompt nudge for effective `subagent` use;
2. an adaptive foreground/background shell tool named `bash_bg`; and
3. a provider-based observation tool named `observe`.

## Installation

```bash
pi install npm:@NekoSekaiMoe/pi-smart-flow
```

For local development from this package directory:

```bash
pi -e ./src/index.ts
```

There are no slash commands or configuration files. All three components register when the extension loads.

## Relationship to `pi-subagents`

`pi-smart-flow` complements a separately installed subagent extension. It does not create agents, schedule chains, manage worktrees, or replace `pi-subagents`.

Only the delegation nudge depends on the presence of an active tool named `subagent`. `bash_bg` and `observe` remain useful on their own.

## Delegation nudge

On `before_agent_start`, the extension appends a stable `<delegation_guidance>` block to the current system prompt when both conditions are true:

- `PI_SMART_FLOW_NUDGE` is not `0`; and
- `pi.getActiveTools()` includes `subagent`.

The guidance tells the model to delegate multi-file exploration, bulky output, and independent workstreams while keeping small known-file tasks inline. It also recommends:

- async-first delegation;
- explicit `GOAL`, `CONTEXT`, `EXPECTED OUTPUT`, and `STOP RULES`;
- file-only outputs for large reports;
- a single writer per working directory; and
- a fresh investigation or user decision after repeated failures.

The text is constant so repeated turns keep a stable prompt-cache prefix.

Disable only this feature with:

```bash
PI_SMART_FLOW_NUDGE=0 pi
```

This does not disable `bash_bg` or `observe`.

## `bash_bg`: adaptive shell execution

`bash_bg` handles commands that may outlive a normal blocking tool call.

### Actions

| Action | Behavior |
| --- | --- |
| `run` | Start a command and block for up to `timeout` seconds. Return normal output if it finishes; otherwise convert it to a tracked background job and return a `jobId`. |
| `start` | Start in the background immediately and return a `jobId`. |
| `status` | Read one job's current state and recent output. |
| `wait` | Block for one job until it finishes or the requested wait timeout expires. |
| `kill` | Terminate the job's process tree. |
| `list` | List tracked jobs. |

Use `run` when command duration is uncertain:

```json
{
  "action": "run",
  "command": "yarn typecheck",
  "timeout": 30
}
```

Use `start` for servers, watchers, log followers, and clearly long-running work:

```json
{
  "action": "start",
  "command": "yarn dev",
  "cwd": "/workspace/project"
}
```

### Completion behavior

When a background job finishes, the extension injects a `bash-bg-complete` message with turn triggering enabled. The agent can continue without repeatedly polling `status`.

Running jobs are re-announced after context compaction. On session shutdown, tracked jobs are terminated so they do not become orphan processes.

### Output and process management

- Output is streamed to a temporary log file.
- The in-memory tail is capped at 64 KB.
- Log retention is capped at 16 MB by default.
- Truncated results include the log path and a command for viewing it.
- Unix termination targets the process group, escalating from `SIGTERM` to `SIGKILL` when necessary.
- Windows uses `taskkill /T /F` to terminate the tree.
- The default implementation permits up to 16 active jobs and retains up to 64 completed jobs.

Job states include `running`, `stopping`, `completed`, `failed`, and `killed`. `bash_bg` also emits `bash-bg:update` and answers `bash-bg:query` events for UI extensions that want a live job panel.

## `observe`: unified status and waiting

`observe` provides one interface for one or more background systems. Targets have a provider kind and provider-specific ID:

```json
{
  "kind": "bash_bg",
  "id": "job-id"
}
```

`bash_bg` registers itself as an observation provider automatically. Other extensions can register providers through `registerObservationProvider()` from `src/observation.ts`.

### Actions

#### `status`

Returns a one-shot snapshot for every target.

#### `wait`

Blocks on a barrier with one overall timeout:

- `waitMode: "all"` waits for every target;
- `waitMode: "any"` returns after the first target settles; and
- `waitMode: "count"` returns after `waitCount` targets settle.

Set `until: "completed"` to require terminal lifecycle completion rather than the earlier `result-ready` boundary.

#### `watch`

Polls all targets until `timeoutMs` and returns the status-transition timeline, recording changes such as:

```text
active → stopping → settled
```

Use this when the progression itself matters. For a simple wait, prefer `wait` because it uses the provider's blocking mechanism instead of a polling timeline.

### Detail levels

| Detail | Intended use |
| --- | --- |
| `summary` | Compact state and outcome; default |
| `tail` | Recent target detail |
| `full` | Expanded recent output and metadata |

The observation registry is process-global under a shared symbol, allowing cooperating extensions to discover providers without direct imports. Providers advertise capabilities such as inspect, wait, cancel, message, or supervision.

## Recommended usage

- Use built-in `bash` for short, bounded commands.
- Use `bash_bg.run` when duration is uncertain and foreground output is still desirable.
- Use `bash_bg.start` when the command should be asynchronous immediately.
- Do not poll a background job in a tight loop; rely on completion notifications or one bounded `observe.wait`.
- Use `observe` for multi-target barriers and mixed provider kinds.
- Request `detail: "full"` only when output is needed; summary snapshots preserve agent context.

## Architecture

```text
src/index.ts        registers all three components
src/nudge.ts        conditional system-prompt augmentation
src/bash-bg.ts      jobs, logs, process trees, notifications, and provider adapter
src/observation.ts  provider registry and status/wait/watch engine
src/observe.ts      LLM-callable observe tool and schema
src/quiet-render.ts compact TUI rendering helpers
```

`bash_bg` and the observation implementation were ported from `pi-maestro-flow` and decoupled from its teammate runtime. The package deliberately keeps orchestration out of scope.

## Limitations and security

- Shell commands run with the same permissions and environment as Pi. Tool approval and repository trust still matter.
- Output limits prevent unbounded memory and log growth, but commands can consume CPU, network, disk, and child processes until they finish or are killed.
- Completion notifications wake the agent; they do not guarantee that the next model action is correct.
- Only installed observation providers can resolve a target kind. Unknown providers return a `not-found` observation.
- Process-tree termination is best effort across operating systems and unusual daemonization strategies.

## Attribution and license

BSD-2-Clause. `bash-bg.ts`, `observation.ts`, `observe.ts`, and `quiet-render.ts` are ported from `pi-maestro-flow` and retain MIT attribution to catlog22 in their source headers.
