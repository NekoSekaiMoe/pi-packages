/** Flat Codex-style renderers for Pi's built-in and selected extension tools. */

import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  BashExecutionComponent,
  ToolExecutionComponent,
  generateDiffString,
  renderDiff,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fgRgb } from "./gradient.ts";

interface RowConfig {
  running: string;
  done: string;
  primary: (args: Record<string, unknown>) => string;
  shell?: boolean;
  showPrimary?: boolean;
}

/** The stable subset of ToolRenderContext used by these renderers. */
interface RenderContext {
  lastComponent: unknown;
  isPartial: boolean;
  isError: boolean;
  args?: unknown;
  state?: Record<string, unknown>;
}

interface BashComponentState {
  status?: "running" | "complete" | "error" | "cancelled";
  exitCode?: number;
  expanded?: boolean;
  getCommand(): string;
  getOutput(): string;
}

type ComponentRender = (this: BashComponentState, width: number) => string[];

const SHELL_ORIGINAL_RENDER = Symbol.for("@NekoSekaiMoe/pi-ui:bash-render");
const TOOL_EXECUTION_ORIGINALS = Symbol.for("@NekoSekaiMoe/pi-ui:tool-execution-renderers");

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const DOT_RUNNING: readonly [number, number, number] = [148, 148, 158];
const DOT_DONE: readonly [number, number, number] = [74, 222, 128];
const DOT_ERROR: readonly [number, number, number] = [244, 63, 94];
const COMMAND_COLOR: readonly [number, number, number] = [137, 180, 250];
const FLAG_COLOR: readonly [number, number, number] = [239, 160, 190];
const SHELL_PREVIEW_LINES = 7;
const DIFF_PREVIEW_LINES = 12;
const EXPLORED_PREVIEW_LINES = 12;

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
  // These tools are supplied by extensions rather than Pi itself. Their
  // names and default shells are intentionally normalized to the same row
  // shape as the built-in search/question tools.
  fffind: { running: "Finding", done: "Found", primary: (args) => str(args.pattern) },
  ask_user_question: {
    running: "Asking",
    done: "Asked",
    primary: (args) => {
      const questions = args.questions;
      if (!Array.isArray(questions)) return "";
      const first = questions[0];
      return first && typeof first === "object" ? str((first as Record<string, unknown>).question) : "";
    },
  },
  subagent: { running: "Exploring", done: "Explored", primary: () => "", showPrimary: false },
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
  suffix = "",
): string {
  const running = context.isPartial;
  const dot = fgRgb("•", context.isError ? DOT_ERROR : running ? DOT_RUNNING : DOT_DONE);
  const verb = theme.bold(theme.fg("toolTitle", running ? config.running : config.done));
  const primary = config.primary(args);
  const target = config.showPrimary === false ? "" : ` ${renderPrimary(primary, config, theme)}`;
  return `${dot} ${verb}${target}${suffix}`;
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
    .replace(/\r\n?/g, "\n")
    .trim();
}

interface PreviewLine {
  text: string;
  omitted?: number;
}

interface DiffStats {
  added: number;
  removed: number;
}

interface RowRenderState {
  callComponent?: Text;
  diffStats?: DiffStats;
}

function selectPreviewLines(lines: string[], expanded: boolean, limit: number): PreviewLine[] {
  if (expanded) return lines.map((text) => ({ text }));
  if (limit <= 1) {
    return [{ text: lines.find((line) => line.trim().length > 0) ?? "(no output)" }];
  }
  if (lines.length <= limit) return lines.map((text) => ({ text }));

  const contentLines = Math.max(2, limit - 1);
  const headCount = Math.ceil(contentLines / 2);
  const tailCount = contentLines - headCount;
  const omitted = lines.length - headCount - tailCount;
  return [
    ...lines.slice(0, headCount).map((text) => ({ text })),
    { text: "", omitted },
    ...lines.slice(-tailCount).map((text) => ({ text })),
  ];
}

function diffStats(diff: string): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

function renderDiffStats(stats: DiffStats | undefined, theme: Theme): string {
  if (!stats) return "";
  return (
    " " +
    theme.fg("dim", "(") +
    theme.fg("success", `+${stats.added}`) +
    " " +
    theme.fg("error", `-${stats.removed}`) +
    theme.fg("dim", ")")
  );
}

function renderDiffText(diff: string, expanded: boolean, theme: Theme): string {
  const lines = selectPreviewLines(renderDiff(diff).split("\n"), expanded, DIFF_PREVIEW_LINES);
  return lines
    .map((line) => {
      const indent = "    ";
      if (line.omitted !== undefined) {
        return indent + theme.fg("muted", `… +${line.omitted} diff lines (ctrl+t to view full diff)`);
      }
      return indent + line.text;
    })
    .join("\n");
}

function renderResultText(
  toolName: string,
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): string {
  if (options.isPartial) return "";

  const diff = getResultDiff(result);
  if ((toolName === "edit" || toolName === "write") && typeof diff === "string" && diff) {
    return renderDiffText(diff, options.expanded, theme);
  }

  const output = textOutput(result);
  const previewLines = ROWS[toolName]?.shell ? SHELL_PREVIEW_LINES : 1;
  return renderOutputText(output, options.expanded, theme, previewLines);
}

function getResultDiff(result: AgentToolResult<unknown>): string | undefined {
  const details = result.details;
  if (!details || typeof details !== "object") return undefined;
  const diff = (details as Record<string, unknown>).diff;
  return typeof diff === "string" ? diff : undefined;
}

function renderOutputText(output: string, expanded: boolean, theme: Theme, previewLines = 1): string {
  const lines = output ? output.split("\n") : ["(no output)"];
  const visibleLines = selectPreviewLines(lines, expanded, previewLines);

  return visibleLines
    .map((line, index) => {
      const branch = theme.fg("dim", index === 0 ? "  └ " : "    ");
      if (line.omitted !== undefined) {
        return branch + theme.fg("muted", `… +${line.omitted} lines (ctrl+t to view transcript)`);
      }
      return branch + theme.fg("toolOutput", line.text);
    })
    .join("\n");
}

interface ExploredLine {
  action: string;
  detail: string;
}

function formatExploredSearchDetail(name: string, detail: string): string {
  if (!detail.startsWith("{")) return detail;
  try {
    const args = JSON.parse(detail) as Record<string, unknown>;
    const pattern = str(args.pattern);
    const path = str(args.path);
    if (name === "grep" || name === "ffgrep") {
      return `${pattern}${path ? ` in ${path}` : ""}`;
    }
    if (name === "find" || name === "fffind") return pattern;
  } catch {
    // Keep extension-provided summaries that are not JSON objects.
  }
  return detail;
}

function formatRawSubagentTool(name: string, args: Record<string, unknown>): string {
  if (name === "bash") return `$ ${str(args.command)}`.trim();
  if (name === "read" || name === "write" || name === "edit") {
    return `${name} ${str(args.path) || str(args.file_path)}`.trim();
  }
  if (name === "grep" || name === "ffgrep") {
    const pattern = str(args.pattern);
    const path = str(args.path);
    return `${name} ${pattern}${path ? ` in ${path}` : ""}`.trim();
  }
  if (name === "find" || name === "fffind") return `${name} ${str(args.pattern)}`.trim();
  const encoded = JSON.stringify(args);
  return `${name}${encoded && encoded !== "{}" ? ` ${encoded}` : ""}`;
}

function classifyExploredCall(raw: string): ExploredLine {
  const value = raw.trim();
  if (value.startsWith("$ ")) return { action: "Run", detail: value.slice(2) };

  const separator = value.search(/\s/);
  const name = (separator < 0 ? value : value.slice(0, separator)).toLowerCase();
  const rawDetail = separator < 0 ? "" : value.slice(separator).trim();
  const detail = formatExploredSearchDetail(name, rawDetail);
  const action =
    name === "read" ? "Read" :
    name === "grep" || name === "ffgrep" || name === "find" || name === "fffind" ? "Search" :
    name === "edit" ? "Edit" :
    name === "write" ? "Write" :
    name;
  return { action, detail };
}

function extractExploredCalls(result: AgentToolResult<unknown>, expanded: boolean): ExploredLine[] {
  const details = result.details;
  if (!details || typeof details !== "object") return [];
  const rawDetails = details as Record<string, unknown>;
  const runs = Array.isArray(rawDetails.results) ? rawDetails.results : [];
  const calls: ExploredLine[] = [];

  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const data = run as Record<string, unknown>;
    if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) {
      for (const call of data.toolCalls) {
        if (!call || typeof call !== "object") continue;
        const item = call as Record<string, unknown>;
        const text = expanded ? str(item.expandedText) || str(item.text) : str(item.text) || str(item.expandedText);
        if (text) calls.push(classifyExploredCall(text));
      }
      continue;
    }

    if (!Array.isArray(data.messages)) continue;
    for (const message of data.messages) {
      if (!message || typeof message !== "object") continue;
      const content = (message as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (!part || typeof part !== "object") continue;
        const item = part as Record<string, unknown>;
        if (item.type !== "toolCall" || typeof item.name !== "string") continue;
        const args = item.arguments && typeof item.arguments === "object" && !Array.isArray(item.arguments)
          ? item.arguments as Record<string, unknown>
          : {};
        calls.push(classifyExploredCall(formatRawSubagentTool(item.name, args)));
      }
    }
  }

  return calls;
}

function groupExploredCalls(calls: ExploredLine[]): ExploredLine[] {
  const grouped: ExploredLine[] = [];
  for (const call of calls) {
    const previous = grouped[grouped.length - 1];
    if (previous && previous.action === "Read" && call.action === "Read") {
      previous.detail = `${previous.detail}, ${call.detail}`;
    } else {
      grouped.push({ ...call });
    }
  }
  return grouped;
}

function renderExploredResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
): string {
  const calls = groupExploredCalls(extractExploredCalls(result, options.expanded));
  if (calls.length === 0) return renderOutputText(textOutput(result), options.expanded, theme, SHELL_PREVIEW_LINES);

  const lines = selectPreviewLines(
    calls.map((call) => `${call.action}\t${call.detail}`),
    options.expanded,
    EXPLORED_PREVIEW_LINES,
  );
  return lines
    .map((line, index) => {
      const branch = theme.fg("dim", index === 0 ? "  └ " : "    ");
      if (line.omitted !== undefined) {
        return branch + theme.fg("muted", `… +${line.omitted} actions (ctrl+t to view explored tools)`);
      }
      const separator = line.text.indexOf("\t");
      const action = separator < 0 ? line.text : line.text.slice(0, separator);
      const detail = separator < 0 ? "" : line.text.slice(separator + 1);
      return branch + theme.fg("accent", action) + (detail ? ` ${theme.fg("toolOutput", detail)}` : "");
    })
    .join("\n");
}

function resolveWritePath(path: string, cwd: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? path : resolve(cwd, path);
}

async function readPreviousWriteContent(path: string, cwd: string): Promise<string | undefined> {
  try {
    return await readFile(resolveWritePath(path, cwd), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    return undefined;
  }
}

function withWriteDiff(
  definition: ToolDefinition<any, any, any>,
  cwd: string,
): ToolDefinition<any, any, any> {
  const execute = definition.execute;
  const executeWithDiff: typeof execute = async (toolCallId, params, signal, onUpdate, context) => {
    const path = str((params as Record<string, unknown>).path);
    const content = str((params as Record<string, unknown>).content);
    const previousContent = path ? await readPreviousWriteContent(path, cwd) : undefined;
    const result = await execute(toolCallId, params, signal, onUpdate, context);
    if (previousContent === undefined) return result;

    const diff = generateDiffString(previousContent, content).diff;
    const previousDetails =
      result.details && typeof result.details === "object"
        ? (result.details as Record<string, unknown>)
        : {};
    return { ...result, details: { ...previousDetails, diff } };
  };

  return { ...definition, execute: executeWithDiff };
}

function renderShellExecution(component: BashComponentState, width: number, theme: Theme): string[] {
  if (width <= 0) return [];

  const status = component.status;
  if (!status) throw new Error("Unsupported BashExecutionComponent state");
  const isPartial = status === "running";
  const isError = status === "error";
  const title = renderTitle(
    ROWS.bash!,
    { command: component.getCommand() },
    { isPartial, isError, lastComponent: undefined },
    theme,
  );

  let content = title;
  if (!isPartial) {
    let output = component.getOutput().replace(ANSI_PATTERN, "").trim();
    if (!output && status === "error") output = `(exit ${component.exitCode ?? "?"})`;
    if (!output && status === "cancelled") output = "(cancelled)";
    content += `\n${renderOutputText(output, component.expanded === true, theme, SHELL_PREVIEW_LINES)}`;
  }

  // BashExecutionComponent normally starts with a spacer. Preserve that rhythm
  // while replacing its bordered body with the same flat rows as tool calls.
  return ["", ...new Text(content, 0, 0).render(width)];
}

/**
 * User `!` commands are rendered by Pi's separate BashExecutionComponent, so
 * tool renderers cannot affect them. The component is exported by Pi, but its
 * shell is not otherwise configurable; replace only render() and retain the
 * original as a compatibility fallback when its shape changes.
 */
export function installShellRenderer(theme: Theme): void {
  try {
    const prototype = BashExecutionComponent.prototype as unknown as Record<PropertyKey, unknown>;
    const currentRender = prototype.render;
    if (typeof currentRender !== "function") return;

    const originalRender = (prototype[SHELL_ORIGINAL_RENDER] as ComponentRender | undefined) ?? currentRender;
    prototype[SHELL_ORIGINAL_RENDER] = originalRender;
    prototype.render = function (this: BashComponentState, width: number): string[] {
      try {
        return renderShellExecution(this, width, theme);
      } catch {
        return originalRender.call(this, width);
      }
    } satisfies ComponentRender;
  } catch {
    // Keep Pi's bordered shell when this internal component changes shape.
  }
}

interface ToolExecutionState {
  toolName?: string;
}

interface ToolExecutionOriginals {
  getCallRenderer: (this: ToolExecutionState) => unknown;
  getResultRenderer: (this: ToolExecutionState) => unknown;
  getRenderShell: (this: ToolExecutionState) => unknown;
}

function isExternalFlatTool(name: unknown): name is "fffind" | "ask_user_question" | "subagent" {
  return name === "fffind" || name === "ask_user_question" || name === "subagent";
}

/**
 * FFF, questionnaire, and subagent extensions register their own definitions.
 * Their execute functions must remain untouched, but their default render shell
 * is a bordered block and their labels expose the raw extension names. Redirect
 * only these three renderer lookups on Pi's public component class so they use
 * the same flat row as built-in tools.
 */
export function installExternalToolRenderers(): void {
  try {
    const prototype = ToolExecutionComponent.prototype as unknown as Record<PropertyKey, unknown> & ToolExecutionState;
    const currentCall = prototype.getCallRenderer;
    const currentResult = prototype.getResultRenderer;
    const currentShell = prototype.getRenderShell;
    if (
      typeof currentCall !== "function" ||
      typeof currentResult !== "function" ||
      typeof currentShell !== "function"
    ) return;

    const originals =
      (prototype[TOOL_EXECUTION_ORIGINALS] as ToolExecutionOriginals | undefined) ?? {
        getCallRenderer: currentCall as ToolExecutionOriginals["getCallRenderer"],
        getResultRenderer: currentResult as ToolExecutionOriginals["getResultRenderer"],
        getRenderShell: currentShell as ToolExecutionOriginals["getRenderShell"],
      };
    prototype[TOOL_EXECUTION_ORIGINALS] = originals;

    prototype.getCallRenderer = function (this: ToolExecutionState): unknown {
      if (!isExternalFlatTool(this.toolName)) return originals.getCallRenderer.call(this);
      return (args: unknown, theme: Theme, context: RenderContext): Text => {
        const config = ROWS[this.toolName!];
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        text.setText(renderTitle(config!, (args as Record<string, unknown>) ?? {}, context, theme));
        return text;
      };
    };
    prototype.getResultRenderer = function (this: ToolExecutionState): unknown {
      if (!isExternalFlatTool(this.toolName)) return originals.getResultRenderer.call(this);
      return (
        result: AgentToolResult<unknown>,
        options: ToolRenderResultOptions,
        theme: Theme,
        context: RenderContext,
      ): Text => {
        const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
        const content = this.toolName === "subagent"
          ? renderExploredResult(result, options, theme)
          : renderResultText(this.toolName!, result, options, theme);
        text.setText(content);
        return text;
      };
    };
    prototype.getRenderShell = function (this: ToolExecutionState): unknown {
      return isExternalFlatTool(this.toolName) ? "self" : originals.getRenderShell.call(this);
    };
  } catch {
    // Keep Pi's default component when its private method layout changes.
  }
}

function codexifyTool(name: string, cwd: string): ToolDefinition<any, any, any> | undefined {
  const factory = FACTORIES[name];
  const config = ROWS[name];
  if (!factory || !config) return undefined;

  const builtin = name === "write" ? withWriteDiff(factory(cwd), cwd) : factory(cwd);
  return {
    ...builtin,
    renderShell: "self",
    renderCall(args: unknown, theme: Theme, context: RenderContext): Text {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const state = (context.state ?? {}) as RowRenderState;
      state.callComponent = text;
      text.setText(
        renderTitle(
          config,
          (args as Record<string, unknown>) ?? {},
          context,
          theme,
          renderDiffStats(state.diffStats, theme),
        ),
      );
      return text;
    },
    renderResult(
      result: AgentToolResult<unknown>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: RenderContext,
    ): Text {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const state = (context.state ?? {}) as RowRenderState;
      const diff = getResultDiff(result);
      if ((name === "edit" || name === "write") && diff) {
        state.diffStats = diffStats(diff);
        const args = (context.args as Record<string, unknown> | undefined) ?? {};
        state.callComponent?.setText(
          renderTitle(config, args, context, theme, renderDiffStats(state.diffStats, theme)),
        );
      }
      text.setText(renderResultText(name, result, options, theme));
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
