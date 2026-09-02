# pi-web-lite

Minimal web-access tools for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent): two tools, no slash commands, everything activates on load.

- **`webfetch`** — fetch an http(s) URL and return its main content as clean markdown.
- **`websearch`** — search the web via Exa and return an answer plus source links.

## `webfetch`: URL → markdown

Retries through a fallback chain until one step succeeds:

```
direct HTTP (readability + turndown)
  → Gemini Web    (browser cookies)
  → Gemini API    (url_context)
  → Tavily extract
```

- **direct**: plain `fetch` with browser-like headers; HTML pages go through Readability and are converted to markdown with Turndown. Non-HTML text (JSON, plain text, source files) is returned verbatim.
- PDFs are rejected with a hint to download via `bash`; images/audio/video/octet-stream are rejected as binary content.
- If every step fails, the tool returns an `isError` result listing what each attempt failed with.

Parameters: `url` (required), `maxLength` (optional, default `50000` characters; output is truncated with a marker).

## `websearch`: query → answer + sources

Searches via [Exa](https://exa.ai) through helpers borrowed from the `pi-web-access` package:

- **Keyless by default** — routes through `mcp.exa.ai`, no API key needed.
- Setting `EXA_API_KEY` switches to the official Exa API directly.

Parameters: `query` (required), `numResults` (optional), `recency` (`day | week | month | year`, optional). Output is truncated at 50,000 characters.

## Configuration

| Source | Keys | Used by |
| --- | --- | --- |
| Environment | `EXA_API_KEY` | websearch (official API path) |
| Environment | `TAVILY_API_KEY` | webfetch (Tavily fallback) |
| `~/.pi/web-search.json` | `tavilyApiKey`, `exaApiKey` | same as above |

## Requirements and caveats

- Runtime dependencies: `@mozilla/readability`, `linkedom`, `turndown`.
- The Gemini fallbacks and the Exa client are **dynamically imported from an installed `pi-web-access` package** (the `pi-web-access` npm package living under `~/.pi/agent/npm/`). The probe path is resolved from the machine's Pi agent directory; if that package is absent, the affected fallbacks are skipped silently and the remaining chain still works.
- Timeouts are 30 seconds per step; the tool respects Pi's abort signal.
- Intended as a lean alternative to full `pi-web-access` — no caching, no screenshots, no browser automation beyond the Gemini fallbacks.

## Usage

From this repository:

```bash
pi -e ./packages/pi-web-lite/src/index.ts
```
