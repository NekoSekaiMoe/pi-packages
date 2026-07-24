/** Open Codex-style input frame with an embedded model toolbar. */

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { bgRgb, FRAME_STOPS, gradientText } from "./gradient.ts";
import type { ReferenceUiState } from "./state.ts";

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

function fitBorder(line: string, width: number): string {
  const fitted = truncateToWidth(stripAnsi(line), width, "");
  return fitted + "─".repeat(Math.max(0, width - visibleWidth(fitted)));
}

function hideLeadingShellBang(line: string, width: number): string {
  const bangIndex = line.indexOf("!");
  if (bangIndex < 0) return line;
  return fitLine(line.slice(0, bangIndex) + line.slice(bangIndex + 1), width, "");
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

export function makeReferenceEditorFactory(ctx: ExtensionContext, pi: ExtensionAPI, uiState: ReferenceUiState) {
  return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): CustomEditor => {
    class ReferenceEditor extends CustomEditor {
      constructor() {
        super(tui, theme, keybindings, { paddingX: 0 });
        // The TUI defaults to differential redraws that may leave old rows behind
        // when this component becomes shorter after a resize or menu close.
        tui.setClearOnShrink(true);
      }

      private syncShellMode(): void {
        const shellMode = this.getText().startsWith("!");
        if (uiState.shellMode === shellMode) return;
        uiState.shellMode = shellMode;
        tui.requestRender();
      }

      override handleInput(data: string): void {
        // Support pasting multi-line text by converting newlines to spaces
        const normalized = data.replace(/[\r\n]+/g, ' ');
        super.handleInput(normalized);
        this.syncShellMode();
      }

      override setText(text: string): void {
        super.setText(text);
        this.syncShellMode();
      }

      render(width: number): string[] {
        if (width < 3) return super.render(width);

        // Reserve one column for the solid accent and one for its inner gap. Keeping every
        // byte of the base line intact is important: focused lines contain
        // Pi's zero-width CURSOR_MARKER control sequence.
        const lines = super.render(width - 2);
        const bottomIndex = lines.findIndex((line, index) => index > 0 && isEditorBorder(line));
        if (bottomIndex < 0) return lines;

        // A background-colored cell fills the terminal row completely, unlike
        // box/block glyphs which can expose gaps with custom line-height fonts.
        const vertical = bgRgb(" ", FRAME_STOPS[0]!);
        const top = gradientText(fitBorder(lines[0]!, width), FRAME_STOPS);
        const spacer = `${vertical}${" ".repeat(width - 1)}`;
        const editorLines = lines.slice(1, bottomIndex);
        if (uiState.shellMode && editorLines[0]) {
          // Pi still receives !command on submit; only the shell-mode prefix is
          // hidden so the command begins at the same column as a normal prompt.
          editorLines[0] = hideLeadingShellBang(editorLines[0], width - 2);
        }
        const content = editorLines.map((line) => `${vertical} ${line}`);
        // The reference keeps the cursor visually centered between the frame
        // rules: one blank row above the editor content and one below it.
        const body = [spacer, ...content, spacer];
        const toolbar = fitLine(
          `${vertical} ${renderModelToolbar(ctx, pi, width - 2)}`,
          width,
          ctx.ui.theme.fg("dim", "…"),
        );
        const bottom = gradientText(fitBorder(lines[bottomIndex]!, width), FRAME_STOPS);
        const autocomplete = lines.slice(bottomIndex + 1).map((line) => fitLine(line, width, ""));
        // Pi's base Editor appends autocomplete below its border. Keep the
        // prompt fixed while a menu is open, but do not reserve those rows when
        // the menu is idle; otherwise Working and the prompt drift apart.
        const menuPadding =
          autocomplete.length > 0
            ? Array.from(
                { length: Math.max(0, this.getAutocompleteMaxVisible() - autocomplete.length) },
                () => " ".repeat(width),
              )
            : [];
        return [...menuPadding, ...autocomplete, top, ...body, toolbar, bottom];
      }
    }

    return new ReferenceEditor();
  };
}
