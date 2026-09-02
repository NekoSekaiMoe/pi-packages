/**
 * pi-dsh-minimal — DSH anchored-standard 流程的 pi 复刻（模型门控 + 自动热身 + 晋升）
 *
 * 配方来源：deepseek-harness apps/cli/config/agent-presets/minimal/agent.cordis.yml
 * 与 xiaobright/dsh-anchored-standard 的「首轮锚定」方法论：
 *
 *   warmup + 首条真实消息（bootstrap 阶段）        晋升后（resident 阶段）
 *   ┌─────────────────────────────────────┐      ┌──────────────────────────────┐
 *   │ system prompt 只有一句 persona        │  →   │ pi 完整 system prompt         │
 *   │ （complete: true，禁止任何追加）       │      │ （默认提示词 + 插件提示词 +      │
 *   │ tools: bash + str_replace_editor     │      │  skill + AGENTS 上下文）       │
 *   └─────────────────────────────────────┘      │ tools: pi 默认全集             │
 *                                                └──────────────────────────────┘
 *
 * 触发规则（session_start 时按当前模型判定，未命中则本会话完全不生效）：
 *   - provider = deepseek：所有模型触发
 *   - provider = opencode：id 含 deepseek-v4-flash / deepseek-v4-pro 即触发
 *     （无论是否带日期后缀）
 *   - 其他 provider：仅当 id 含 deepseek-v4-flash-0731 或
 *     deepseek-v4-pro-0813（id + 日期后缀）才触发
 *
 * 流程：
 *   1. 命中 → 注册 DSH 同款 bash（覆盖内置）与 str_replace_editor，
 *      setActiveTools 锁为 minimal 对；
 *   2. 自动以用户消息身份发送热身轮「你好，请问你可以做什么？这个仓库是干什么用的？」
 *      （可见消息，防止首轮被当成测活 ping）；
 *   3. 热身轮与首条真实用户消息都在 minimal 环境处理；
 *   4. 首条真实消息所在的 agent run 结束（agent_end）→ 晋升：
 *      恢复 pi 默认工具集，system prompt 恢复 pi 正常组装。
 *
 * 保真手段：before_agent_start 返回整句 persona；并在 before_provider_request
 * 把 payload 的 system/instructions/messages[0] 强制改写为 persona——即使其他
 * 扩展在链上又追加了内容，线上 payload 仍与 DSH minimal 字节一致。
 *
 * 环境变量：
 *   PI_DSH_MINIMAL=off            完全禁用本扩展
 *   PI_DSH_MINIMAL_PROMPT=append  persona 只替换 pi 默认基础提示词，追加部分
 *                                 保留；默认 strict：字节级等于 persona
 *                                 （payload 级强制）
 *   PI_DSH_MINIMAL_APPEND         注入滴定级别（覆盖 PROMPT 开关）：
 *                                 none    = 仅 persona（同 strict）
 *                                 context = persona + AGENTS.md 等上下文文件
 *                                 full    = persona + 全部追加（同 append）
 *   PI_DSH_MINIMAL_TOOLS=append   工具 = minimal 对在前 + 除 read/edit/write
 *                                 外的默认工具；默认 strict：只有 minimal 对
 *   （默认值按本机消融结果选择：严格 prompt + 严格工具是唯一能稳定复现
 *    "We need" 的组合；朋友 index.md 的宽松配方在本机未复现，见 README）
 *
 * 命令：
 *   /dsh-minimal-status  门控结果 / 当前阶段 / 活动工具
 *
 * 注意：bash 覆盖在命中会话内全程有效（晋升后仍是持久版）；会话中途切换
 * 模型不会重新判定门控。
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import type { Socket } from "node:net";
import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from "node:fs";

/* ------------------------------------------------------------------ */
/* DSH 原文常量（字节级摘录）                                             */
/* ------------------------------------------------------------------ */

/** minimal preset persona（agent.cordis.yml, complete: true）。 */
const DSH_PERSONA = "You are a helpful software engineer assistant.";

/** 热身轮用户消息（防止首轮被当成测活 ping）。 */
const WARMUP_TEXT = "你好，请问你可以做什么？这个仓库是干什么用的？";

/** persistent-bash description（preset yml 覆盖值，逐字）。 */
const DSH_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`;

/** str_replace_editor 默认 description（上游 DEFAULT_DESCRIPTION，逐字）。 */
const DSH_EDITOR_DESCRIPTION = `
Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\`
`.trim();

const TRUNCATED_MESSAGE =
  "<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";

const MAX_OUTPUT_CHARS = 16_000;
const BASH_TIMEOUT_MS = 300_000;
const MINIMAL_TOOLS = ["bash", "str_replace_editor"];
/** append 模式下要禁用的 pi 内置文件工具（朋友要点 #2）。 */
const DISABLED_BUILTIN_TOOLS = new Set(["read", "edit", "write"]);

/**
 * DSH 的强制归因请求头（packages/llm/llm/src/attribution.ts）：每个 provider
 * 请求都带此 User-Agent，不可关闭。门控命中后全程发送，保持与 DSH 一致。
 * PI_DSH_MINIMAL_UA=off 可关闭；其他值则整体替换 UA 字符串。
 */
const DSH_USER_AGENT =
  "deepseek-harness/0.1.0-rc.7 (+https://github.com/deepseek-ai/deepseek-harness)";


/**
 * 可选的 persona 追加行（PI_DSH_MINIMAL_PERSONA_EXTRA）。
 * 严格复刻 DSH 时不要设；追求稳定 we-轨迹 + 全量注入的实用模式时，
 * 可设为如：Always think in "we" terms. Start your reasoning with "We need to".
 */
const PERSONA = process.env.PI_DSH_MINIMAL_PERSONA_EXTRA
  ? `${DSH_PERSONA}\n${process.env.PI_DSH_MINIMAL_PERSONA_EXTRA}`
  : DSH_PERSONA;

function maybeTruncate(content: string): string {
  return content.length <= MAX_OUTPUT_CHARS
    ? content
    : content.slice(0, MAX_OUTPUT_CHARS) + TRUNCATED_MESSAGE;
}

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/* pi 的 exports 不暴露子路径，从包入口 URL 推导 system-prompt.js 动态导入。
   优先 import.meta.resolve（ESM import 条件），降级 createRequire。 */
type BuildSystemPromptFn = (options: Record<string, unknown>) => string;
let buildSystemPromptCache: BuildSystemPromptFn | null | undefined;
async function loadBuildSystemPrompt(): Promise<BuildSystemPromptFn | null> {
  if (buildSystemPromptCache !== undefined) return buildSystemPromptCache;
  const candidates: string[] = [];
  try {
    const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
    candidates.push(new URL("./core/system-prompt.js", entry).href);
  } catch {
    // ignore
  }
  try {
    const req = createRequire(import.meta.url);
    const entry = req.resolve("@earendil-works/pi-coding-agent");
    candidates.push(
      pathToFileURL(join(dirname(entry), "core", "system-prompt.js")).href
    );
  } catch {
    // ignore
  }
  for (const url of candidates) {
    try {
      const mod = (await import(url)) as { buildSystemPrompt?: BuildSystemPromptFn };
      if (typeof mod.buildSystemPrompt === "function") {
        buildSystemPromptCache = mod.buildSystemPrompt;
        return buildSystemPromptCache;
      }
    } catch {
      // try next
    }
  }
  buildSystemPromptCache = null;
  return null;
}

/* ------------------------------------------------------------------ */
/* 模型门控                                                             */
/* ------------------------------------------------------------------ */

function shouldActivate(provider: string | undefined, modelId: string | undefined): boolean {
  if (!provider || !modelId) return false;
  if (process.env.PI_DSH_MINIMAL_FORCE === "1") return true; // 机制验证用，绕过门控
  const id = modelId.toLowerCase();
  const isV4Pair = id.includes("deepseek-v4-flash") || id.includes("deepseek-v4-pro");
  if (provider === "deepseek") return id.includes("deepseek");
  if (provider === "opencode") return isV4Pair; // 无论是否带日期后缀
  // 其他平台：必须 id + 日期后缀（如 deepseek-v4-flash-0731 / deepseek-v4-pro-0813）
  return /deepseek-v4-(flash|pro)-\d{4}/.test(id);
}

/* ------------------------------------------------------------------ */
/* persistent bash（单 bash 进程，状态跨调用保持）                        */
/* ------------------------------------------------------------------ */

class PersistentBash {
  private proc: ChildProcess | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private cwd: string) {}

  private ensure(): ChildProcess {
    if (this.proc && this.proc.exitCode === null) return this.proc;
    this.proc = spawn("bash", [], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    this.proc.stderr?.resume();
    // 不让子进程及其管道拖住 pi 的退出
    this.proc.unref();
    (this.proc.stdin as Socket | null)?.unref();
    (this.proc.stdout as Socket | null)?.unref();
    (this.proc.stderr as Socket | null)?.unref();
    return this.proc;
  }

  dispose(): void {
    if (this.proc && this.proc.exitCode === null) {
      try {
        this.proc.stdin?.end();
        this.proc.kill();
      } catch {
        // ignore
      }
    }
    this.proc = null;
  }

  /** 串行执行，模拟 DSH 的 per-agent 队列。 */
  run(command: string): Promise<string> {
    const run = this.queue.then(() => this.execOnce(command));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private execOnce(command: string): Promise<string> {
    return new Promise((resolve) => {
      const proc = this.ensure();
      const token = `__DSH_DONE_${Math.random().toString(36).slice(2)}__`;
      let buf = "";
      let done = false;

      const finish = (out: string, timedOut: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        proc.stdout?.off("data", onData);
        let text = out;
        if (timedOut) {
          proc.kill("SIGINT");
          text =
            `Your command timed out after ${Math.round(BASH_TIMEOUT_MS / 1000)} seconds or experienced an OOM error. Below is partial output:\n` +
            text;
        }
        resolve(maybeTruncate(text));
      };

      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        const idx = buf.indexOf(token);
        if (idx >= 0) {
          let out = buf.slice(0, idx);
          if (out.endsWith("\n")) out = out.slice(0, -1);
          finish(out, false);
        }
      };

      proc.stdout?.on("data", onData);
      const timer = setTimeout(() => finish(buf, true), BASH_TIMEOUT_MS);
      proc.on("exit", () => {
        finish(buf + "\n[persistent bash shell exited]", false);
        this.proc = null;
      });
      proc.stdin?.write(`${command} 2>&1\nprintf '\\n${token}%s\\n' "$?"\n`);
    });
  }
}

/* ------------------------------------------------------------------ */
/* str_replace_editor（行为对齐上游源码）                                 */
/* ------------------------------------------------------------------ */

function resolvePath(p: string): string {
  if (p.trim().length === 0) throw new Error("path must be a non-empty string");
  if (!isAbsolute(p)) {
    throw new Error(
      `The path ${p} is not an absolute path, it should start with \`/\`. Maybe you meant /${p}?`
    );
  }
  return p;
}

function statExisting(path: string, command: "view" | "str_replace" | "insert"): { isDir: boolean } {
  if (!existsSync(path)) {
    throw new Error(`The path ${path} does not exist. Please provide a valid path.`);
  }
  const isDir = statSync(path).isDirectory();
  if (isDir && command !== "view") {
    throw new Error(
      `The path ${path} is a directory and only the \`view\` command can be used on directories`
    );
  }
  return { isDir };
}

function formatFileView(path: string, content: string, viewRange?: number[]): string {
  const allLines = content.split("\n");
  let lines = allLines;
  let initialLine = 1;
  let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`;
  if (viewRange !== undefined) {
    const [init, fin] = viewRange;
    if (
      viewRange.length !== 2 ||
      init === undefined ||
      fin === undefined ||
      !viewRange.every(Number.isInteger)
    ) {
      throw new Error("Invalid `view_range`. It should be a list of two integers.");
    }
    initialLine = init;
    if (initialLine < 1 || initialLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`
      );
    }
    if (fin > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${fin}\` should be smaller than the number of lines in the file: \`${allLines.length}\``
      );
    }
    if (fin !== -1 && fin < initialLine) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${fin}\` should be larger or equal than its first \`${initialLine}\``
      );
    }
    lines = fin === -1 ? allLines.slice(initialLine - 1) : allLines.slice(initialLine - 1, fin);
    prompt += ` with view_range=[${initialLine}, ${fin}]`;
  }
  const numbered = lines
    .map((line, i) => `${String(initialLine + i).padStart(6, " ")}  ${line}`)
    .join("\n");
  return maybeTruncate(`${prompt}:\n${numbered}\n`);
}

function listDirectory(root: string): string {
  const rows: string[] = [`d\t${root}`];
  const visit = (dir: string, depth: number) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || name === "node_modules" || name === "__pycache__") continue;
      const full = join(dir, name);
      const isDir = statSync(full).isDirectory();
      rows.push(`${isDir ? "d" : "f"}\t${full}`);
      if (isDir && depth < 2) visit(full, depth + 1);
    }
  };
  visit(root, 1);
  rows.sort((a, b) => {
    const pa = a.slice(a.indexOf("\t") + 1);
    const pb = b.slice(b.indexOf("\t") + 1);
    return pa < pb ? -1 : pa > pb ? 1 : 0;
  });
  const listing = maybeTruncate(rows.join("\n") + "\n");
  return `Here're the files and directories up to 2 levels deep in ${root}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`;
}

function matchOffsets(content: string, search: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (;;) {
    const m = content.indexOf(search, offset);
    if (m < 0) return offsets;
    offsets.push(m);
    offset = m + search.length;
  }
}

function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
  let line = 1;
  let cursor = 0;
  return offsets.map((offset) => {
    while (cursor < offset) {
      if (content[cursor] === "\n") line += 1;
      cursor += 1;
    }
    return line;
  });
}

/* ------------------------------------------------------------------ */
/* 扩展入口                                                             */
/* ------------------------------------------------------------------ */

type Phase = "inactive" | "bootstrap" | "resident";
type Toggle = "strict" | "append";

export default function (pi: ExtensionAPI) {
  if (process.env.PI_DSH_MINIMAL === "off") return;
  const promptMode: Toggle = process.env.PI_DSH_MINIMAL_PROMPT === "append" ? "append" : "strict";
  const toolsMode: Toggle = process.env.PI_DSH_MINIMAL_TOOLS === "append" ? "append" : "strict";
  // 注入滴定级别：none（仅 persona）/ context（+AGENTS 等上下文文件）/ full（全部追加）
  const rawAppend = process.env.PI_DSH_MINIMAL_APPEND;
  const appendLevel: "none" | "context" | "full" =
    rawAppend === "context" || rawAppend === "full"
      ? rawAppend
      : rawAppend === "none"
        ? "none"
        : promptMode === "append"
          ? "full"
          : "none";

  let phase: Phase = "inactive";
  let shell: PersistentBash | null = null;
  let defaultTools: string[] = [];
  let realMessageSeen = false;

  /* ---- payload 级 persona 强制（防其他扩展在链上追加） ---- */
  const enforcePersona = (payload: unknown) => {
    if (typeof payload !== "object" || payload === null) return;
    const body = payload as Record<string, unknown>;
    if (typeof body.system === "string") body.system = PERSONA;
    if (typeof body.instructions === "string") body.instructions = PERSONA;
    const msgs = body.messages;
    if (Array.isArray(msgs)) {
      const first = msgs[0] as Record<string, unknown> | undefined;
      if (first && first.role === "system") first.content = PERSONA;
    }
  };

  /* ---- 门控 + bootstrap 武装 ---- */
  pi.on("session_start", (_event, ctx) => {
    phase = "inactive";
    realMessageSeen = false;
    const provider = ctx.model?.provider;
    const id = ctx.model?.id;
    if (!shouldActivate(provider, id)) return;

    phase = "bootstrap";
    defaultTools = pi.getActiveTools();

    /* 命中后才注册 DSH 工具（bash 覆盖内置）并锁定 minimal 对 */
    pi.registerTool(
      defineTool({
        name: "bash",
        label: "bash",
        description: DSH_BASH_DESCRIPTION,
        parameters: Type.Object({
          command: Type.String({
            description: "The bash command to run. Relative path is preferred in the command.",
          }),
        }),
        async execute(_id, params, _signal, _onUpdate, tctx) {
          if (!shell) shell = new PersistentBash(tctx.cwd ?? process.cwd());
          const out = await shell.run(params.command);
          return textResult(out);
        },
      })
    );

    pi.registerTool(
      defineTool({
        name: "str_replace_editor",
        label: "str_replace_editor",
        description: DSH_EDITOR_DESCRIPTION,
        parameters: Type.Object({
          command: Type.Union(
            [
              Type.Literal("view"),
              Type.Literal("create"),
              Type.Literal("str_replace"),
              Type.Literal("insert"),
            ],
            {
              description:
                "The commands to run. Allowed options are: `view`, `create`, `str_replace`, `insert`.",
            }
          ),
          path: Type.String({
            description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.",
          }),
          file_text: Type.Optional(
            Type.String({
              description:
                "Required parameter of `create` command, with the content of the file to be created.",
            })
          ),
          insert_line: Type.Optional(
            Type.Integer({
              description:
                "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
            })
          ),
          new_str: Type.Optional(
            Type.String({
              description:
                "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
            })
          ),
          old_str: Type.Optional(
            Type.String({
              description:
                "Required parameter of `str_replace` command containing the string in `path` to replace.",
            })
          ),
          view_range: Type.Optional(
            Type.Array(Type.Integer(), {
              description:
                "Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
            })
          ),
        }),
        async execute(_id, params) {
          const path = resolvePath(params.path);
          switch (params.command) {
            case "view": {
              const { isDir } = statExisting(path, "view");
              if (isDir) {
                if (params.view_range !== undefined) {
                  throw new Error(
                    "The `view_range` parameter is not allowed when `path` points to a directory."
                  );
                }
                return textResult(listDirectory(path));
              }
              return textResult(
                formatFileView(path, readFileSync(path, "utf8"), params.view_range)
              );
            }
            case "create": {
              if (params.file_text === undefined) {
                throw new Error("Parameter `file_text` is required for command: create");
              }
              if (existsSync(path)) {
                throw new Error(
                  `File already exists at: ${path}. Cannot overwrite files using command \`create\`.`
                );
              }
              writeFileSync(path, params.file_text, "utf8");
              return textResult(`New file created successfully at: ${path}`);
            }
            case "str_replace": {
              if (params.old_str === undefined) {
                throw new Error("Parameter `old_str` is required for command: str_replace");
              }
              if (params.old_str.length === 0) {
                throw new Error("Parameter `old_str` is empty for command: str_replace");
              }
              statExisting(path, "str_replace");
              const before = readFileSync(path, "utf8");
              const offsets = matchOffsets(before, params.old_str);
              const offset = offsets[0];
              if (offset === undefined) {
                throw new Error(
                  `No replacement was performed, old_str \`${params.old_str}\` did not appear verbatim in ${path}.`
                );
              }
              if (offsets.length > 1) {
                const lines = lineNumbersAt(before, offsets);
                throw new Error(
                  `No replacement was performed. Multiple occurrences of old_str \`${params.old_str}\` in lines [${lines.join(", ")}]. Please ensure it is unique`
                );
              }
              const newValue = params.new_str ?? "";
              writeFileSync(
                path,
                before.slice(0, offset) + newValue + before.slice(offset + params.old_str.length),
                "utf8"
              );
              return textResult(`The file ${path} has been edited successfully.`);
            }
            case "insert": {
              if (params.insert_line === undefined) {
                throw new Error("Parameter `insert_line` is required for command: insert");
              }
              if (params.new_str === undefined) {
                throw new Error("Parameter `new_str` is required for command: insert");
              }
              statExisting(path, "insert");
              const before = readFileSync(path, "utf8");
              const lines = before.split("\n");
              if (
                !Number.isInteger(params.insert_line) ||
                params.insert_line < 0 ||
                params.insert_line > lines.length
              ) {
                throw new Error(
                  `Invalid \`insert_line\` parameter: ${params.insert_line}. It should be within the range of lines of the file: [0, ${lines.length}]`
                );
              }
              const after = [
                ...lines.slice(0, params.insert_line),
                ...params.new_str.split("\n"),
                ...lines.slice(params.insert_line),
              ].join("\n");
              writeFileSync(path, after, "utf8");
              return textResult(`The file ${path} has been edited successfully.`);
            }
          }
        },
      })
    );

    pi.setActiveTools(
      toolsMode === "strict"
        ? MINIMAL_TOOLS
        : [
            ...MINIMAL_TOOLS,
            ...defaultTools.filter(
              (t) => !MINIMAL_TOOLS.includes(t) && !DISABLED_BUILTIN_TOOLS.has(t)
            ),
          ]
    );

    if (ctx.hasUI) {
      ctx.ui.notify(`dsh-minimal: activated for ${provider}/${id} — bootstrap armed`, "info");
    }

    /* 热身轮：可见用户消息，消费请求 #1 的锚定。
       交互模式 session_start 时 agent 空闲，直接发送；
       print 模式 CLI prompt 已在处理中，无法插队——跳过热身，
       首轮真实消息直接作为 bootstrap（realMessageSeen 逻辑不变）。 */
    /* 热身轮仅在交互模式（有 UI）发送：session_start 时 agent 空闲。
       print 模式 CLI prompt 已在处理中（且 sendUserMessage 的错误由 pi
       异步报告无法捕获）——跳过热身，首轮真实消息直接作为 bootstrap。 */
    if (ctx.hasUI) {
      pi.sendUserMessage(WARMUP_TEXT);
    }
  });

  /* ---- bootstrap 阶段的 system prompt ----
     none：整句 persona + payload 级强制（其他扩展的追加也会被剥掉）；
     context：persona + 上下文文件（AGENTS.md 等），不含 guidelines/skills；
     full：persona 替换 pi 默认基础提示词，追加部分全部保留——
     用 pi 自己的 buildSystemPrompt 重组，customPrompt=persona。 */
  pi.on("before_agent_start", async (event) => {
    if (phase !== "bootstrap") return;
    if (appendLevel === "none") return { systemPrompt: PERSONA };
    const opts = (event as unknown as { systemPromptOptions?: Record<string, unknown> })
      .systemPromptOptions;
    const build = await loadBuildSystemPrompt();
    if (!opts || !build) return { systemPrompt: PERSONA };
    try {
      const merged =
        appendLevel === "context"
          ? { cwd: opts.cwd, contextFiles: opts.contextFiles, customPrompt: PERSONA }
          : { ...opts, customPrompt: PERSONA };
      return { systemPrompt: build(merged) };
    } catch {
      return { systemPrompt: PERSONA };
    }
  });

  pi.on("before_provider_request", (event) => {
    if (phase === "bootstrap" && appendLevel === "none") enforcePersona(event.payload);
    return event.payload;
  });

  /* ---- DSH 归因 User-Agent：门控命中后全程发送 ---- */
  pi.on("before_provider_headers", (event) => {
    if (phase === "inactive") return;
    const uaEnv = process.env.PI_DSH_MINIMAL_UA;
    if (uaEnv === "off") return;
    (event as { headers: Record<string, string | null> }).headers["user-agent"] =
      uaEnv || DSH_USER_AGENT;
    if (process.env.PI_DSH_MINIMAL_DEBUG === "1") {
      try {
        appendFileSync(
          "/tmp/dsh-ua-debug.log",
          JSON.stringify((event as { headers: unknown }).headers) + "\n"
        );
      } catch {
        // ignore
      }
    }
  });

  /* ---- 区分热身消息与真实用户消息 ---- */
  pi.on("message_end", (event) => {
    const msg = event.message as
      | { role: string; content?: string | Array<{ type: string; text?: string }> }
      | undefined;
    if (!msg || msg.role !== "user" || phase !== "bootstrap") return;
    const text =
      typeof msg.content === "string"
        ? msg.content
        : (msg.content ?? [])
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text)
            .join("");
    if (text.trim() !== WARMUP_TEXT) realMessageSeen = true;
  });

  /* ---- 首条真实消息完成后晋升 ---- */
  pi.on("agent_end", (_event, ctx) => {
    if (phase === "bootstrap" && realMessageSeen) {
      phase = "resident";
      pi.setActiveTools(defaultTools);
      if (ctx.hasUI) {
        ctx.ui.notify(
          "dsh-minimal: promoted — full pi prompt & tools restored (resident phase)",
          "info"
        );
      }
    }
  });

  pi.on("session_shutdown", () => {
    shell?.dispose();
    shell = null;
  });

  /* ---- 命令 ---- */
  pi.registerCommand("dsh-minimal-status", {
    description: "pi-dsh-minimal: gate result / phase / active tools",
    handler: async (_args, ctx) => {
      const text = [
        `phase: ${phase}  prompt=${promptMode} tools=${toolsMode}`,
        `model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "?/?"}`,
        `activeTools: [${pi.getActiveTools().join(", ")}]`,
        `defaultTools: ${defaultTools.length} captured`,
      ].join("\n");
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else console.log(text);
    },
  });
}
