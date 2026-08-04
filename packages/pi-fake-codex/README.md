# @NekoSekaiMoe/pi-fake-codex

Makes the [Pi coding agent](https://github.com/badlogic/pi-mono) impersonate the official OpenAI Codex CLI (`codex_cli_rs`) on **Codex Responses API** requests — at **two** layers: the identity headers *and* (for the plain `openai-responses` path) the request body.

## What it does

### 1. Header spoofing

Overwrites the two headers that fingerprint the client — and **only** those two — with the values the official Codex CLI sends, derived from the [Codex source](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/default_client.rs):

| Header        | Value                                                              |
| ------------- | ------------------------------------------------------------------ |
| `originator`  | `codex_cli_rs`  (Codex's `DEFAULT_ORIGINATOR`)                     |
| `User-Agent`  | `codex_cli_rs/{version} ({os} {osVersion}; {arch}) {terminal}`     |

`User-Agent` mirrors Codex's `get_codex_user_agent()` format and is run through the same printable-ASCII sanitization. Everything else about the request — endpoint, Authorization, `chatgpt-account-id`, `OpenAI-Beta`, `session-id`, the JSON body — is left exactly as pi / pi-ai set it (the body is rewritten separately, see below).

### 2. Body reshaping (`openai-responses` only)

Header spoofing alone is not enough for many **third-party / 国产 Responses providers** (DeepSeek, GLM, Kimi, …) used via `api: "openai-responses"`. Those backends only tolerate the request body layout the real Codex CLI sends, and pi's default `openai-responses` body differs in several ways that cause:

- **subagent tool calls rejected** with e.g. `Invalid subagent arguments. Use exactly one of: {agent,task,cwd?}, {tasks,cwd?}, or {chain,cwd?}.` (non-GPT models misread pi's body layout / tool binding),
- **`read` resolving to hallucinated absolute paths** (e.g. `ENOENT ... /Users/dev/workspace-4f37b6da/.../go.mod` — a symptom of the model mis-parsing context),
- occasional **`Error: terminated`** (upstream closes the stream early when it rejects a request field).

So this extension rewrites the `openai-responses` body to Codex's layout (`codex-rs/core/src/client.rs` `build_request()`), field by field:

| Field                   | Change                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `instructions`          | The base system prompt is **lifted** out of `input` (where pi inlines it as a `developer` role message) into a top-level `instructions` string, exactly like Codex. |
| `text`                  | Added as `{ verbosity: "low" }` (Codex always emits a `text` control object). Override via `PI_FAKE_CODEX_VERBOSITY`. |
| `parallel_tool_calls`   | Set to `true` when tools are present (Codex default).                                                           |
| `tool_choice`           | Set to `"auto"` when tools are present and not pinned (Codex default).                                          |
| `include`               | Forced to contain `reasoning.encrypted_content` (Codex always sets this). Existing entries are preserved.       |
| `prompt_cache_retention`| **Removed.** OpenAI-only; rejected by some third-party endpoints and never sent by Codex. `prompt_cache_key` is kept (Codex sends it). |

Every step is defensive and guarded; any unexpected structure short-circuits to the original body (we never break a working request).

The `openai-codex-responses` path (the `openai-codex` provider) is **not** body-rewritten: pi-ai already builds a Codex-shaped body for it (`buildRequestBody` uses `includeSystemPrompt: false`, `text`, `parallel_tool_calls`, …). Only its headers are spoofed.

## Scope (important)

**Headers** are spoofed on both OpenAI Responses-style APIs:

- `model.api === "openai-responses"` (plain OpenAI Responses API — used by many third-party providers) — **spoofed as Codex CLI**
- `model.api === "openai-codex-responses"` (the `openai-codex` provider, hitting `https://chatgpt.com/backend-api/codex/responses`) — **spoofed as Codex CLI**

**Body reshaping** applies only to `model.api === "openai-responses"` (the path that benefits third-party providers). `openai-codex-responses` is already Codex-shaped by pi-ai and is left untouched.

The discrimination is by **API protocol, not provider name**, so any third-party provider that speaks the Responses API (regardless of its `provider` string) is covered. These are **not** touched:

- `openai-completions` (Chat Completions) — unchanged
- Anthropic / Google / Bedrock / others — unchanged

If you want the impersonation to apply elsewhere, edit the `CODEX_APIS` set in `src/index.ts`.

## Configuration (optional)

All overrides are read once at startup. None are required. The header env vars only affect the *content* of the spoofed `User-Agent` / `originator`; `PI_FAKE_CODEX_VERBOSITY` affects the reshaped `openai-responses` body. Which APIs get spoofed is fixed (both Responses variants for headers; `openai-responses` only for the body).

| Env var                              | Default            | Purpose                                                                      |
| ------------------------------------ | ------------------ | ---------------------------------------------------------------------------- |
| `PI_FAKE_CODEX_VERSION`              | `0.145.0`          | Version segment of the User-Agent string.                                    |
| `PI_FAKE_CODEX_OS_TYPE`              | auto-detected      | OS type segment (e.g. `Linux`, `Mac OS`).                                    |
| `PI_FAKE_CODEX_OS_VERSION`           | auto-detected      | OS version segment.                                                          |
| `PI_FAKE_CODEX_ARCH`                 | `process.arch`     | Architecture segment (e.g. `x86_64`).                                        |
| `PI_FAKE_CODEX_TERMINAL`             | `unknown`          | Terminal descriptor segment.                                                 |
| `PI_FAKE_CODEX_VERBOSITY`            | `low`              | `text.verbosity` injected into the reshaped `openai-responses` body.         |
| `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` | *(unset)*          | Codex's own override env var; redirects the `originator` header to the given value (same behavior as the real client). |

## Install

```bash
# From npm
pi install npm:@NekoSekaiMoe/pi-fake-codex

# Local development
pi -e ./src/index.ts
```

There are no commands or shortcuts — the impersonation takes effect on load.

## `apply_patch` tool

This package also registers an LLM-callable `apply_patch` editing tool with the
same parameter schema, exact-replacement behavior, file mutation queue, and
result renderer as Pi's built-in `edit` — just under the name `apply_patch`.
Useful for agents whose editing instructions expect an `apply_patch`-named tool
(e.g. Codex-style prompts); it accepts `path` plus one or more
`edits[].oldText` / `edits[].newText` replacements rather than unified diff
text.

This is unrelated to the header/body impersonation; it lives here as a
packaging decision. If you only want the impersonation, the tool registration
in `src/apply-patch.ts` can be removed without affecting anything else.

## Codex-compatible hooks

This package also ships a hook engine that executes `.pi/hooks.json` in the
Codex CLI hooks format (ported from [pi-maestro-flow](https://github.com/catlog22/pi-maestro-flow),
MIT © catlog22; decoupled from its trust store, review TUI, and installer):

- **Config**: `<cwd>/.pi/hooks.json` → `{ "hooks": { "<Event>": [ { "matcher": "Bash|Write", "hooks": [ { "type": "command", "command": "...", "timeout": 600 } ] } ] } }`. Missing or empty file = completely inert.
- **Event mapping**: `SessionStart`→`session_start`, `UserPromptSubmit`→`input`, `PreToolUse`→`tool_call`, `PostToolUse`→`tool_result`, `PreCompact`→`session_before_compact`, `PostCompact`→`session_compact`, `Stop`→`agent_end`. `SubagentStart`/`SubagentStop`/`PermissionRequest` have no Pi mapping and are skipped with a warning.
- **Protocol**: the hook command gets a JSON payload on stdin (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `turn_id`, plus tool fields) and answers on stdout. Exit 2 + stderr blocks; `{"decision":"block","reason":...}` blocks; `hookSpecificOutput.additionalContext` injects context; `permissionDecision: allow|ask` + `updatedInput` rewrites PreToolUse arguments; `systemMessage` notifies the UI; `continue: false` cancels compaction / stops the turn.
- Only synchronous `command` hooks run (`prompt`/`agent`/`async` entries are skipped with a warning). 1 MB output cap; timed-out hooks get their whole process tree killed.
- **Security**: unlike pi-maestro-flow there is **no trust/review step** — a non-empty hooks.json runs as-is. A warning notification with the executable-hook count is shown once per session when a config activates; audit project hooks.json files yourself.

## Caveats

- **Headers** are rewritten on both `openai-responses` and `openai-codex-responses` requests pi itself makes. **Bodies** are rewritten only on `openai-responses`. Neither affects sub-processes, MCP servers, tools that make their own HTTP calls, Chat Completions (`openai-completions`), or any non-Responses API.
- The body rewrite is a best-effort normalization toward the Codex layout for compatibility with third-party Responses providers; it is not a guarantee that every provider will accept every field. If a field causes issues for a specific provider, the transformation in `src/payload.ts` is the place to adjust (each step is independent and guarded).
- Verified against pi internals (not just type signatures): `before_provider_request` is wired through pi-ai's `onPayload` (`core/sdk.js`), which `openai-responses.js` consumes as `nextParams` and `openai-codex-responses.js` as `nextBody` — the returned object replaces the request body in both paths. For `openai-codex-responses`, pi-ai's `buildBaseCodexHeaders` applies `additionalHeaders` (our map) after its own defaults, so our `originator`/`User-Agent` override pi's. For `openai-responses`, pi-ai passes our map through `new OpenAI({ defaultHeaders })`, and the OpenAI SDK's `buildHeaders` lists `defaultHeaders` *after* its own `User-Agent: getUserAgent()`, so the later value wins. End-to-end live rewriting against a real provider still requires a real Pi session, but the header-injection and body-replacement paths are both traced.

## License

BSD-2-Clause (`src/hooks/` is ported MIT code © catlog22, as noted in the file headers).
