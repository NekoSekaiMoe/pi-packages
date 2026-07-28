/**
 * pi-fake-codex — Extension entry point
 *
 * Makes pi's OpenAI Responses-style requests impersonate the official OpenAI
 * Codex CLI (`codex_cli_rs`). Two layers of spoofing:
 *
 * 1. Identity headers (both Responses API variants):
 *
 *      originator:  "codex_cli_rs"
 *      User-Agent:  "codex_cli_rs/{version} ({os} {ver}; {arch}) {terminal}"
 *
 *    Scope: `model.api` ∈ {`openai-responses`, `openai-codex-responses`}.
 *
 * 2. Request body (only the plain `openai-responses` path):
 *
 *    pi-ai's `openai-responses` stream emits a pi-shaped body — system prompt
 *    inlined as a `developer` role message inside `input`, plus OpenAI-only
 *    fields like `prompt_cache_retention`. Many third-party / 国产 Responses
 *    providers only tolerate the body shape the real Codex CLI sends, and fail
 *    in subtle ways on pi's layout:
 *
 *      - subagent tool calls rejected with "Invalid subagent arguments"
 *        (non-GPT models misread pi's tool schema / body layout)
 *      - `read` resolving to hallucinated absolute paths (ENOENT to paths that
 *        don't exist on the host — a symptom of the model mis-parsing context)
 *      - occasional `Error: terminated` (upstream closes the stream early when
 *        it rejects a request field)
 *
 *    So we rewrite the body to Codex's layout: lift the system prompt into a
 *    top-level `instructions`, add `text.verbosity` / `parallel_tool_calls` /
 *    `tool_choice`, force `include: ["reasoning.encrypted_content"]`, and drop
 *    OpenAI-only fields. See `payload.ts` for the field-by-field rationale and
 *    the Codex source references.
 *
 *    `openai-codex-responses` is *not* body-rewritten: pi-ai already builds a
 *    Codex-shaped body for that path (`buildRequestBody` uses
 *    `includeSystemPrompt: false`, `text`, `parallel_tool_calls`, …).
 *
 * Everything else (endpoint, Authorization, OpenAI-Beta, session-id, …) is
 * left exactly as pi / pi-ai configured it. The goal is to make requests to
 * third-party OpenAI-compatible providers look indistinguishable from real
 * Codex CLI traffic — in both headers and body.
 *
 * Usage
 * -----
 *   pi -e ./src/index.ts
 *   pi install npm:@NekoSekaiMoe/pi-fake-codex
 *
 * There are no commands; the extension takes effect on load.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerApplyPatchTool } from "./apply-patch.ts";
import { buildOriginator, buildUserAgent } from "./headers.ts";
import { codexifyResponsesPayload } from "./payload.ts";

/** The two OpenAI Responses-style APIs whose *headers* we spoof as Codex CLI. */
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

  // `before_provider_request` fires after the request body is assembled and
  // lets a handler replace it by returning a new value. We rewrite the plain
  // `openai-responses` body to Codex's layout so third-party Responses
  // providers that only tolerate real Codex traffic accept it. The
  // `openai-codex-responses` path is already Codex-shaped, so we leave it alone.
  pi.on("before_provider_request", (event, ctx) => {
    if (ctx.model?.api !== "openai-responses") {
      return;
    }
    return codexifyResponsesPayload(event.payload);
  });

  // Register an `apply_patch` editing tool alias (same behavior as Pi's
  // built-in `edit`, just named `apply_patch`). Unrelated to the impersonation
  // above; lives here as a packaging decision. See `apply-patch.ts`.
  registerApplyPatchTool(pi);
}
