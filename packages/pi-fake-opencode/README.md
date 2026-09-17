# @NekoSekaiMoe/pi-fake-opencode

A compatibility extension for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) that makes requests to [OpenCode Zen](https://opencode.ai/zen) look like traffic from the official OpenCode client, unlocking Zen's free tier from within pi.

```text
Error: OpenAI API error (403):
{"type":"FreeTierError","message":"Error from provider (Console):
 OpenCode's free tier can only be used from within OpenCode"}
```

## Why this exists

Zen's free-tier models only accept requests that look like they originate from the OpenCode app. The gateway fingerprints the client, and pi announces itself with its own identity — so free models fail with `FreeTierError` even though the request is otherwise valid.

We verified the gateway's actual rules empirically (same key, same free model, only headers varied):

| User-Agent | `x-opencode-session` | Result |
| --- | --- | --- |
| `opencode/1.18.31` | `ses_` + 26 chars of `[0-9A-Za-z]` | ✅ completion |
| `opencode/latest/1.18.31/cli` (4-segment form) | well-formed | ✅ completion |
| `pi/…`, `curl/…`, `opencode-foo/1.2`, bare `opencode` | any | ❌ `FreeTierError` |
| `opencode/1.18.31` | missing / short / no `ses_` prefix | ❌ `FreeTierError` |
| `opencode/0.6.9` (stale version) | well-formed | ❌ `UpgradeRequired` |

(`x-opencode-request` and `x-opencode-client` are not currently checked, but the real client sends them, so we send faithful values anyway.)

The values mirror opencode's own source: `packages/opencode/src/session/llm/request.ts` builds these headers for every provider whose id starts with `opencode`, and `packages/schema/src/identifier.ts` defines the `ses_`/`msg_` ID format (12 hex chars of timestamp+counter + 14 random alphanumerics).

## What it does

Listens to pi's `before_provider_headers` hook and overwrites exactly the identity headers:

| Header | Value |
| --- | --- |
| `User-Agent` | `opencode/1.18.31` |
| `x-opencode-session` | `ses_…` — stable per pi session (derived fresh, cached per `ctx.sessionManager.getSessionId()`) |
| `x-opencode-request` | `msg_…` — fresh per request, like a user-message id |
| `x-opencode-client` | `cli` (honors `OPENCODE_CLIENT`) |

Authorization, the endpoint, and every other header stay exactly as pi and the selected provider configured them.

A request is spoofed when **any** of these holds:

- the model's provider is `opencode` or `opencode-go` (pi's built-in Zen providers), or
- the model's base URL contains `opencode.ai` (custom `models.json` providers pointing at `https://opencode.ai/zen/v1`), or
- the provider id is listed in `PI_FAKE_OPENCODE_PROVIDERS` (for proxies that front Zen and forward client headers), or
- `PI_FAKE_OPENCODE_ALL` is set truthy.

All other requests keep pi's own identity, so unrelated providers are never affected.

## Installation

```bash
pi install npm:@NekoSekaiMoe/pi-fake-opencode
```

For local development from this package directory:

```bash
pi -e ./src/index.ts
```

## Using Zen's free tier

OpenCode itself uses the literal API key `public` when no key is configured, which authorizes **free models only** (opencode prunes every paid model from its catalog in that mode). pi's built-in `opencode` provider catalog contains no free models, so add one yourself in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "opencode": {
      "baseUrl": "https://opencode.ai/zen/v1",
      "apiKey": "public",
      "api": "openai-completions",
      "models": [
        {
          "id": "mimo-v2.5-free",
          "name": "MiMo v2.5 (free)",
          "reasoning": false,
          "input": ["text"],
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "contextWindow": 200000,
          "maxTokens": 8192
        }
      ]
    }
  }
}
```

Free model ids (query the live gateway): `curl https://opencode.ai/zen/v1/models` and pick the `*-free` entries. For paid models, authenticate properly instead (`/login opencode` or `OPENCODE_API_KEY` with a real `sk-zen-…` key); paid usage is not subject to the client check.

Verified end-to-end: without the extension the request above fails with the exact `FreeTierError` from the issue; with the extension loaded, the free model answers.

## Configuration

Environment variables are read when requests are built:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_FAKE_OPENCODE_VERSION` | `1.18.31` | Version segment of the `opencode/{version}` User-Agent. Keep it recent — the gateway rejects stale versions with `UpgradeRequired`. |
| `PI_FAKE_OPENCODE_UA` | unset | Full User-Agent override (wins over `PI_FAKE_OPENCODE_VERSION`). |
| `PI_FAKE_OPENCODE_PROVIDERS` | unset | Comma-separated extra provider ids to spoof (proxies in front of Zen). |
| `PI_FAKE_OPENCODE_ALL` | unset | When truthy (`1`/`true`/`yes`/`on`), spoof every request. |
| `OPENCODE_CLIENT` | `cli` | Mirrors opencode's own env var for the `x-opencode-client` value. |

If the gateway tightens its fingerprint, bump `PI_FAKE_OPENCODE_VERSION` to a current OpenCode release or set `PI_FAKE_OPENCODE_UA` to the exact string the official client sends.

## Notes

- Free-tier usage is still subject to Zen's rate limits and terms. This package only fixes client identification, not entitlement.
- `Authorization: Bearer public` + a paid model returns `AuthError` ("Missing API key") — that is Zen rejecting the anonymous key for non-free models, not something this extension can or should bypass.

## License

BSD-2-Clause
