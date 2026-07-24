/** Animated Codex-style `Working` shimmer. */

import type { ExtensionAPI, ExtensionContext, Theme, WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";
import { fgRgb, gradientText, WORKING_STOPS } from "./gradient.ts";

const INTERVAL_MS = 120;
const PHASE_FRAMES = 18;

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

export function installWorking(pi: ExtensionAPI): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;
  let startedAt = 0;
  let frame = 0;

  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  };

  const render = (ctx: ExtensionContext) => {
    ctx.ui.setWorkingMessage(workingMessage(ctx.ui.theme, Date.now() - startedAt, frame));
    frame++;
  };

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingIndicator(indicator());
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    stop();
    startedAt = Date.now();
    frame = 0;
    ctx.ui.setWorkingIndicator(indicator());
    render(ctx);
    timer = setInterval(() => render(ctx), INTERVAL_MS);
  });

  pi.on("agent_settled", (_event, ctx) => {
    stop();
    if (ctx.mode !== "tui") return;
    ctx.ui.setWorkingMessage();
  });

  pi.on("session_shutdown", () => stop());
  return stop;
}
