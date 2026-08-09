/**
 * pi-smart-flow — Compact thinking
 *
 * Replaces the wall-of-text thinking stream with a tool-row-style summary:
 *
 * - Pi's native `hideThinkingBlock` setting hides the raw thinking blocks
 *   (extensions cannot toggle the live UI setting themselves, so enabling
 *   compact thinking also flips the persisted setting — and restores it on
 *   disable if we were the ones who set it).
 * - Thinking duration is measured from the `thinking_start`/`thinking_end`
 *   stream events on `message_update`.
 * - On `message_end`, the assistant message's thinking blocks are condensed:
 *   ≤3 non-empty lines are shown verbatim; longer traces are summarized by a
 *   nested `completeSimple` call against the current model, then appended as
 *   a TUI-only transcript entry (never sent to the LLM, so signatures and
 *   provider-side thinking integrity are untouched). The entry renders like
 *   a pi-ui tool row — `• Thought 12s` with the body in the thinking color.
 *
 * Summaries only appear while thinking blocks are hidden — otherwise the raw
 * thinking is already visible and a summary would be noise.
 *
 * Toggle: /compact-thinking [on|off]   (persisted in <agentDir>/pi-smart-flow.json)
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";

const ENTRY_TYPE = "pi-smart-flow:thinking-summary";
const MAX_SUMMARY_LINES = 3;
/** Keep summarization input bounded; conclusions live near the end, so keep the tail. */
const MAX_INPUT_CHARS = 12_000;
const HEAD_CHARS = 2_000;

const SUMMARY_PROMPT = `You condense an AI assistant's reasoning trace. Summarize the reasoning below in AT MOST ${MAX_SUMMARY_LINES} short plain-text lines, in the same language as the input. Capture only the key reasoning steps, decisions, and conclusions. Output the summary only — no preamble, no bullets markers beyond simple lines, no quotes.`;

interface CompactThinkingConfig {
  compactThinking?: boolean;
  /** We only restore hideThinkingBlock on disable if WE flipped it. */
  hideThinkingSetByUs?: boolean;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function configPath(): string {
  return join(agentDir(), "pi-smart-flow.json");
}

function loadConfig(): CompactThinkingConfig {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as CompactThinkingConfig;
  } catch {
    // Missing or corrupt config — defaults apply.
  }
  return {};
}

async function saveConfig(config: CompactThinkingConfig): Promise<void> {
  try {
    await mkdir(agentDir(), { recursive: true });
    await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch {
    // Config persistence is best-effort; the session toggle still works.
  }
}

/** Live thinking blocks hidden (persisted Pi setting)? Summaries only make sense then. */
function thinkingHidden(ctx: ExtensionContext): boolean {
  try {
    return SettingsManager.create(ctx.cwd).getHideThinkingBlock();
  } catch {
    return false;
  }
}

function collectThinking(message: { role: string; content?: unknown }): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  const parts: string[] = [];
  for (const block of message.content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "thinking") {
      const text = (block as { thinking?: unknown }).thinking;
      if (typeof text === "string" && text.trim()) parts.push(text.trim());
    }
  }
  return parts.join("\n\n");
}

function visibleLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

/** "12s" / "1m 5s" — same shape as pi-ui's working-line elapsed text. */
function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function boundInput(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text;
  return `${text.slice(0, HEAD_CHARS)}\n[...]\n${text.slice(-(MAX_INPUT_CHARS - HEAD_CHARS))}`;
}

export function registerCompactThinking(pi: ExtensionAPI): void {
  const config = loadConfig();
  let enabled = config.compactThinking === true;
  // Serialize summaries so transcript entries stay in message order.
  let queue: Promise<void> = Promise.resolve();

  // Thinking-duration tracking, driven by the token stream. Assistant
  // messages stream one at a time, so module-level span state is sufficient;
  // interleaved thinking/text blocks accumulate.
  let thinkingStartedAt: number | undefined;
  let thinkingMs = 0;

  const appendSummary = (text: string, summarized: boolean, durationMs: number) => {
    pi.appendEntry(ENTRY_TYPE, { text, summarized, durationMs });
  };

  const summarize = async (thinking: string, durationMs: number, ctx: ExtensionContext): Promise<void> => {
    if (visibleLines(thinking).length <= MAX_SUMMARY_LINES) {
      appendSummary(thinking, false, durationMs);
      return;
    }
    const fallback = () =>
      appendSummary(`${visibleLines(thinking).slice(0, MAX_SUMMARY_LINES).join("\n")} …`, false, durationMs);
    const model = ctx.model;
    if (!model) {
      fallback();
      return;
    }
    try {
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(model.provider);
      const response = await completeSimple(
        model,
        {
          systemPrompt: SUMMARY_PROMPT,
          messages: [{ role: "user", content: boundInput(thinking), timestamp: Date.now() }],
        },
        { apiKey, signal: ctx.signal, maxTokens: 512 },
      );
      if (ctx.signal?.aborted) return;
      const text = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (response.stopReason === "error" || response.stopReason === "aborted" || !text) {
        fallback();
        return;
      }
      appendSummary(text, true, durationMs);
    } catch {
      if (!ctx.signal?.aborted) fallback();
    }
  };

  pi.registerEntryRenderer(ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { text?: unknown; summarized?: unknown; durationMs?: unknown } | undefined;
    const text = typeof data?.text === "string" ? data.text : "";
    if (!text) return undefined;
    // Match pi-ui's flat tool rows: dot + bold toolTitle verb + dim meta,
    // body lines indented underneath in the thinking color.
    const dot = theme.fg("success", "•");
    const verb = theme.bold(theme.fg("toolTitle", "Thought"));
    const duration = typeof data?.durationMs === "number" && data.durationMs > 0 ? formatDuration(data.durationMs) : "";
    const marker = data?.summarized === true ? "summary" : "";
    const metaParts = [duration, marker].filter(Boolean);
    const meta = metaParts.length > 0 ? theme.fg("dim", ` ${metaParts.join(" · ")}`) : "";
    const body = text
      .split("\n")
      .map((line) => `  ${theme.fg("thinkingText", line)}`)
      .join("\n");
    return new Text(`${dot} ${verb}${meta}\n${body}`, 0, 0);
  });

  pi.on("agent_start", () => {
    thinkingStartedAt = undefined;
    thinkingMs = 0;
  });

  pi.on("message_start", (event) => {
    if ((event.message as { role?: string }).role !== "assistant") return;
    thinkingStartedAt = undefined;
    thinkingMs = 0;
  });

  pi.on("message_update", (event) => {
    const streamEvent = (event as { assistantMessageEvent?: { type?: string } }).assistantMessageEvent;
    if (streamEvent?.type === "thinking_start") {
      thinkingStartedAt = Date.now();
    } else if (streamEvent?.type === "thinking_end" && thinkingStartedAt !== undefined) {
      thinkingMs += Date.now() - thinkingStartedAt;
      thinkingStartedAt = undefined;
    }
  });

  pi.on("message_end", (event, ctx) => {
    if (!enabled) return;
    const thinking = collectThinking(event.message as { role: string; content?: unknown });
    if (!thinking) return;
    // Raw thinking still visible → a summary would duplicate it.
    if (!thinkingHidden(ctx)) return;
    const durationMs = thinkingMs;
    queue = queue.then(() => summarize(thinking, durationMs, ctx)).catch(() => {});
  });

  pi.registerCommand("compact-thinking", {
    description: "Toggle compact thinking: hide raw thinking blocks and show a ≤3-line summary instead",
    getArgumentCompletions: (prefix) =>
      ["on", "off"].filter((arg) => arg.startsWith(prefix)).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg !== "" && arg !== "on" && arg !== "off") {
        ctx.ui.notify("Usage: /compact-thinking [on|off]", "warning");
        return;
      }
      const next = arg === "" ? !enabled : arg === "on";
      if (next === enabled) {
        ctx.ui.notify(`Compact thinking already ${enabled ? "on" : "off"}.`, "info");
        return;
      }
      enabled = next;
      config.compactThinking = enabled;

      let note = "";
      try {
        const settings = SettingsManager.create(ctx.cwd);
        if (enabled && !settings.getHideThinkingBlock()) {
          settings.setHideThinkingBlock(true);
          config.hideThinkingSetByUs = true;
          note = " Enabled Pi's hideThinkingBlock setting (applies to new sessions; this session may still stream raw thinking).";
        } else if (!enabled && config.hideThinkingSetByUs) {
          settings.setHideThinkingBlock(false);
          config.hideThinkingSetByUs = false;
          note = " Restored Pi's hideThinkingBlock setting.";
        }
      } catch {
        note = " Could not update Pi's hideThinkingBlock setting; toggle it in /settings.";
      }
      await saveConfig(config);
      ctx.ui.notify(`Compact thinking ${enabled ? "on" : "off"}.${note}`, "info");
    },
  });
}
