/** One-line toolbar below the editor, matching the reference layout. */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ReferenceUiState } from "./state.ts";

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function collectUsage(ctx: ExtensionContext) {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const message = entry.message as AssistantMessage;
    totals.input += message.usage.input;
    totals.output += message.usage.output;
    totals.cacheRead += message.usage.cacheRead;
    totals.cacheWrite += message.usage.cacheWrite;
    totals.cost += message.usage.cost.total;
  }
  return totals;
}

function contextMeter(percent: number, theme: Theme, width = 8): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return (
    theme.fg("dim", "[") +
    theme.fg("accent", "▓".repeat(filled)) +
    theme.fg("dim", "░".repeat(width - filled) + "]")
  );
}

function renderMetrics(ctx: ExtensionContext, theme: Theme): string {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const percent = usage?.percent ?? 0;
  const percentText = usage?.percent === null || usage?.percent === undefined ? "?" : `${percent.toFixed(0)}%`;
  const contextText = `${percentText}/${formatTokens(contextWindow)}`;
  const coloredContext =
    percent > 90
      ? theme.fg("error", contextText)
      : percent > 70
        ? theme.fg("warning", contextText)
        : theme.fg("dim", contextText);

  const totals = collectUsage(ctx);
  const tokenParts = [`↑${formatTokens(totals.input)}`, `↓${formatTokens(totals.output)}`];
  if (totals.cacheRead) tokenParts.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) tokenParts.push(`W${formatTokens(totals.cacheWrite)}`);
  tokenParts.push(`$${totals.cost.toFixed(3)}`);

  return `${contextMeter(percent, theme)} ${coloredContext}  ${theme.fg("dim", tokenParts.join(" "))}`;
}

function sanitizeStatus(text: string): string {
  return text.replace(/[\r\n\t]/g, " ").trim();
}

function formatCwd(cwd: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (home && (cwd === home || cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`))) {
    return `~${cwd.slice(home.length)}`;
  }
  return cwd;
}

function renderLeftToolbar(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  theme: Theme,
  uiState: ReferenceUiState,
): string {
  const statuses = [...footerData.getExtensionStatuses().entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, text]) => sanitizeStatus(text))
    .filter(Boolean);
  const branch = footerData.getGitBranch();
  const location = theme.fg("dim", `${formatCwd(ctx.cwd)}${branch ? ` (${branch})` : ""}`);
  const shellMode = uiState.shellMode ? ` ${theme.fg("warning", "shell mode")}` : "";
  const statusText = statuses.length > 0 ? `  ${theme.fg("dim", statuses.join("  "))}` : "";
  return location + shellMode + statusText;
}

function renderToolbarLine(
  ctx: ExtensionContext,
  theme: Theme,
  footerData: ReadonlyFooterDataProvider,
  uiState: ReferenceUiState,
  width: number,
): string {
  const right = renderMetrics(ctx, theme);
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, theme.fg("dim", "…"));

  const availableLeft = Math.max(0, width - rightWidth - 2);
  const left = truncateToWidth(
    renderLeftToolbar(ctx, footerData, theme, uiState),
    availableLeft,
    theme.fg("dim", "…"),
  );
  const padding = " ".repeat(Math.max(1, width - visibleWidth(left) - rightWidth));
  return left + padding + right;
}

export function installFooter(ctx: ExtensionContext, uiState: ReferenceUiState): void {
  ctx.ui.setFooter((tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider): Component & { dispose?(): void } => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        return width > 0 ? [renderToolbarLine(ctx, theme, footerData, uiState, width)] : [];
      },
    };
  });
}
