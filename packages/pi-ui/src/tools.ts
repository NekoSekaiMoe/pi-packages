/** Flat Codex-style renderers for Pi's built-in tools. */

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { fgRgb } from "./gradient.ts";

interface RowConfig {
  running: string;
  done: string;
  primary: (args: Record<string, unknown>) => string;
  shell?: boolean;
}

/** The stable subset of ToolRenderContext used by these renderers. */
interface RenderContext {
  lastComponent: unknown;
  isPartial: boolean;
  isError: boolean;
}

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const DOT_RUNNING: readonly [number, number, number] = [148, 148, 158];
const DOT_DONE: readonly [number, number, number] = [74, 222, 128];
const DOT_ERROR: readonly [number, number, number] = [244, 63, 94];
const COMMAND_COLOR: readonly [number, number, number] = [137, 180, 250];
const FLAG_COLOR: readonly [number, number, number] = [239, 160, 190];

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const ROWS: Record<string, RowConfig> = {
  bash: { running: "Running", done: "Ran", primary: (args) => str(args.command), shell: true },
  read: { running: "Reading", done: "Read", primary: (args) => str(args.path) },
  edit: { running: "Editing", done: "Edited", primary: (args) => str(args.path) },
  write: { running: "Writing", done: "Wrote", primary: (args) => str(args.path) },
  grep: { running: "Searching", done: "Searched", primary: (args) => str(args.pattern) },
  find: { running: "Finding", done: "Found", primary: (args) => str(args.pattern) },
  ls: { running: "Listing", done: "Listed", primary: (args) => str(args.path) || "." },
};

const FACTORIES: Record<string, (cwd: string) => ToolDefinition<any, any, any>> = {
  bash: (cwd) => createBashToolDefinition(cwd) as ToolDefinition<any, any, any>,
  read: (cwd) => createReadToolDefinition(cwd) as ToolDefinition<any, any, any>,
  edit: (cwd) => createEditToolDefinition(cwd) as ToolDefinition<any, any, any>,
  write: (cwd) => createWriteToolDefinition(cwd) as ToolDefinition<any, any, any>,
  grep: (cwd) => createGrepToolDefinition(cwd) as ToolDefinition<any, any, any>,
  find: (cwd) => createFindToolDefinition(cwd) as ToolDefinition<any, any, any>,
  ls: (cwd) => createLsToolDefinition(cwd) as ToolDefinition<any, any, any>,
};

function styleShellCommand(command: string, theme: Theme): string {
  let tokenIndex = 0;
  return command
    .split(/(\s+)/)
    .map((part) => {
      if (!part.trim()) return part;
      const current = tokenIndex++;
      if (current === 0) return fgRgb(part, COMMAND_COLOR);
      if (/^-{1,2}[\w-]/.test(part)) return fgRgb(part, FLAG_COLOR);
      if (/^(?:\||\|\||&&|;|>|>>|<)$/.test(part)) return theme.fg("dim", part);
      return theme.fg("toolOutput", part);
    })
    .join("");
}

function renderPrimary(value: string, config: RowConfig, theme: Theme): string {
  if (!value) return theme.fg("toolOutput", "…");
  return config.shell ? styleShellCommand(value, theme) : theme.fg("accent", value);
}

function renderTitle(
  config: RowConfig,
  args: Record<string, unknown>,
  context: RenderContext,
  theme: Theme,
): string {
  const running = context.isPartial;
  const dot = fgRgb("•", context.isError ? DOT_ERROR : running ? DOT_RUNNING : DOT_DONE);
  const verb = theme.bold(theme.fg("toolTitle", running ? config.running : config.done));
  return `${dot} ${verb} ${renderPrimary(config.primary(args), config, theme)}`;
}

function textOutput(result: AgentToolResult<unknown>): string {
  return result.content
    .filter(
      (item): item is { type: "text"; text: string } =>
        item.type === "text" && typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => item.text)
    .join("\n")
    .replace(ANSI_PATTERN, "")
    .trim();
}

function renderResultText(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): string {
  if (options.isPartial) return "";

  const output = textOutput(result);
  const lines = output ? output.split("\n") : ["(no output)"];
  const visibleLines = options.expanded ? lines : [lines.find((line) => line.trim().length > 0) ?? "(no output)"];

  return visibleLines
    .map((line, index) => {
      const branch = theme.fg("dim", index === 0 ? "  └ " : "    ");
      return branch + theme.fg("toolOutput", line);
    })
    .join("\n");
}

function codexifyTool(name: string, cwd: string): ToolDefinition<any, any, any> | undefined {
  const factory = FACTORIES[name];
  const config = ROWS[name];
  if (!factory || !config) return undefined;

  const builtin = factory(cwd);
  return {
    ...builtin,
    renderShell: "self",
    renderCall(args: unknown, theme: Theme, context: RenderContext): Text {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(renderTitle(config, (args as Record<string, unknown>) ?? {}, context, theme));
      return text;
    },
    renderResult(
      result: AgentToolResult<unknown>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: RenderContext,
    ): Text {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(renderResultText(result, options, theme));
      return text;
    },
  };
}

export function installToolRenderers(pi: ExtensionAPI, cwd: string): string[] {
  const installed: string[] = [];
  for (const name of Object.keys(FACTORIES)) {
    try {
      const definition = codexifyTool(name, cwd);
      if (!definition) continue;
      pi.registerTool(definition);
      installed.push(name);
    } catch {
      // Keep Pi's built-in renderer when an internal factory changes.
    }
  }
  return installed;
}
