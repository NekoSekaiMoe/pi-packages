/**
 * pi-fake-codex — Extension entry point
 *
 * Rewrites the identity headers of pi's OpenAI Responses-style requests so
 * they impersonate the official OpenAI Codex CLI (`codex_cli_rs`).
 *
 * Scope: both Responses API variants — requests whose `model.api` is
 *
 *   - `"openai-codex-responses"` (the `openai-codex` provider, which talks to
 *     `https://chatgpt.com/backend-api/codex/responses`), and
 *   - `"openai-responses"` (the plain OpenAI Responses API, used by many
 *     third-party providers).
 *
 * On both APIs this extension overwrites the identity headers that
 * fingerprint the client — and *only* those — with the values the official
 * Codex CLI sends:
 *
 *     originator:  "codex_cli_rs"
 *     User-Agent:  "codex_cli_rs/{version} ({os} {ver}; {arch}) {terminal}"
 *
 * Everything else (endpoint, Authorization, the JSON body, OpenAI-Beta,
 * session-id, …) is left exactly as pi / pi-ai configured it. The goal is to
 * make requests to third-party OpenAI-compatible providers look
 * indistinguishable from real Codex CLI traffic.
 *
 * Usage
 * -----
 *   pi -e ./src/index.ts
 *   pi install npm:@NekoSekaiMoe/pi-fake-codex
 *
 * There are no commands; the extension takes effect on load.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildOriginator, buildUserAgent } from "./headers.ts";

/** The two OpenAI Responses-style APIs whose requests we spoof as Codex CLI. */
const CODEX_APIS = new Set(["openai-responses", "openai-codex-responses"]);

export default function (pi: ExtensionAPI): void {
  // `before_provider_headers` fires after request headers are assembled and
  // before the HTTP call. Handlers mutate `headers` in place; a `null` value
  // deletes that header. Return value is ignored.
  pi.on("before_provider_headers", (event, ctx) => {
    if (!ctx.model?.api || !CODEX_APIS.has(ctx.model.api)) {
      return;
    }

    // Overwrite pi's identity headers with the official Codex values. Leave all
    // other headers (auth, OpenAI-Beta, session-id, …) alone.
    event.headers["originator"] = buildOriginator();
    event.headers["User-Agent"] = buildUserAgent();
  });
}
