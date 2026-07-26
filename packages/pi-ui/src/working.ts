/** Animated Codex-style status shimmer and elapsed transcript row. */

import type { ExtensionAPI, ExtensionContext, Theme, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { Loader, Text } from "@earendil-works/pi-tui";
import { fgRgb, gradientText, WORKING_STOPS } from "./gradient.ts";

const INTERVAL_MS = 120;
const PHASE_FRAMES = 18;
const ELAPSED_ENTRY_TYPE = "pi-ui-elapsed";
const LOADER_ORIGINAL_UPDATE = Symbol.for("@NekoSekaiMoe/pi-ui:loader-original-update");

function indicator(): WorkingIndicatorOptions {
  return { frames: [fgRgb("·", [34, 197, 94])], intervalMs: INTERVAL_MS };
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function workingMessage(theme: Theme, elapsedMs: number, frame: number): string {
  const phase = (frame % PHASE_FRAMES) / PHASE_FRAMES;
  const word = gradientText("Working", WORKING_STOPS, phase);
  const suffix = theme.fg("dim", ` (${formatElapsed(elapsedMs)} · esc to interrupt)`);
  return `${word}${suffix}`;
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
    const phases = new WeakMap<object, number>();
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

      const phase = phases.get(this as object) ?? 0;
      phases.set(this as object, (phase + 1) % PHASE_FRAMES);
      this.setText(`${fgRgb("·", [34, 197, 94])} ${gradientText(message, WORKING_STOPS, phase / PHASE_FRAMES)}`);
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
  let frame = 0;
  const restoreStatusGradients = installStatusGradients();

  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  };

  const render = (ctx: ExtensionContext) => {
    if (startedAt === undefined) return;
    ctx.ui.setWorkingMessage(workingMessage(ctx.ui.theme, Date.now() - startedAt, frame));
    frame++;
  };

  pi.registerEntryRenderer(ELAPSED_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data as { elapsedMs?: unknown } | undefined;
    const elapsedMs = typeof data?.elapsedMs === "number" ? data.elapsedMs : 0;
    return new Text(theme.fg("dim", `Worked for ${formatElapsed(elapsedMs)}`), 0, 0);
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingIndicator(indicator());
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (startedAt === undefined) {
      startedAt = Date.now();
      frame = 0;
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
    restoreStatusGradients();
  };

  pi.on("session_shutdown", cleanup);
  return cleanup;
}
