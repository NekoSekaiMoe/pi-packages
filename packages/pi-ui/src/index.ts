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
 *     built-in tools, and automatically for every other tool via a renderer
 *     lookup redirect on ToolExecutionComponent.
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

import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { makeReferenceEditorFactory } from "./editor.ts";
import { installFooter } from "./footer.ts";
import { FRAME_STOPS, gradientText } from "./gradient.ts";
import { installExternalToolRenderers, installShellRenderer, installToolRenderers } from "./tools.ts";
import { installWorking } from "./working.ts";

const patchedThemes = new WeakSet<Theme>();
const PI_THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme");

function installResourceHeadingGradient(themeProxy: Theme): void {
  // Pi exposes a forwarding Proxy to extensions. Patch the shared instance
  // behind it so startup resources, which import the same global theme, see it.
  const globalThemes = globalThis as typeof globalThis & { [PI_THEME_KEY]?: Theme };
  const theme = globalThemes[PI_THEME_KEY] ?? themeProxy;
  if (patchedThemes.has(theme)) return;
  const originalFg = theme.fg.bind(theme);
  theme.fg = (color: ThemeColor, text: string): string => {
    if (color === "mdHeading" && /^\[[^\]\n]+\]$/.test(text)) {
      return gradientText(text, FRAME_STOPS);
    }
    return originalFg(color, text);
  };
  patchedThemes.add(theme);
}

export default function (pi: ExtensionAPI) {
  // Patch renderer lookup before any restored tool components are created.
  // This changes only presentation; extension-owned execute functions remain
  // registered and invoked as-is. The patch covers every tool pi-ui does not
  // re-register itself, so new extension tools get flat rows automatically.
  //
  // It is installed ONCE for the process lifetime and intentionally NOT
  // restored on session_shutdown: that event also fires on session switches
  // (/resume, /new, fork), and restoring there would silently revert
  // grep/find/web_search/etc. to Pi's bordered default for the rest of the
  // process, since nothing reinstalls the patch between sessions.
  installExternalToolRenderers();
  let restoreShellRenderer = () => {};

  // Register Codex-style tool renderers at load time. Most built-ins are
  // overridden by name; grep/find use the renderer-only prototype redirect so
  // extension-owned implementations remain intact regardless of load order.
  // Factory failures are isolated per tool. Renderers only run in TUI mode.
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
    const uiState = { shellMode: false };
    installResourceHeadingGradient(ctx.ui.theme);
    restoreShellRenderer();
    restoreShellRenderer = installShellRenderer(ctx.ui.theme);
    ctx.ui.setEditorComponent(makeReferenceEditorFactory(ctx, pi, uiState));
    installFooter(ctx, uiState);
  });

  pi.on("session_shutdown", () => {
    restoreShellRenderer();
  });
}
