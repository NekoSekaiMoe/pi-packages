# @NekoSekaiMoe/pi-fake-codex

A compatibility extension for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) that makes OpenAI Responses-style requests resemble traffic from the official OpenAI Codex CLI (`codex_cli_rs`).

The package also registers an `apply_patch` editing alias and executes opt-in Codex-compatible project hooks. These are separate features packaged together; none adds a slash command.

## Installation

```bash
pi install npm:@NekoSekaiMoe/pi-fake-codex
```

For local development from this package directory:

```bash
pi -e ./src/index.ts
```

All behavior activates when the extension loads. A missing or empty `.pi/hooks.json` leaves the hook engine inert.

## Why this exists

Some third-party Responses API implementations accept only the request shape they have observed from Codex CLI. Pi's normal `openai-responses` request is valid for OpenAI but differs from Codex in system-prompt placement, control fields, and cache options. On less complete providers, those differences can surface as rejected tool calls, hallucinated paths, or prematurely terminated streams.

`pi-fake-codex` normalizes the client identity and, where needed, the request body. It does not change credentials, choose a model, redirect the endpoint, or guarantee that an otherwise incompatible provider will work.

## Feature 1: Codex identity headers

For requests whose `model.api` is either:

```text
openai-responses
openai-codex-responses
```

the extension listens to `before_provider_headers` and overwrites only:

| Header | Default value |
| --- | --- |
| `originator` | `codex_cli_rs` |
| `User-Agent` | `codex_cli_rs/0.145.0 ({os} {version}; {arch}) unknown` |

Authorization, account IDs, beta flags, session IDs, endpoint selection, and all other headers remain owned by Pi and the selected provider.

The User-Agent is sanitized to printable ASCII, matching Codex's fallback behavior. OS detection is best effort; the default version segment can be overridden when exact fingerprinting matters.

### Header configuration

Environment variables are read when requests are built:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_FAKE_CODEX_VERSION` | `0.145.0` | Codex CLI version in the User-Agent |
| `PI_FAKE_CODEX_OS_TYPE` | auto-detected | OS label such as `Linux` or `Mac OS` |
| `PI_FAKE_CODEX_OS_VERSION` | best effort | OS/version segment |
| `PI_FAKE_CODEX_ARCH` | `process.arch` | Architecture segment |
| `PI_FAKE_CODEX_TERMINAL` | `unknown` | Terminal descriptor |
| `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` | unset | Override `originator`, matching Codex's own variable |

## Feature 2: `openai-responses` body normalization

The `before_provider_request` handler rewrites only requests where:

```text
model.api === "openai-responses"
```

`openai-codex-responses` already receives a Codex-shaped body from Pi and is left unchanged apart from the headers above.

### Transformations

| Field | Behavior |
| --- | --- |
| `instructions` | A leading `system` or `developer` message is removed from `input` and lifted into top-level instructions. Existing instructions are preserved and joined. |
| `text` | Added as `{ "verbosity": "low" }` when absent. |
| `parallel_tool_calls` | Set to `true` when tools exist and the caller did not set it. |
| `tool_choice` | Set to `"auto"` when tools exist and the caller did not set it. |
| `include` | Ensured to contain `reasoning.encrypted_content`; existing string entries are preserved. |
| `prompt_cache_retention` | Removed because it is OpenAI-specific and absent from Codex requests. |
| `prompt_cache_key` | Preserved. |

Override the injected verbosity with:

```bash
PI_FAKE_CODEX_VERBOSITY=medium
```

The transformer shallow-clones the body before editing it. Every structure-sensitive step is guarded. If the leading input item, message content, or `include` field has an unfamiliar shape, that part is left alone rather than guessed.

### API scope

| API protocol | Headers | Body |
| --- | ---: | ---: |
| `openai-responses` | Codex identity | Codex-normalized |
| `openai-codex-responses` | Codex identity | Unchanged |
| `openai-completions` | Unchanged | Unchanged |
| Anthropic, Google, Bedrock, and other protocols | Unchanged | Unchanged |

The matching is based on `model.api`, not the provider name. Requests made independently by subprocesses, MCP servers, or tools are outside this extension's provider hooks.

## Feature 3: `apply_patch`

The package registers an LLM-callable tool named `apply_patch`. It is an alias built from Pi's normal edit-tool definition, so it shares the same:

- parameter schema;
- exact-replacement semantics;
- file-mutation queue;
- validation behavior; and
- result renderer.

Example shape:

```json
{
  "path": "src/index.ts",
  "edits": [
    {
      "oldText": "const enabled = false;",
      "newText": "const enabled = true;"
    }
  ]
}
```

Despite its name, this tool does **not** accept unified diff text. Each `oldText` must match exactly and uniquely according to Pi's edit-tool rules. Multiple disjoint replacements for one file should be sent in one call, and all replacements are matched against the original file content.

The alias is useful for Codex-oriented prompts that expect an `apply_patch` tool name. It is independent of provider impersonation.

## Feature 4: Codex-compatible command hooks

If the current working directory contains `.pi/hooks.json`, the extension maps supported Codex hook events onto Pi lifecycle and tool events.

Example:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/check-tool.sh",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

### Event mapping

| Codex event | Pi event |
| --- | --- |
| `SessionStart` | `session_start` |
| `UserPromptSubmit` | `input` |
| `PreToolUse` | `tool_call` |
| `PostToolUse` | `tool_result` |
| `PreCompact` | `session_before_compact` |
| `PostCompact` | `session_compact` |
| `Stop` | `agent_end` |

`SubagentStart`, `SubagentStop`, and `PermissionRequest` have no Pi mapping and are skipped with a warning.

Only synchronous hooks with `type: "command"` are executed. Prompt, agent, and async hook entries are skipped. Hook commands receive a JSON payload on stdin containing session, transcript, working-directory, event, model, turn, and relevant tool fields.

Depending on the event, a hook response can:

- block through exit code `2` plus stderr;
- return `{ "decision": "block", "reason": "..." }`;
- inject `hookSpecificOutput.additionalContext`;
- return a PreToolUse `permissionDecision` and `updatedInput`;
- display a `systemMessage` in the UI; or
- use `continue: false` to cancel compaction or stop the current turn.

Hook output is capped at 1 MB. Timed-out command hooks have their process tree terminated.

### Security warning

**There is no hook trust or review store.** A non-empty `.pi/hooks.json` is executed as project configuration, and command hooks can run arbitrary local programs with the permissions of the Pi process. Audit this file before opening or working in an untrusted repository. The extension shows a warning once per session when executable hooks are activated, but that warning is not a sandbox.

## Internal flow

```text
src/index.ts          registers provider hooks, apply_patch, and hook adapter
src/headers.ts        builds and sanitizes Codex identity values
src/payload.ts        defensively normalizes openai-responses bodies
src/apply-patch.ts    registers the edit-tool alias
src/hooks/adapter.ts  maps Pi events to the hook engine
src/hooks/runner.ts   runs command hooks and enforces limits/timeouts
src/hooks/schema.ts   parses hook configuration and protocol values
```

## Caveats

- Header and body normalization improve compatibility; they do not make every Responses provider fully Codex-compatible.
- A provider can still reject fields, tool schemas, models, streaming behavior, or authentication independently of this extension.
- The default impersonated version is pinned in source and can become stale; use the environment override or update the package when exact identity matters.
- The body transformer intentionally targets `openai-responses` only. Extending it to another protocol requires a deliberate source change.
- End-to-end validation requires a real Pi session and provider because type-checking cannot verify remote behavior.

## Attribution and license

BSD-2-Clause. Files under `src/hooks/` are ported from `pi-maestro-flow` and retain MIT attribution to catlog22 in their source headers.
