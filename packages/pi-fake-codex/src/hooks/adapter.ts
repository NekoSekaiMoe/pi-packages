// Ported from pi-maestro-flow (MIT, Copyright (c) 2026 catlog22)
// Source: packages/pi-maestro-flow/src/hooks/pi-adapter.ts
//
// Simplified for pi-fake-codex. Dropped from the original:
// - trust store + review TUI + /hooks command + preset installer
// - permission controller integration (PermissionRequest is not mapped)
// - teammate relay (isTeammateChild) and the hook-context custom renderer
//
// SECURITY: unlike the original, there is NO trust/review step — a non-empty
// .pi/hooks.json in the project is executed as-is. To keep the user informed,
// a notification listing the number of executable command hooks is shown once
// per session when a config activates.

import { randomUUID } from "node:crypto";
import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type CodexHookEvent,
  type LoadedCodexHooks,
  isRecord,
  loadCodexHooks,
} from "./schema.ts";
import {
  countSkippedHandlers,
  getMatchingCommandHooks,
  runMatchingCommandHooks,
  type ParsedHookOutput,
} from "./runner.ts";

const STATUS_KEY = "codex-hooks";
const MAX_HOOK_COMMAND_LENGTH = 240;
const MAX_HOOK_OUTPUT_LENGTH = 1200;
const MAX_HOOK_NOTICE_LENGTH = 500;
const MAX_FAILURE_SUMMARIES = 3;
const UNSUPPORTED_PI_EVENTS: CodexHookEvent[] = [
  "SubagentStart",
  "SubagentStop",
  "PermissionRequest",
];

interface HookState {
  loaded?: LoadedCodexHooks;
  active: boolean;
  lifecycle: AbortController;
  turnId?: string;
  pendingContext: string[];
  toolContext: Map<string, string[]>;
  stopHookActive: boolean;
}

export function registerCodexHookAdapter(pi: ExtensionAPI): void {
  const state: HookState = {
    active: false,
    lifecycle: new AbortController(),
    pendingContext: [],
    toolContext: new Map(),
    stopHookActive: false,
  };
  const resetLifecycle = (): void => {
    state.lifecycle.abort();
    state.lifecycle = new AbortController();
  };

  const reload = async (ctx: ExtensionContext, announce: boolean): Promise<void> => {
    resetLifecycle();
    try {
      state.loaded = await loadCodexHooks(ctx.cwd);
      // No trust store: an existing non-empty config is always active.
      state.active = state.loaded.exists && hasAnyHooks(state.loaded);
      if (state.active && announce) {
        const executable = countExecutableHooks(state.loaded!);
        ctx.ui.notify(
          `codex-hooks: executing ${executable} command hook${executable === 1 ? "" : "s"} from ${state.loaded!.filePath} (no trust review — audit this file yourself)`,
          "warning",
        );
        reportCompatibilityWarnings(ctx, state.loaded!);
      }
    } catch (error) {
      state.loaded = undefined;
      state.active = false;
      ctx.ui.notify(errorMessage(error), "error");
      console.error(`[codex-hooks] ${errorMessage(error)}`);
    }
  };

  const execute = async (
    eventName: CodexHookEvent,
    matchValues: string[],
    input: Record<string, unknown>,
    ctx: ExtensionContext,
  ): Promise<ParsedHookOutput[]> => {
    if (!state.active || !state.loaded) return [];
    const lifecycle = state.lifecycle;
    const config = state.loaded.config;
    const handlers = getMatchingCommandHooks(config, eventName, matchValues);
    const status = handlers.find((handler) => handler.statusMessage)?.statusMessage;
    if (status) ctx.ui.setStatus(STATUS_KEY, status);
    try {
      const outputs = await runMatchingCommandHooks(
        config,
        eventName,
        matchValues,
        input,
        ctx.cwd,
        lifecycle.signal,
      );
      if (lifecycle.signal.aborted || lifecycle !== state.lifecycle) return [];
      const failures = outputs.filter((output) =>
        output.error || output.timedOut || (output.exitCode !== 0 && output.exitCode !== 2),
      );
      if (failures.length > 0) sendHookFailureMessage(pi, eventName, failures);
      const protocolErrors = outputs
        .map((output) => outputCompatibilityError(eventName, output))
        .filter((message): message is string => Boolean(message));
      if (protocolErrors.length > 0) {
        ctx.ui.notify(`${eventName} hook output incompatible: ${protocolErrors[0]}`, "warning");
      }
      for (const output of outputs) notifySystemMessage(output, ctx);
      return outputs;
    } finally {
      if (status && !lifecycle.signal.aborted && lifecycle === state.lifecycle) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    }
  };

  pi.on("session_start", async (event, ctx) => {
    state.turnId = undefined;
    state.pendingContext = [];
    state.toolContext.clear();
    state.stopHookActive = false;
    await reload(ctx, true);
    if (!state.active) return;
    const source = sessionStartSource(event.reason);
    const outputs = await execute("SessionStart", [source], {
      ...commonInput("SessionStart", ctx),
      source,
    }, ctx);
    state.pendingContext.push(...collectAdditionalContext(outputs, true));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    state.lifecycle.abort();
    state.active = false;
    state.loaded = undefined;
    state.pendingContext = [];
    state.toolContext.clear();
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !state.active) return;
    state.turnId = randomUUID();
    state.stopHookActive = false;
    ctx.ui.setStatus(STATUS_KEY, "⬡ Hook…");
    try {
      const outputs = await execute("UserPromptSubmit", [], {
        ...turnInput("UserPromptSubmit", ctx, state),
        prompt: event.text,
      }, ctx);
      const blocked = blockingReason(outputs) ?? continueFalseReason(outputs);
      if (blocked) {
        ctx.ui.notify(blocked, "warning");
        return { action: "handled" as const };
      }
      state.pendingContext.push(...collectAdditionalContext(outputs, true));
    } finally {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  pi.on("before_agent_start", (_event) => {
    state.turnId ??= randomUUID();
    if (state.pendingContext.length === 0) return;
    const context = state.pendingContext.splice(0).join("\n\n");
    return {
      message: {
        customType: "codex-hook-context",
        content: context,
        display: true,
        details: { source: "codex-hooks" },
      },
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!state.active) return;
    const names = toolMatchValues(event.toolName);
    const input = event.input as Record<string, unknown>;
    const outputs = await execute("PreToolUse", names, {
      ...turnInput("PreToolUse", ctx, state),
      tool_name: names[0],
      pi_tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      tool_input: input,
    }, ctx);
    const blocked = blockingReason(outputs);
    if (blocked) return { block: true, reason: blocked };
    const updatedInput = lastUpdatedInput(outputs);
    if (updatedInput) replaceRecord(input, updatedInput);
    const context = collectAdditionalContext(outputs, false);
    if (context.length > 0 && event.toolCallId) state.toolContext.set(event.toolCallId, context);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!state.active) return;
    const names = toolMatchValues(event.toolName);
    const outputs = await execute("PostToolUse", names, {
      ...turnInput("PostToolUse", ctx, state),
      tool_name: names[0],
      pi_tool_name: event.toolName,
      tool_use_id: event.toolCallId,
      tool_input: event.input,
      tool_response: {
        content: event.content,
        details: event.details,
        isError: event.isError,
      },
    }, ctx);
    const pending = state.toolContext.get(event.toolCallId) ?? [];
    state.toolContext.delete(event.toolCallId);
    const reason = blockingReason(outputs) ?? continueFalseReason(outputs);
    const context = [...pending, ...collectAdditionalContext(outputs, false)];
    if (reason) return { content: [{ type: "text" as const, text: reason }] };
    if (context.length > 0) {
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: `Hook context:\n${context.join("\n\n")}` },
        ],
      };
    }
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    const outputs = await execute("PreCompact", ["auto"], {
      ...turnInput("PreCompact", ctx, state),
      trigger: "auto",
    }, ctx);
    if (outputs.some(hasContinueFalse)) return { cancel: true };
  });

  pi.on("session_compact", async (_event, ctx) => {
    const outputs = await execute("PostCompact", ["auto"], {
      ...turnInput("PostCompact", ctx, state),
      trigger: "auto",
    }, ctx);
    state.pendingContext.push(...collectAdditionalContext(outputs, false));
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!state.active) return;
    const outputs = await execute("Stop", [], {
      ...turnInput("Stop", ctx, state),
      stop_hook_active: state.stopHookActive,
      last_assistant_message: findLastAssistantText(event.messages),
    }, ctx);
    if (outputs.some(hasContinueFalse)) return;
    const reason = blockingReason(outputs);
    if (!reason) return;
    // A goal or compaction resume may already own the next turn; the Stop hook
    // must not queue a second continuation behind it.
    if (ctx.hasPendingMessages?.()) return;
    state.stopHookActive = true;
    pi.sendUserMessage(reason, { deliverAs: "followUp" });
  });
}

function hasAnyHooks(loaded: LoadedCodexHooks): boolean {
  return Object.values(loaded.config.hooks).some((groups) => (groups?.length ?? 0) > 0);
}

function countExecutableHooks(loaded: LoadedCodexHooks): number {
  let count = 0;
  for (const groups of Object.values(loaded.config.hooks)) {
    for (const group of groups ?? []) {
      count += group.hooks.filter((handler) => handler.type === "command" && !handler.async).length;
    }
  }
  return count;
}

function commonInput(
  eventName: CodexHookEvent,
  ctx: ExtensionContext,
): Record<string, unknown> {
  return {
    session_id: ctx.sessionManager.getSessionId(),
    transcript_path: ctx.sessionManager.getSessionFile() ?? null,
    cwd: ctx.cwd,
    hook_event_name: eventName,
    model: ctx.model?.id ?? "unknown",
    permission_mode: "default",
  };
}

function turnInput(
  eventName: CodexHookEvent,
  ctx: ExtensionContext,
  state: HookState,
): Record<string, unknown> {
  state.turnId ??= randomUUID();
  return { ...commonInput(eventName, ctx), turn_id: state.turnId };
}

function sessionStartSource(reason: string): "startup" | "resume" | "clear" | "compact" {
  if (reason === "resume" || reason === "fork") return "resume";
  if (reason === "new") return "clear";
  return "startup";
}

function toolMatchValues(toolName: string): string[] {
  if (toolName === "bash") return ["Bash", "bash"];
  if (toolName === "edit") return ["Edit", "edit"];
  if (toolName === "write") return ["Write", "write"];
  return [toolName];
}

function blockingReason(outputs: ParsedHookOutput[]): string | undefined {
  for (const output of outputs) {
    if (output.exitCode === 2) return output.stderr.trim() || "Blocked by hook.";
    if (!isSuccessfulOutput(output)) continue;
    if (output.json?.decision === "block") return stringField(output.json, "reason") ?? "Blocked by hook.";
  }
  return undefined;
}

function continueFalseReason(outputs: ParsedHookOutput[]): string | undefined {
  const output = outputs.find(hasContinueFalse);
  if (!output?.json) return undefined;
  return stringField(output.json, "stopReason") ?? stringField(output.json, "systemMessage") ?? "Stopped by hook.";
}

function hasContinueFalse(output: ParsedHookOutput): boolean {
  return isSuccessfulOutput(output) && output.json?.continue === false;
}

function lastUpdatedInput(outputs: ParsedHookOutput[]): Record<string, unknown> | undefined {
  let updated: Record<string, unknown> | undefined;
  for (const output of outputs) {
    if (!isSuccessfulOutput(output)) continue;
    const specific = hookSpecific(output);
    if (
      (specific?.permissionDecision === "allow" || specific?.permissionDecision === "ask")
      && isRecord(specific.updatedInput)
    ) {
      updated = specific.updatedInput;
    }
  }
  return updated;
}

function collectAdditionalContext(outputs: ParsedHookOutput[], allowPlainText: boolean): string[] {
  const context: string[] = [];
  for (const output of outputs) {
    if (!isSuccessfulOutput(output)) continue;
    if (allowPlainText && output.plainText) context.push(output.plainText);
    const specific = hookSpecific(output);
    if (typeof specific?.additionalContext === "string") context.push(specific.additionalContext);
  }
  return context;
}

function isSuccessfulOutput(output: ParsedHookOutput): boolean {
  return output.exitCode === 0 && !output.timedOut && !output.error;
}

function hookSpecific(output: ParsedHookOutput): Record<string, unknown> | undefined {
  return isRecord(output.json?.hookSpecificOutput) ? output.json.hookSpecificOutput : undefined;
}

function notifySystemMessage(output: ParsedHookOutput, ctx: ExtensionContext): void {
  if (!isSuccessfulOutput(output)) return;
  const message = output.json && stringField(output.json, "systemMessage");
  if (message) ctx.ui.notify(truncateHookText(message, MAX_HOOK_NOTICE_LENGTH), "info");
}

function sendHookFailureMessage(
  pi: ExtensionAPI,
  eventName: CodexHookEvent,
  failures: ParsedHookOutput[],
): void {
  const first = failures[0];
  if (!first) return;
  const firstReason = hookFailureReason(first);
  const firstOutput = hookOutputText(first);
  const summaries = failures.slice(1, MAX_FAILURE_SUMMARIES).map((failure, index) => {
    const command = hookCommand(failure);
    const reason = hookFailureReason(failure);
    return `${index + 2}. ${truncateHookText(command, 120)} · ${truncateHookText(reason, 240)}`;
  });
  const remaining = failures.length - Math.min(failures.length, MAX_FAILURE_SUMMARIES);
  pi.sendMessage({
    customType: "codex-hook-failure",
    content: [
      `Hook failed · ${eventName}${failures.length > 1 ? ` (${failures.length})` : ""}`,
      `command: ${truncateHookText(hookCommand(first), MAX_HOOK_COMMAND_LENGTH)}`,
      `reason: ${truncateHookText(firstReason, MAX_HOOK_NOTICE_LENGTH)}`,
      ...(firstOutput && firstOutput !== firstReason
        ? [`output: ${truncateHookText(firstOutput, MAX_HOOK_OUTPUT_LENGTH)}`]
        : []),
      ...(summaries.length > 0 ? ["other failures:", ...summaries] : []),
      ...(remaining > 0 ? [`… ${remaining} more failures`] : []),
    ].join("\n"),
    display: true,
    details: { event: eventName, count: failures.length },
  }, { triggerTurn: false });
}

function hookCommand(output: ParsedHookOutput): string {
  return process.platform === "win32" && output.handler.commandWindows
    ? output.handler.commandWindows
    : output.handler.command;
}

function hookFailureReason(output: ParsedHookOutput): string {
  return output.error || output.stderr.trim() || `exit ${output.exitCode ?? "unknown"}`;
}

function hookOutputText(output: ParsedHookOutput): string {
  if (output.plainText?.trim()) return output.plainText.trim();
  if (output.json) return JSON.stringify(output.json, null, 2);
  if (output.stdout.trim()) return output.stdout.trim();
  if (output.stderr.trim()) return output.stderr.trim();
  if (output.error) return output.error;
  return `exit ${output.exitCode ?? "unknown"}`;
}

function truncateHookText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const suffix = "\n… [truncated]";
  return `${value.slice(0, maxLength - suffix.length)}${suffix}`;
}

function outputCompatibilityError(
  eventName: CodexHookEvent,
  output: ParsedHookOutput,
): string | undefined {
  if (!isSuccessfulOutput(output)) return undefined;
  const json = output.json;
  if (eventName === "Stop" && output.exitCode === 0 && output.plainText) {
    return "Stop must return JSON, plain text is not supported";
  }
  if (!json) return undefined;
  if (eventName === "PreToolUse") {
    const specific = hookSpecific(output);
    if (json.continue === false || "stopReason" in json || "suppressOutput" in json) {
      return "PreToolUse does not support continue, stopReason, or suppressOutput";
    }
    if (isRecord(specific?.updatedInput) && specific?.permissionDecision !== "allow") {
      if (specific?.permissionDecision !== "ask") {
        return "updatedInput must be returned together with permissionDecision: allow or ask";
      }
    }
  }
  if (eventName === "PostToolUse" && ("updatedMCPToolOutput" in json || "suppressOutput" in json)) {
    return "PostToolUse does not currently support updatedMCPToolOutput or suppressOutput";
  }
  return undefined;
}

function replaceRecord(target: Record<string, unknown>, replacement: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

function findLastAssistantText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const text = contentText(message.content);
    if (text) return text;
  }
  return null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n");
}

function reportCompatibilityWarnings(ctx: ExtensionContext, loaded: LoadedCodexHooks): void {
  const configuredUnsupported = UNSUPPORTED_PI_EVENTS.filter((eventName) =>
    (loaded.config.hooks[eventName]?.length ?? 0) > 0,
  );
  if (configuredUnsupported.length > 0) {
    ctx.ui.notify(`Pi has no mapping for Codex hook events: ${configuredUnsupported.join(", ")}`, "warning");
  }
  const skipped = countSkippedHandlers(loaded.config);
  if (skipped > 0) ctx.ui.notify(`Skipped ${skipped} prompt/agent/async hooks; only synchronous command hooks run.`, "warning");
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
