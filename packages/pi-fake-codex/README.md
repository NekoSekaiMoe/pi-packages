# @NekoSekaiMoe/pi-fake-codex

Makes the [Pi coding agent](https://github.com/badlogic/pi-mono) impersonate the official OpenAI Codex CLI (`codex_cli_rs`) on **Codex Responses API** requests.

## What it does

This extension overwrites the two headers that fingerprint the client — and **only** those two — with the values the official Codex CLI sends, derived from the [Codex source](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/default_client.rs):

| Header        | Value                                                              |
| ------------- | ------------------------------------------------------------------ |
| `originator`  | `codex_cli_rs`  (Codex's `DEFAULT_ORIGINATOR`)                     |
| `User-Agent`  | `codex_cli_rs/{version} ({os} {osVersion}; {arch}) {terminal}`     |

`User-Agent` mirrors Codex's `get_codex_user_agent()` format and is run through the same printable-ASCII sanitization. Everything else about the request — endpoint, Authorization, `chatgpt-account-id`, `OpenAI-Beta`, `session-id`, the JSON body — is left exactly as pi / pi-ai set it. The goal is to make requests to **third-party** OpenAI-compatible providers look indistinguishable from real Codex CLI traffic.

## Scope (important)

Both **OpenAI Responses-style** APIs are affected:

- `model.api === "openai-responses"` (plain OpenAI Responses API — used by many third-party providers) — **spoofed as Codex CLI**
- `model.api === "openai-codex-responses"` (the `openai-codex` provider, hitting `https://chatgpt.com/backend-api/codex/responses`) — **spoofed as Codex CLI**

The discrimination is by **API protocol, not provider name**, so any third-party provider that speaks the Responses API (regardless of its `provider` string) is covered. These are **not** touched:

- `openai-completions` (Chat Completions) — unchanged
- Anthropic / Google / Bedrock / others — unchanged

If you want the impersonation to apply elsewhere, edit the `CODEX_APIS` set in `src/index.ts`.

## Configuration (optional)

All overrides are read once at startup. None are required. These only affect the *content* of the spoofed `User-Agent` / `originator`; which APIs get spoofed is fixed (both Responses variants).

| Env var                              | Default            | Purpose                                                                      |
| ------------------------------------ | ------------------ | ---------------------------------------------------------------------------- |
| `PI_FAKE_CODEX_VERSION`              | `0.145.0`          | Version segment of the User-Agent string.                                    |
| `PI_FAKE_CODEX_OS_TYPE`              | auto-detected      | OS type segment (e.g. `Linux`, `Mac OS`).                                    |
| `PI_FAKE_CODEX_OS_VERSION`           | auto-detected      | OS version segment.                                                          |
| `PI_FAKE_CODEX_ARCH`                 | `process.arch`     | Architecture segment (e.g. `x86_64`).                                        |
| `PI_FAKE_CODEX_TERMINAL`             | `unknown`          | Terminal descriptor segment.                                                 |
| `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` | *(unset)*          | Codex's own override env var; redirects the `originator` header to the given value (same behavior as the real client). |

## Install

```bash
# From npm
pi install npm:@NekoSekaiMoe/pi-fake-codex

# Local development
pi -e ./src/index.ts
```

There are no commands or shortcuts — the extension takes effect on load.

## Caveats

- This only rewrites the two identity headers on requests pi itself makes via the `openai-responses` and `openai-codex-responses` APIs. It does not affect sub-processes, MCP servers, tools that make their own HTTP calls, Chat Completions (`openai-completions`), or any non-Responses API.
- Verified against pi internals (not just type signatures): `before_provider_headers` is emitted in `core/extensions/runner.js` (`emitBeforeProviderHeaders`), which mutates the same `headers` object that pi's `transformHeaders` returns (`core/sdk.js`) and which `model-runtime.prepareRequest` then assigns to `options.headers`. For `openai-codex-responses`, pi-ai's `buildBaseCodexHeaders` applies `additionalHeaders` (our map) after its own defaults, so our `originator`/`User-Agent` override pi's. For `openai-responses`, pi-ai passes our map through `new OpenAI({ defaultHeaders })`, and the OpenAI SDK's `buildHeaders` lists `defaultHeaders` *after* its own `User-Agent: getUserAgent()`, so the later value wins. End-to-end live rewriting against a real provider still requires a real Pi session, but the header-injection path itself is traced.

## License

BSD-2-Clause
