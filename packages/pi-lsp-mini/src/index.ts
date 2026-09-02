import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LspManager, formatDiagnostic, severityRank, delay, findProjectRoot } from "./manager.ts";
import { DIAGNOSTICS, REFERENCES, CALLGRAPH, RENAME, DELETE } from "./schemas.ts";
import type { CallHierarchyItem, Diagnostic, DocumentSymbol, Location, Range, SymbolInformation } from "./lsp-types.ts";
import { callGraphReport, type Direction } from "./callgraph.ts";
import {
  applyLineRangeDeletes,
  applyTextEdits,
  expandOverDocLines,
  mergeLineRanges,
  normalizeWorkspaceEdit,
  planUsage,
  type LineRange,
} from "./edits.ts";

const manager = new LspManager();

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function pos(params: { line: number; character?: number }) {
  return { line: params.line - 1, character: (params.character ?? 1) - 1 };
}

/** Tolerates off-by-one columns: snaps to the nearest identifier character on the line. */
function snapPos(lines: string[], p: { line: number; character: number }): { line: number; character: number } {
  const line = lines[p.line] ?? "";
  const isWord = (c: string | undefined) => !!c && /[A-Za-z0-9_$]/.test(c);
  if (isWord(line[p.character])) return p;
  for (let c = p.character + 1; c < line.length; c++) if (isWord(line[c])) return { ...p, character: c };
  for (let c = p.character - 1; c >= 0; c--) if (isWord(line[c])) return { ...p, character: c };
  return p;
}

function fmtLoc(location: Location): string {
  return `${location.uri.replace(/^file:\/\//, "")}:${location.range.start.line + 1}`;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function contains(range: Range, line: number, character: number): boolean {
  const { start, end } = range;
  if (line < start.line || line > end.line) return false;
  if (line === start.line && character < start.character) return false;
  if (line === end.line && character > end.character) return false;
  return true;
}

/** Deepest DocumentSymbol (or SymbolInformation) covering the position; returns its full range + name. */
function findSymbolAt(
  symbols: DocumentSymbol[] | SymbolInformation[] | null,
  line: number,
  character: number,
): { name: string; range: Range; kind: number } | undefined {
  let best: { name: string; range: Range; kind: number; size: number } | undefined;
  const visit = (symbol: { name: string; range: Range; kind: number; children?: DocumentSymbol[] }): void => {
    if (contains(symbol.range, line, character)) {
      const size = (symbol.range.end.line - symbol.range.start.line) * 10000 + symbol.range.end.character - symbol.range.start.character;
      if (!best || size < best.size) best = { name: symbol.name, range: symbol.range, kind: symbol.kind, size };
    }
    for (const child of symbol.children ?? []) visit(child);
  };
  const list = symbols ?? [];
  if (list.length > 0 && "location" in list[0]) {
    for (const info of list as SymbolInformation[]) {
      if (info.location && contains(info.location.range, line, character)) visit({ ...info, range: info.location.range });
    }
  } else {
    for (const symbol of list as DocumentSymbol[]) visit(symbol);
  }
  return best ? { name: best.name, range: best.range, kind: best.kind } : undefined;
}

async function readLines(file: string): Promise<string[]> {
  return (await fs.readFile(file, "utf8")).split(/\r?\n/);
}

/** After applying edits to disk, push new content to the server and report fresh diagnostics. */
async function rescan(ctx: { cwd: string; signal?: AbortSignal }, files: string[]): Promise<string> {
  const touched: string[] = [];
  for (const file of files) {
    try {
      await manager.openFile(ctx, file);
      touched.push(path.resolve(ctx.cwd, file));
    } catch {
      // server may not match; ignore
    }
  }
  if (touched.length === 0) return "";
  await delay(1500, ctx.signal);
  const lines: string[] = [];
  for (const file of touched) {
    for (const { serverId, diagnostics } of manager.latestDiagnostics(file)) {
      const errors = diagnostics.filter((d) => (d.severity ?? 1) <= 2);
      if (errors.length > 0) lines.push(`⚠️ ${path.relative(ctx.cwd, file)} [${serverId}]`);
      lines.push(...errors.slice(0, 5).map(formatDiagnostic));
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function lspMiniExtension(pi: ExtensionAPI): void {
  pi.on("session_shutdown", async () => {
    await manager.shutdownAll();
  });

  // after write/edit: silently append LSP diagnostics for the touched file
  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    if (event.isError) return undefined;
    const inputPath = (event.input as { path?: string } | undefined)?.path;
    if (!inputPath) return undefined;

    try {
      const absolute = path.resolve(ctx.cwd, inputPath);
      const match = await manager.matchServer(absolute, ctx.cwd);
      if (!match) return undefined;
      await manager.openFile(ctx, absolute);
      await delay(match.server.diagnosticsWaitMs ?? 1200, ctx.signal);
      const entries = manager.latestDiagnostics(absolute).flatMap(({ diagnostics }) => diagnostics);
      const issues = entries.filter((d) => (d.severity ?? 1) <= 2);
      if (issues.length === 0) return undefined;
      const label = path.relative(ctx.cwd, absolute) || path.basename(absolute);
      return {
        content: [
          ...event.content,
          { type: "text" as const, text: `\n${issues.slice(0, 8).map(formatDiagnostic).join("\n")}\n(${issues.length} LSP issue${issues.length > 1 ? "s" : ""} in ${label})` },
        ],
      };
    } catch {
      return undefined;
    }
  });

  pi.registerCommand("lsp", {
    description: "List configured language servers",
    handler: async (_args: string, ctx) => {
      const servers = manager.listServers();
      const lines = servers.length === 0 ? ["no language servers found on PATH"] :
        servers.map((server) => `  ${server.id.padEnd(12)} ${Array.isArray(server.command) ? server.command.join(" | ") : server.command}  (${server.include?.join(" ")})`);
      ctx.ui.notify(`pi-lsp-mini servers:\n${lines.join("\n")}`);
    },
  });

  // --- diagnostics ---------------------------------------------------------
  pi.registerTool({
    name: "lsp_diagnostics",
    label: "LSP Diagnostics",
    description: DIAGNOSTICS.description,
    promptSnippet: DIAGNOSTICS.promptSnippet,
    parameters: DIAGNOSTICS.parameters,
    async execute(_id, params, signal, _u, ctx) {
      const target = path.resolve(ctx.cwd, params.path ?? ".");
      const min = severityRank(params.severity ?? "warning");
      const stat = await fs.stat(target).catch(() => undefined);
      if (!stat) return textResult(`not found: ${target}`);

      const render = (file: string, serverId: string, diags: Diagnostic[]): string[] => {
        const kept = diags.filter((d) => (d.severity ?? 1) <= min);
        return kept.length === 0 ? [] : [`\n${path.relative(ctx.cwd, file)} [${serverId}]`, ...kept.slice(0, 12).map(formatDiagnostic)];
      };
      if (stat.isFile()) {
        const match = await manager.matchServer(target, ctx.cwd);
        if (!match) return textResult(`no language server matches ${target}`);
        await manager.openFile(ctx, target);
        await delay(match.server.diagnosticsWaitMs ?? 1500, signal);
        const sections: string[] = [];
        for (const { serverId, diagnostics } of manager.latestDiagnostics(target)) sections.push(...render(target, serverId, diagnostics));
        return textResult(sections.length === 0 ? `✅ no LSP issues (>= ${params.severity ?? "warning"}) in ${path.basename(target)}` : sections.join("\n"));
      }

      // directory scan
      const sections: string[] = [];
      let scanned = 0;
      for (const server of manager.listServers()) {
        const root = await findProjectRoot(target, server.rootMarkers, ctx.cwd);
        const files = await manager.listFiles(target, server, root);
        if (files.length === 0) continue;
        scanned += files.length;
        const result = await manager.collectDiagnostics({ cwd: ctx.cwd, signal }, files, server.diagnosticsWaitMs ?? 3000);
        for (const [file, entries] of result) {
          for (const { serverId, diagnostics } of entries) sections.push(...render(file, serverId, diagnostics));
        }
      }
      if (scanned === 0) return textResult(`no supported source files under ${path.relative(ctx.cwd, target) || target}`);
      const count = sections.filter((line) => /^[EWHI] /.test(line)).length;
      if (sections.length === 0) return textResult(`✅ no LSP issues (>= ${params.severity ?? "warning"}) in ${scanned} file(s)`);
      return textResult(`LSP diagnostics (${count} issue(s) in ${scanned} file(s)):\n${sections.join("\n")}`);
    },
  });

  // --- references ----------------------------------------------------------
  pi.registerTool({
    name: "lsp_references",
    label: "LSP References",
    description: REFERENCES.description,
    promptSnippet: REFERENCES.promptSnippet,
    parameters: REFERENCES.parameters,
    async execute(_id, params, signal, _u, ctx) {
      const target = await manager.openFile({ cwd: ctx.cwd, signal }, params.path);
      if (!target) return textResult(`no language server matches ${params.path}`);
      const file = path.resolve(ctx.cwd, params.path);
      const p = snapPos((await fs.readFile(file, "utf8")).split(/\r?\n/), pos(params));
      const refs = await target.client.references(file, p.line, p.character, false);
      if (!refs || refs.length === 0) return textResult("no references found");
      const byFile = new Map<string, Location[]>();
      for (const ref of refs) {
        const file = fmtLoc(ref).replace(/:\d+$/, "");
        byFile.set(file, [...(byFile.get(file) ?? []), ref]);
      }
      const lines = [`symbol used in ${refs.length} place(s):`];
      for (const [file, locations] of byFile) {
        lines.push(`\n${path.relative(ctx.cwd, file)}`);
        for (const location of locations) {
          const ln = location.range.start.line;
          lines.push(`  ${ln + 1}: ${(await readLines(file))[ln]?.trim().slice(0, 120) ?? ""}`);
        }
      }
      return textResult(lines.join("\n"));
    },
  });

  // --- call graph ----------------------------------------------------------
  pi.registerTool({
    name: "lsp_callgraph",
    label: "LSP Call Graph",
    description: CALLGRAPH.description,
    promptSnippet: CALLGRAPH.promptSnippet,
    parameters: CALLGRAPH.parameters,
    async execute(_id, params, signal, _u, ctx) {
      const target = await manager.openFile({ cwd: ctx.cwd, signal }, params.path);
      if (!target) return textResult(`no language server matches ${params.path}`);
      if (!target.client.supportsCallHierarchy) {
        return textResult(`${target.match.server.id} does not support call hierarchy; use lsp_references instead`);
      }
      const p = snapPos((await fs.readFile(path.resolve(ctx.cwd, params.path), "utf8")).split(/\r?\n/), pos(params));
      const items = await target.client.prepareCallHierarchy(path.resolve(ctx.cwd, params.path), p.line, p.character);
      const root: CallHierarchyItem | undefined = items?.[0];
      if (!root) return textResult("no callable symbol at that position");
      const report = await callGraphReport(target.client, root, (params.direction ?? "both") as Direction, Math.min(4, Math.max(1, params.depth ?? 2)));
      return textResult(report);
    },
  });

  // --- rename (batch replace) ----------------------------------------------
  pi.registerTool({
    name: "lsp_rename",
    label: "LSP Rename",
    description: RENAME.description,
    promptSnippet: RENAME.promptSnippet,
    executionMode: "sequential",
    parameters: RENAME.parameters,
    async execute(_id, params, signal, _u, ctx) {
      const file = path.resolve(ctx.cwd, params.path);
      const target = await manager.openFile({ cwd: ctx.cwd, signal }, params.path);
      if (!target) return textResult(`no language server matches ${params.path}`);
      if (!target.client.supportsRename) return textResult(`${target.match.server.id} does not support rename`);
      const p = snapPos((await fs.readFile(file, "utf8")).split(/\r?\n/), pos(params));
      const ws = await target.client.rename(file, p.line, p.character, params.newName);
      const { fileEdits, skipped } = normalizeWorkspaceEdit(ws);
      if (fileEdits.length === 0) {
        return textResult(`cannot rename at ${path.relative(ctx.cwd, file)}:${params.line} (no edits returned${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""})`);
      }
      const root = target.match.root;
      const outside = fileEdits.filter((fe) => {
        const rel = path.relative(root, fe.file);
        return rel.startsWith("..") && path.relative(ctx.cwd, fe.file).startsWith("..");
      });
      const usable = fileEdits.filter((fe) => !outside.includes(fe));

      const total = usable.reduce((sum, fe) => sum + fe.edits.length, 0);
      const plan = usable.map((fe) => `  ${path.relative(ctx.cwd, fe.file)}: ${fe.edits.length} edit(s)`).join("\n");
      const notes: string[] = [];
      if (outside.length > 0) notes.push(`skipped (outside project): ${outside.map((fe) => path.relative(ctx.cwd, fe.file)).join(", ")}`);
      if (skipped.length > 0) notes.push(`unsupported ops skipped: ${skipped.join(", ")}`);

      if (params.apply === false) {
        return textResult(`dry-run: rename to '${params.newName}' would apply ${total} edit(s) in ${usable.length} file(s)\n${plan}${notes.length ? `\n${notes.join("\n")}` : ""}`);
      }

      for (const fe of usable) {
        const text = await fs.readFile(fe.file, "utf8");
        await fs.writeFile(fe.file, applyTextEdits(text, fe.edits));
      }
      const rescan1 = await rescan({ cwd: ctx.cwd, signal }, usable.map((fe) => fe.file));
      return textResult(
        [
          `✓ renamed to '${params.newName}': ${total} edit(s) in ${usable.length} file(s)`,
          plan,
          ...notes,
          rescan1 ? `\npost-rename check:\n${rescan1}` : "",
        ].filter(Boolean).join("\n"),
      );
    },
  });

  // --- delete symbol (batch delete) ----------------------------------------
  pi.registerTool({
    name: "lsp_delete",
    label: "LSP Delete Symbol",
    description: DELETE.description,
    promptSnippet: DELETE.promptSnippet,
    executionMode: "sequential",
    parameters: DELETE.parameters,
    async execute(_id, params, signal, _u, ctx) {
      const file = path.resolve(ctx.cwd, params.path);
      const target = await manager.openFile({ cwd: ctx.cwd, signal }, params.path);
      if (!target) return textResult(`no language server matches ${params.path}`);

      const p = snapPos((await fs.readFile(file, "utf8")).split(/\r?\n/), pos(params));
      const symbols = await target.client.documentSymbol(file);
      const decl = findSymbolAt(symbols, p.line, p.character);
      if (!decl) return textResult(`no symbol found at ${path.relative(ctx.cwd, file)}:${params.line} — place the position on the declaration name`);

      const declLines = await readLines(file);
      const declRange = expandOverDocLines(declLines, {
        start: decl.range.start.line,
        end: decl.range.end.line,
      });

      const refs = (await target.client.references(file, p.line, p.character, false)) ?? [];
      const usages = refs.filter((ref) => !(fmtLoc(ref) === `${file}:${decl.range.start.line + 1}`));

      const plans = [];
      const rangesByFile = new Map<string, LineRange[]>();
      const addRange = (f: string, range: LineRange) => rangesByFile.set(f, [...(rangesByFile.get(f) ?? []), range]);
      addRange(file, declRange);
      const kindName = decl.kind === 12 ? "function" : decl.kind === 6 ? "variable" : decl.kind === 13 ? "method" : "symbol";
      plans.push(`declaration: ${path.relative(ctx.cwd, file)}:${declRange.start + 1}-${declRange.end + 1}  delete ${kindName} '${decl.name}' (${declRange.end - declRange.start + 1} line(s))`);

      const manual: string[] = [];
      const cacheLines = new Map<string, string[]>();
      const linesOf = async (f: string): Promise<string[]> => {
        if (!cacheLines.has(f)) cacheLines.set(f, await readLines(f));
        return cacheLines.get(f)!;
      };

      for (const ref of usages) {
        const f = fmtLoc(ref).replace(/:\d+$/, "");
        if (f === file && ref.range.start.line >= declRange.start && ref.range.start.line <= declRange.end) continue;
        const lines = await linesOf(f);
        const plan = planUsage(lines, ref);
        if (plan.kind === "delete") {
          addRange(f, plan.lines);
          plans.push(`usage: ${path.relative(ctx.cwd, f)}:${plan.lines.start + 1}${plan.lines.end > plan.lines.start ? `-${plan.lines.end + 1}` : ""}  delete line(s)`);
        } else {
          manual.push(`${path.relative(ctx.cwd, f)}:${ref.range.start.line + 1}  ${plan.snippet}`);
        }
      }

      const header = `${params.apply ? "executing" : "dry-run"}: delete '${decl.name}' (${usages.length} usage(s))`;
      const body = [
        ...plans.sort(),
        ...(manual.length > 0 ? ["", "needs MANUAL cleanup (not standalone statements):", ...manual.sort().map((m) => `  ✋ ${m}`)] : []),
      ].join("\n");

      if (!params.apply) {
        return textResult(`${header}\n${body}\n\nre-run with apply=true to execute.`);
      }

      const changed: string[] = [];
      for (const [f, ranges] of rangesByFile) {
        const lines = await linesOf(f);
        const merged = mergeLineRanges(lines, ranges);
        const out = applyLineRangeDeletes(lines, merged);
        await fs.writeFile(f, out.join(dominantEolOf(await fs.readFile(f, "utf8"))));
        changed.push(f);
      }
      const rescan2 = await rescan({ cwd: ctx.cwd, signal }, changed);
      return textResult(
        [
          `✓ deleted '${decl.name}': ${changed.length} file(s) changed`,
          body,
          rescan2 ? `\npost-delete check:\n${rescan2}` : "",
        ].filter(Boolean).join("\n"),
      );
    },
  });
}

function dominantEolOf(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}
