/**
 * Flat Codex-style skin for pi-subagents' async-jobs widget.
 *
 * pi-subagents renders its live async status through
 * ctx.ui.setWidget("subagent-async", factory) with a boxed, tree-glyph layout
 * (bold `async subagent …` title, ├─/└─ branches, ⎿ activity lines) that
 * clashes with pi-ui's flat tool rows. Execution and job tracking stay inside
 * pi-subagents; pi-ui only intercepts the widget write and re-renders each
 * produced line as a flat row:
 *
 *   ● parallel · 2 agents running · 0/2 done · 25 tool uses · 37k token · 43.6s
 *   └ Agent 1/2: worker · running (k3 · thinking high) · 14 tool uses · 20k token
 *       active 2s ago
 *       Press ctrl+o for live detail
 *       output: /tmp/…/output-0.log
 *
 * The skin is pure string surgery on the lines the original factory renders,
 * so pi-subagents layout changes degrade gracefully (unknown lines pass
 * through as dim continuation rows) rather than breaking.
 */

import type { ExtensionUIContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";

/** Widget key used by pi-subagents (src/shared/types.ts: WIDGET_KEY). */
export const SUBAGENT_WIDGET_KEY = "subagent-async";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
// Braille spinner frames (U+2800–28FF) plus the static status marks used by
// pi-subagents' widgetStatusGlyph/widgetStepGlyph.
const STATUS_GLYPH = /^([⠀-⣿●○◦✓✔✗✕■])(?:\s+|$)/u;
const AGENT_ROW = /^(?:Agent|Step) \d+\/\d+: /;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function glyphColor(glyph: string): ThemeColor {
  if (glyph === "✓" || glyph === "✔") return "success";
  if (glyph === "✗" || glyph === "✕") return "error";
  if (glyph === "■") return "warning";
  if (glyph === "○" || glyph === "◦") return "dim";
  return "accent"; // braille frames and ●
}

function normalizeGlyph(glyph: string): string {
  return "✓✔✗✕■".includes(glyph) ? glyph : "●";
}

/** Split "<main> · <stats>" so the stats trail dims like pi-ui's tool-row suffixes. */
function splitMain(body: string): [string, string] {
  const index = body.indexOf(" · ");
  return index < 0 ? [body, ""] : [body.slice(0, index), body.slice(index)];
}

/**
 * Rebuild one rendered widget line in pi-ui's flat style. Returns undefined
 * for lines that should be dropped (the redundant bold title).
 */
function flattenLine(raw: string, theme: Theme): string | undefined {
  // pi-tui's Text pads every row to full width and adds a 1-cell left
  // margin; remove both before judging a line's own indentation.
  const plain = stripAnsi(raw).trimEnd().replace(/^ /, "");
  const trimmed = plain.trim();
  if (!trimmed) return ""; // preserve progressive-tier spacer rows
  if (trimmed.startsWith("async subagent ")) return undefined;

  let body = trimmed;
  let level = /^\s/.test(plain) ? 1 : 0;
  // Multi-job tree: the job item carries a ├─/└─ branch, its children a │ rail.
  if (body.startsWith("├─ ") || body.startsWith("└─ ")) {
    body = body.slice(3).trimStart();
    level = 0;
  } else if (body.startsWith("│")) {
    body = body.slice(1).trimStart();
    level = 1;
  }
  // Nested agent markers from widgetParallelAgentDetails ("├ ⠋ Agent 1/2: …").
  if (body.startsWith("├ ") || body.startsWith("└ ")) {
    body = body.slice(2).trimStart();
    level = 1;
  }

  // "⎿  <activity>" continuation → dim detail row under the agent rows.
  if (body.startsWith("⎿")) {
    return `    ${theme.fg("dim", body.slice(1).trimStart())}`;
  }

  const glyphMatch = body.match(STATUS_GLYPH);
  if (glyphMatch) {
    const glyph = glyphMatch[1]!;
    const rest = body.slice(glyphMatch[0].length);
    const [main, stats] = splitMain(rest);
    const dimStats = stats ? theme.fg("dim", stats) : "";
    if (AGENT_ROW.test(rest)) {
      // Flat agent row, mirroring pi-ui's "  └ <output>" tool rows.
      return `  ${theme.fg("dim", "└")} ${theme.fg("text", main)}${dimStats}`;
    }
    const mark = theme.fg(glyphColor(glyph), normalizeGlyph(glyph));
    return level === 0
      ? `${mark} ${theme.fg("text", main)}${dimStats}`
      : `  ${mark} ${theme.fg("text", main)}${dimStats}`;
  }

  // Remaining rows (ctrl+o hint, output path, ↳ nested runs, "+N more",
  // expanded tool/output detail) become dim continuation lines.
  return level === 0 ? theme.fg("dim", body) : `    ${theme.fg("dim", body)}`;
}

type WidgetComponent = Component & { dispose?(): void };
type WidgetFactory = (tui: TUI, theme: Theme) => WidgetComponent;

function skinFactory(factory: WidgetFactory): WidgetFactory {
  return (tui, theme) => {
    const inner = factory(tui, theme);
    const skinned: WidgetComponent = {
      render(width: number): string[] {
        const safeWidth = Math.max(1, width);
        const lines: string[] = [];
        for (const raw of inner.render(safeWidth)) {
          const flat = flattenLine(raw, theme);
          if (flat === undefined) continue;
          lines.push(truncateToWidth(flat, safeWidth, "…"));
        }
        return lines;
      },
      invalidate(): void {
        inner.invalidate();
      },
    };
    if (inner.dispose) skinned.dispose = () => inner.dispose!();
    return skinned;
  };
}

/**
 * Wrap ctx.ui.setWidget so pi-subagents' async widget renders with flat rows.
 * Composes with suppressTodoWidget (both wrap the same method; the routed
 * keys are disjoint). ctx.ui is shared for the whole session, so wrapping
 * once per ExtensionUIContext instance is enough.
 */
const skinnedContexts = new WeakSet<object>();
export function skinSubagentWidget(ui: ExtensionUIContext): void {
  if (skinnedContexts.has(ui)) return;
  type SetWidget = ExtensionUIContext["setWidget"];
  const original = ui.setWidget.bind(ui) as SetWidget;
  const call = original as (key: string, content: unknown, options?: unknown) => void;
  const wrapped = ((key: string, content: unknown, options?: unknown) => {
    call(
      key,
      key === SUBAGENT_WIDGET_KEY && typeof content === "function"
        ? skinFactory(content as WidgetFactory)
        : content,
      options,
    );
  }) as SetWidget;
  ui.setWidget = wrapped;
  skinnedContexts.add(ui);
}
