/**
 * pi-fake-opencode — Extension entry point
 *
 * Makes pi's requests to OpenCode Zen look like they come from the official
 * OpenCode client, which is required to use Zen's free tier from outside the
 * OpenCode app:
 *
 *   Error: OpenAI API error (403):
 *   {"type":"FreeTierError","message":"Error from provider (Console):
 *    OpenCode's free tier can only be used from within OpenCode"}
 *
 * The gateway fingerprints two signals (verified against the live endpoint,
 * see README): the User-Agent must be `opencode/{recent version}` and
 * `x-opencode-session` must be a well-formed opencode session id
 * (`ses_` + 26 chars). This extension listens to `before_provider_headers`
 * and overwrites exactly the headers the real client sends:
 *
 *   User-Agent:           opencode/{version}
 *   x-opencode-session:   ses_…  (stable per pi session)
 *   x-opencode-request:   msg_…  (fresh per request)
 *   x-opencode-client:    cli
 *
 * Authorization, the endpoint, and every other header stay exactly as
 * pi / pi-ai configured them — including pi's own auth, so `/login opencode`
 * or `OPENCODE_API_KEY` (Zen's anonymous key is literally `public`) work as
 * usual.
 *
 * Scope: requests whose provider is `opencode` / `opencode-go`, whose base
 * URL contains `opencode.ai`, whose provider id is listed in
 * `PI_FAKE_OPENCODE_PROVIDERS`, or any request when `PI_FAKE_OPENCODE_ALL`
 * is set. Works for every streaming API (openai-completions,
 * openai-responses, anthropic-messages, google-generative-ai, …) because the
 * hook runs after the outgoing headers are assembled. See `headers.ts`.
 *
 * Usage
 * -----
 *   pi -e ./src/index.ts
 *   pi install npm:@NekoSekaiMoe/pi-fake-opencode
 *
 * There are no commands; the extension takes effect on load.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildClient,
  buildRequestId,
  buildSessionId,
  buildUserAgent,
  shouldSpoof,
} from "./headers.ts";

export default function (pi: ExtensionAPI): void {
  // `before_provider_headers` fires after request headers are assembled and
  // before the HTTP call. Handlers mutate `headers` in place; a `null` value
  // deletes that header. Return value is ignored.
  pi.on("before_provider_headers", (event, ctx) => {
    if (!shouldSpoof(ctx.model?.provider, ctx.model?.baseUrl)) {
      return;
    }

    // Overwrite pi's identity with the official OpenCode client's. Leave all
    // other headers (Authorization, content-type, …) alone.
    event.headers["User-Agent"] = buildUserAgent();
    event.headers["x-opencode-session"] = buildSessionId(
      ctx.sessionManager.getSessionId(),
    );
    event.headers["x-opencode-request"] = buildRequestId();
    event.headers["x-opencode-client"] = buildClient();
  });
}
