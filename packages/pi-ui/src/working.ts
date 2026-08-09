/** Animated omp-style status shimmer and elapsed transcript row. */

import type { ExtensionAPI, ExtensionContext, Theme, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { Loader, Text } from "@earendil-works/pi-tui";
import { fgRgb } from "./gradient.ts";
import { HINT_SHIMMER_PALETTE, MAIN_SHIMMER_PALETTE, shimmerSegments, shimmerText } from "./shimmer.ts";

// ~30fps so the fixed-velocity band (30 cells/s) advances <= 1 cell per frame,
// matching omp's loader cadence.
const INTERVAL_MS = 1000 / 30;
const ELAPSED_ENTRY_TYPE = "pi-ui-elapsed";
const LOADER_ORIGINAL_UPDATE = Symbol.for("@NekoSekaiMoe/pi-ui:loader-original-update");
const MAX_STEP_CHARS = 48;

/** Theme captured from the latest event context, for the Loader prototype patch. */
let activeTheme: Theme | undefined;

function indicator(): WorkingIndicatorOptions {
  return { frames: [fgRgb("·", [34, 197, 94])], intervalMs: INTERVAL_MS };
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/** Mirror of the todo extension's list, synced from its tool_result details. */
interface MirroredTodo {
  text: string;
  status: string;
}

interface PlanStep {
  done: number;
  total: number;
  text: string;
}

let planTodos: MirroredTodo[] = [];

function syncPlanFromToolResult(event: { toolName: string; details?: unknown }): void {
  if (event.toolName !== "todo") return;
  const details = event.details as { todos?: unknown } | undefined;
  const raw = Array.isArray(details?.todos) ? details.todos : [];
  planTodos = raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      text: typeof item.text === "string" ? item.text : "",
      status: typeof item.status === "string" ? item.status : "pending",
    }));
}

function truncateStep(text: string): string {
  const chars = [...text];
  return chars.length > MAX_STEP_CHARS ? `${chars.slice(0, MAX_STEP_CHARS - 1).join("")}…` : text;
}

/** Current step while a plan has open todos; undefined once it finishes. */
function currentPlanStep(): PlanStep | undefined {
  if (planTodos.length === 0) return undefined;
  const open = planTodos.filter((todo) => todo.status !== "completed" && todo.status !== "cancelled");
  if (open.length === 0) return undefined;
  const current = open.find((todo) => todo.status === "in_progress") ?? open[0]!;
  return { done: planTodos.length - open.length, total: planTodos.length, text: truncateStep(current.text) };
}

function workingMessage(theme: Theme, elapsedMs: number): string {
  const step = currentPlanStep();
  // While a todo plan is being implemented, the step list replaces the word
  // "Working"; a finished/cleared plan falls back to the plain label.
  const label = step ? `${step.done}/${step.total} ${step.text}` : "Working";
  return shimmerSegments(
    [
      { text: label, palette: MAIN_SHIMMER_PALETTE },
      { text: ` (${formatElapsed(elapsedMs)} · esc to interrupt)`, palette: HINT_SHIMMER_PALETTE },
    ],
    theme,
  );
}

type LoaderUpdate = (this: StatusLoaderState) => void;

interface StatusLoaderState {
  kind?: unknown;
  message?: unknown;
  setText(text: string): void;
  ui?: { requestRender?: () => void } | null;
}

function installStatusGradients(): () => void {
  const noop = () => {};
  try {
    const prototype = Loader.prototype as unknown as Record<PropertyKey, unknown>;
    const currentUpdate = prototype.updateDisplay;
    if (typeof currentUpdate !== "function") return noop;

    const originalUpdate =
      (prototype[LOADER_ORIGINAL_UPDATE] as LoaderUpdate | undefined) ?? currentUpdate as LoaderUpdate;
    const patchedUpdate: LoaderUpdate = function (this: StatusLoaderState): void {
      const message = typeof this.message === "string" ? this.message : "";
      const isRetryOrCompaction =
        this.kind === "retry" ||
        this.kind === "compaction" ||
        message.startsWith("Retrying (") ||
        message.includes("Compacting context...") ||
        message.includes("Auto-compacting...");
      if (!isRetryOrCompaction) {
        originalUpdate.call(this);
        return;
      }

      const word = activeTheme ? shimmerText(message, activeTheme) : message;
      this.setText(`${fgRgb("·", [34, 197, 94])} ${word}`);
      this.ui?.requestRender?.();
    };

    prototype[LOADER_ORIGINAL_UPDATE] = originalUpdate;
    prototype.updateDisplay = patchedUpdate;
    return () => {
      if (prototype.updateDisplay === patchedUpdate) prototype.updateDisplay = originalUpdate;
    };
  } catch {
    // Keep Pi's default status colors if Loader internals change.
    return noop;
  }
}

export function installWorking(pi: ExtensionAPI): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt: number | undefined;
  const restoreStatusGradients = installStatusGradients();

  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  };

  const render = (ctx: ExtensionContext) => {
    if (startedAt === undefined) return;
    ctx.ui.setWorkingMessage(workingMessage(ctx.ui.theme, Date.now() - startedAt));
  };

  pi.registerEntryRenderer(ELAPSED_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { elapsedMs?: unknown } | undefined;
    const elapsedMs = typeof data?.elapsedMs === "number" ? data.elapsedMs : 0;
    return new Text(theme.fg("dim", `Worked for ${formatElapsed(elapsedMs)}`), 0, 0);
  });

  pi.on("session_start", (_event, ctx) => {
    planTodos = [];
    if (ctx.mode !== "tui") return;
    activeTheme = ctx.ui.theme;
    ctx.ui.setWorkingIndicator(indicator());
  });

  // Mirror the todo extension's plan from its result details. The tool's own
  // execute stays untouched; this only drives the Working-line label.
  pi.on("tool_result", (event) => {
    syncPlanFromToolResult(event);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    activeTheme = ctx.ui.theme;
    if (startedAt === undefined) {
      startedAt = Date.now();
    }
    ctx.ui.setWorkingIndicator(indicator());
    render(ctx);
    timer ??= setInterval(() => render(ctx), INTERVAL_MS);
  });

  pi.on("agent_settled", (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui") return;
    if (startedAt !== undefined) {
      pi.appendEntry(ELAPSED_ENTRY_TYPE, { elapsedMs: Date.now() - startedAt });
      startedAt = undefined;
    }
    ctx.ui.setWorkingMessage();
  });

  const cleanup = () => {
    stop();
    startedAt = undefined;
    planTodos = [];
    activeTheme = undefined;
    restoreStatusGradients();
  };

  pi.on("session_shutdown", cleanup);
  return cleanup;
}
