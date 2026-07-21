/**
 * pi-ui — Extension entry point
 *
 * Reskins Pi's interactive TUI to match a Codex-style look:
 *
 *   - an open gradient input frame with an embedded model/provider toolbar,
 *   - a one-line footer that preserves extension statuses and right-aligns
 *     context, token, and cost data,
 *   - an animated "Working (Ns · esc to interrupt)" shimmer,
 *   - flat Codex-style tool-call rows (`● Ran <cmd>` / `└ <output>`) for the
 *     built-in tools.
 *
 * Wiring only. Each concern lives in its own module and is installed against
 * documented ExtensionAPI / ExtensionUIContext methods:
 *   - editor.ts   -> ctx.ui.setEditorComponent() + embedded model toolbar
 *   - footer.ts   -> ctx.ui.setFooter() status toolbar
 *   - working.ts  -> pi.on(agent_start/settled) + setWorkingIndicator/Message
 *   - tools.ts    -> pi.registerTool() (overrides built-ins by name)
 *
 * pi.on handlers (tools, working) are registered ONCE at load so they don't
 * stack across session switches/reloads. The per-session setters (editor,
 * footer) are (re)applied on session_start, which is safe because they replace
 * rather than accumulate. Everything visual is guarded to ctx.mode === "tui";
 * other modes (rpc/print/json) keep Pi's defaults.
 *
 * Usage:
 *   pi -e ./src/index.ts
 *   pi install npm:@NekoSekaiMoe/pi-ui
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { makeReferenceEditorFactory } from "./editor.ts";
import { installFooter } from "./footer.ts";
import { installToolRenderers } from "./tools.ts";
import { installWorking } from "./working.ts";

export default function (pi: ExtensionAPI) {
  // Register Codex-style tool renderers at load time. This overrides the
  // built-in tools by name; if a built-in factory changes shape across Pi
  // versions, installToolRenderers swallows the error per-tool and leaves that
  // tool's default rendering intact. Safe in all modes (renderers only run in TUI).
  try {
    installToolRenderers(pi, process.cwd());
  } catch {
    // Never let a rendering swap block extension load.
  }

  // Register the working-indicator lifecycle handlers once (pi.on has no
  // unregister — registering per session_start would stack duplicate timers).
  installWorking(pi);

  // (Re)apply the editor + footer for each session. These are replacing
  // setters, not accumulating registrations, so calling them per start is safe.
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setEditorComponent(makeReferenceEditorFactory(ctx, pi));
    installFooter(ctx);
  });
}
