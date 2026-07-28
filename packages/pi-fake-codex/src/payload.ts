/**
 * pi-fake-codex — Payload normalization
 *
 * Rewrites pi's `openai-responses` request body so it matches the shape the
 * official Codex CLI (`codex_cli_rs`) sends to its Responses endpoint. Header
 * spoofing alone (see `index.ts` / `headers.ts`) is not enough for third-party
 * Responses providers: many国产 / non-GPT Responses implementations only
 * tolerate the field set and layout that real Codex traffic uses, and choke on
 * pi-specific extras.
 *
 * What we change (openai-responses only; openai-codex-responses is already
 * codex-shaped by pi-ai and left untouched):
 *
 *   1. `instructions` — Codex carries the base system prompt in a top-level
 *      `instructions` string, *not* as a `developer`/`system` role message in
 *      `input`. We lift the leading system/developer message out of `input`
 *      into `instructions`, matching `codex-rs/core/src/client.rs`
 *      (`includeSystemPrompt: false` + `prompt.base_instructions.text`).
 *
 *   2. `text: { verbosity }` — Codex always emits a `text` control object.
 *      Verbosity is model-dependent in the real client; we default to `"low"`
 *      (Codex's own default for the chat backend) and let `PI_FAKE_CODEX_VERBOSITY`
 *      override it. Some non-GPT Responses backends reject requests that omit
 *      `text` when reasoning/format controls are absent.
 *
 *   3. `parallel_tool_calls: true` — Codex sets this whenever tools exist.
 *
 *   4. `tool_choice: "auto"` — Codex's default when the caller doesn't pin one.
 *
 *   5. `include: ["reasoning.encrypted_content"]` — Codex always sets this so
 *      reasoning items round-trip. Harmless on non-reasoning models and required
 *      by several Responses proxies for `response.completed` to be emitted.
 *
 *   6. `prompt_cache_retention` — stripped. It is OpenAI-specific and rejected
 *      by some third-party Responses endpoints; Codex itself never sends it.
 *      `prompt_cache_key` is kept because Codex does send it.
 *
 * The transformation is defensive: every step is guarded, the payload shape is
 * validated before mutation, and any unexpected structure short-circuits to the
 * original payload (we never want to *break* a working request).
 *
 * References (Codex source, this repo's vendored `codex/` tree):
 *   - `codex-rs/codex-api/src/common.rs` — `ResponsesApiRequest`,
 *     `TextControls`, `create_text_param_for_request`.
 *   - `codex-rs/core/src/client.rs` — `build_request()` body assembly;
 *     `include = vec!["reasoning.encrypted_content"]`; `tool_choice: "auto"`;
 *     `parallel_tool_calls && !use_responses_lite`.
 *   - `codex-rs/tools/src/tool_spec.rs` — tools serialized as a JSON array of
 *     `{type:"function", name, description, strict, parameters, ...}`.
 */

/** Verbosity sent in the `text` control object. Override via env if needed. */
const DEFAULT_VERBOSITY = "low";

/**
 * Normalize a pi `openai-responses` request body to look like Codex's.
 *
 * Returns the (mutated) payload. Defensive: on any structural surprise it
 * returns the original payload unchanged.
 */
export function codexifyResponsesPayload(payload: unknown): unknown {
  if (!isObject(payload)) return payload;
  // Clone so we never mutate the caller's object (handlers may share it).
  const body: Record<string, unknown> = { ...payload };
  const input = body.input;

  // ---- 1. Lift the system / developer prompt into `instructions` ----------
  // pi's convertResponsesMessages() prepends a single {role:"developer"|"system",
  // content:"<system prompt>"} item when includeSystemPrompt is true (the default
  // for openai-responses). Codex instead puts that text in the top-level
  // `instructions` field and keeps `input` free of it.
  if (Array.isArray(input)) {
    const extracted = extractSystemInstructions(input);
    if (extracted) {
      body.input = extracted.input;
      // Preserve any caller-provided `instructions` by appending ours; pi itself
      // does not set `instructions` on the openai-responses path.
      const existing = typeof body.instructions === "string" ? body.instructions.trim() : "";
      const merged = joinNonEmpty([existing, extracted.instructions]);
      if (merged.length > 0) {
        body.instructions = merged;
      }
    }
  }

  // ---- 2. `text: { verbosity }` --------------------------------------------
  // Only add if not already present (openai-responses never sets it, but be safe).
  if (body.text === undefined) {
    body.text = { verbosity: resolveVerbosity() };
  }

  // ---- 3. parallel_tool_calls ----------------------------------------------
  if (body.parallel_tool_calls === undefined && Array.isArray(body.tools) && body.tools.length > 0) {
    body.parallel_tool_calls = true;
  }

  // ---- 4. tool_choice default ----------------------------------------------
  if (body.tool_choice === undefined && Array.isArray(body.tools) && body.tools.length > 0) {
    body.tool_choice = "auto";
  }

  // ---- 5. include reasoning.encrypted_content ------------------------------
  // Codex always sets this. Merge (dedup, case-sensitive) so we don't clobber a
  // reasoning model's existing include list.
  const include = normalizeInclude(body.include);
  if (include) {
    body.include = include;
  }

  // ---- 6. drop OpenAI-only prompt_cache_retention --------------------------
  // `prompt_cache_key` is kept (Codex sends it). Retention is OpenAI-specific.
  if ("prompt_cache_retention" in body) {
    delete body.prompt_cache_retention;
  }

  return body;
}

/**
 * Extract a leading system/developer role message from `input` and return the
 * remaining items plus the prompt text. Returns undefined if there is nothing
 * that looks like the system prompt prefix.
 *
 * pi always prepends exactly one such item; we only lift the *first* item and
 * only when it is a role message (`{role, content}`) with role `system` or
 * `developer`. Content can be a string or an array of `{type:"input_text",
 * text}` parts (the latter is what convertResponsesMessages emits).
 */
function extractSystemInstructions(input: unknown[]): { input: unknown[]; instructions: string } | undefined {
  if (input.length === 0) return undefined;
  const first = input[0];
  if (!isObject(first)) return undefined;
  const role = typeof first.role === "string" ? first.role : undefined;
  if (role !== "system" && role !== "developer") return undefined;

  const text = extractMessageText(first.content);
  if (text === undefined) return undefined;

  return {
    input: input.slice(1),
    instructions: text,
  };
}

/** Read plain text out of a pi/Responses message `content` value. */
function extractMessageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const part of content) {
    if (!isObject(part)) continue;
    // pi openai-responses developer message content items are {type:"input_text", text}.
    // Guard loosely so an unexpected shape doesn't corrupt the prompt.
    const t = typeof part.type === "string" ? part.type : undefined;
    const text = typeof part.text === "string" ? part.text : undefined;
    if (text && (t === "input_text" || t === "text" || t === undefined)) {
      parts.push(text);
    }
  }
  if (parts.length === 0) {
    // Could not make sense of the content; leave input untouched.
    return undefined;
  }
  return parts.join("\n");
}

/** Ensure `include` is an array containing `reasoning.encrypted_content`. */
function normalizeInclude(include: unknown): string[] | undefined {
  const wanted = "reasoning.encrypted_content";
  if (Array.isArray(include) && include.every((x) => typeof x === "string")) {
    return include.includes(wanted) ? include : [...include, wanted];
  }
  if (include === undefined) {
    return [wanted];
  }
  // Unexpected shape: leave as-is rather than risk mangling.
  return undefined;
}

/** Resolve the `text.verbosity` value, honoring the env override. */
function resolveVerbosity(): string {
  const override = process.env.PI_FAKE_CODEX_VERBOSITY?.trim();
  if (override && override.length > 0) return override;
  return DEFAULT_VERBOSITY;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinNonEmpty(parts: string[]): string {
  return parts.map((p) => p.trim()).filter((p) => p.length > 0).join("\n\n");
}
