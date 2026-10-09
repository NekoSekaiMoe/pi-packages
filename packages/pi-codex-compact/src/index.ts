/**
 * pi-codex-compact — Extension entry point
 *
 * Ports the compaction behavior of the official OpenAI Codex CLI
 * (`codex-rs/core/src/compact.rs`) to pi:
 *
 * 1. `session_before_compact` — take over every compaction (manual `/compact`,
 *    threshold, overflow) and produce a Codex-style result: a handoff-framed
 *    summary plus verbatim retention of recent user messages across the cut
 *    point. See `compact.ts` for the mechanics and failure policy.
 *
 * 2. `session_compact` — append Codex's post-compaction warning as a TUI-only
 *    transcript row (never sent to the LLM). Codex emits the same warning after
 *    every compaction: long threads with multiple compactions degrade accuracy,
 *    so starting a new thread is the better fix when possible.
 *
 * No commands, no tools; the extension takes effect on load and applies to any
 * provider (the compaction loop in Codex is provider-agnostic, and so is this).
 *
 * Usage
 * -----
 *   pi -e ./src/index.ts
 *   pi install npm:@NekoSekaiMoe/pi-codex-compact
 *
 * Configuration (environment):
 *
 *   PI_CODEX_COMPACT=0             disable entirely (pi's default compaction)
 *   PI_CODEX_COMPACT_USER_TOKENS   verbatim user-message budget (default 20000)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { configFromEnv, runCodexCompaction } from "./compact.ts";

/** TUI-only entry type for the post-compaction warning. */
const WARNING_ENTRY = "pi-codex-compact:warning";

/** Drop null-valued provider headers; the summarization call wants plain strings. */
function normalizeHeaders(headers: Record<string, string | null> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Codex's post-compaction warning (`codex-rs/core/src/compact.rs`). */
const COMPACTION_WARNING =
  "Heads up: long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted.";

export default function (pi: ExtensionAPI): void {
  if (process.env.PI_CODEX_COMPACT === "0") return;

  const config = configFromEnv();

  pi.on("session_before_compact", async (event, ctx) => {
    const model = ctx.model;
    if (!model) return undefined;
    try {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) return undefined;
      const compaction = await runCodexCompaction(
        event,
        model,
        { apiKey: auth.apiKey, headers: normalizeHeaders(auth.headers), env: auth.env },
        config,
        ctx.thinkingLevel,
      );
      if (compaction) return { compaction };
    } catch {
      // Fall through: pi's default compaction is the safety net.
    }
    return undefined;
  });

  pi.on("session_compact", () => {
    pi.appendEntry(WARNING_ENTRY);
  });

  pi.registerEntryRenderer(WARNING_ENTRY, (_entry, _options, theme) => {
    const icon = theme.fg("warning", "⚠");
    return new Text(`${icon} ${theme.fg("dim", COMPACTION_WARNING)}`, 0, 0);
  });
}
