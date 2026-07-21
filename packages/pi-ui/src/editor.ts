/** Open Codex-style input frame with an embedded model toolbar. */

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fgRgb, FRAME_STOPS, gradientText } from "./gradient.ts";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function isEditorBorder(line: string): boolean {
  return /^─+(?: [↑↓] \d+ more )?─*$/.test(stripAnsi(line));
}

function fitLine(text: string, width: number, ellipsis: string): string {
  const fitted = truncateToWidth(text, width, ellipsis);
  return fitted + " ".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function providerLabel(provider: string): string {
  const known: Record<string, string> = {
    anthropic: "Anthropic",
    google: "Google",
    openai: "OpenAI",
    "openai-codex": "OpenAI",
    xai: "xAI",
  };
  if (known[provider]) return known[provider]!;
  return provider
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function renderModelToolbar(ctx: ExtensionContext, pi: ExtensionAPI, width: number): string {
  const theme = ctx.ui.theme;
  const model = ctx.model;
  const parts = [theme.fg("text", model?.id ?? "no-model")];

  if (model?.provider) parts.push(theme.fg("muted", providerLabel(model.provider)));
  if (model?.reasoning) parts.push(theme.fg("muted", pi.getThinkingLevel()));

  return truncateToWidth(parts.join("  "), Math.max(0, width), theme.fg("dim", "…"));
}

export function makeReferenceEditorFactory(ctx: ExtensionContext, pi: ExtensionAPI) {
  return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): CustomEditor => {
    class ReferenceEditor extends CustomEditor {
      constructor() {
        super(tui, theme, keybindings, { paddingX: 2 });
      }

      render(width: number): string[] {
        if (width < 4) return super.render(width);

        const lines = super.render(width);
        const bottomIndex = lines.findIndex((line, index) => index > 0 && isEditorBorder(line));
        if (bottomIndex < 0) return lines;

        const vertical = fgRgb("│", FRAME_STOPS[0]!);
        const top = gradientText(stripAnsi(lines[0]!), FRAME_STOPS);
        const body = lines.slice(1, bottomIndex).map((line) => `${vertical}${line.slice(1)}`);
        const toolbar = fitLine(
          `${vertical} ${renderModelToolbar(ctx, pi, width - 2)}`,
          width,
          ctx.ui.theme.fg("dim", "…"),
        );
        const bottom = gradientText(stripAnsi(lines[bottomIndex]!), FRAME_STOPS);
        const autocomplete = lines.slice(bottomIndex + 1);

        return [top, ...body, toolbar, bottom, ...autocomplete];
      }
    }

    return new ReferenceEditor();
  };
}
