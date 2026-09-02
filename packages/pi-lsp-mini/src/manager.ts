import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { loadServers, type LspServerConfig } from "./config.ts";
import { LspClient, type Diagnostic } from "./client.ts";

const IGNORED_DIRS = new Set([".git", "node_modules", "vendor", "dist", "build", "target", ".venv", "venv", "__pycache__", ".cache", "out"]);
const MAX_DIR_FILES = 200;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

export interface Ctx {
  cwd: string;
  signal?: AbortSignal;
}

export interface MatchedServer {
  server: LspServerConfig;
  root: string;
}

export function isExecutableAvailable(bin: string): boolean {
  const first = bin.split(/\s+/)[0];
  if (path.isAbsolute(first)) {
    try {
      fsSync.accessSync(first, fsSync.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  return dirs.some((dir) => {
    try {
      fsSync.accessSync(path.join(dir, first), fsSync.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

const BUILD_DIR_PATTERN = /^(build|builddir|out|build-.+|cmake-build-.+)$/;

/** Finds compile_commands.json in a non-standard build subdirectory under root (clangd's built-in
 *  detection only covers a plain "build/" directory). Returns undefined when root already has one
 *  or nothing is found. */
export async function probeCompileCommandsDir(root: string): Promise<string | undefined> {
  if (await fs.stat(path.join(root, "compile_commands.json")).then(() => true, () => false)) return undefined;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !BUILD_DIR_PATTERN.test(entry.name)) continue;
    const candidate = path.join(root, entry.name);
    if (await fs.stat(path.join(candidate, "compile_commands.json")).then(() => true, () => false)) return candidate;
  }
  return undefined;
}

export async function findProjectRoot(file: string, markers: string[] | undefined, cwd: string): Promise<string> {
  let dir = path.dirname(file);
  const stop = path.parse(dir).root;
  while (true) {
    for (const marker of markers ?? []) {
      if (await fs.stat(path.join(dir, marker)).then(() => true, () => false)) return dir;
    }
    if (dir === stop || dir === path.dirname(dir)) break;
    dir = path.dirname(dir);
  }
  return cwd;
}

export class LspManager {
  private readonly clients = new Map<string, LspClient>();
  private readonly backoff = new Map<string, { retryAt: number; reason: string }>();
  private readonly diagnostics = new Map<string, Diagnostic[]>(); // file -> latest

  listServers(): LspServerConfig[] {
    return loadServers().filter((s) => {
      const candidates = Array.isArray(s.command) ? s.command : [s.command];
      return candidates.some((candidate) => isExecutableAvailable(candidate));
    });
  }

  async matchServer(file: string, cwd: string): Promise<MatchedServer | undefined> {
    const ext = path.extname(file).toLowerCase();
    for (const server of this.listServers()) {
      if (server.include && !server.include.includes(ext)) continue;
      const root = await findProjectRoot(file, server.rootMarkers, cwd);
      const rel = path.relative(root, file);
      if (rel.startsWith("..")) continue; // file outside this root
      return { server, root };
    }
    return undefined;
  }

  private clientKey(serverId: string, root: string): string {
    return `${serverId}\u0000${root}`;
  }

  private async getClient(match: MatchedServer, signal?: AbortSignal): Promise<LspClient> {
    const key = this.clientKey(match.server.id, match.root);
    const backoff = this.backoff.get(key);
    if (backoff && Date.now() < backoff.retryAt) {
      throw new Error(`${match.server.id}: unavailable (${backoff.reason}); retry after ${Math.ceil((backoff.retryAt - Date.now()) / 1000)}s`);
    }

    let client = this.clients.get(key);
    if (!client || client.dead) {
      const candidates = Array.isArray(match.server.command) ? match.server.command : [match.server.command];
      const chosen = candidates.find((candidate) => isExecutableAvailable(candidate)) ?? candidates[0];
      const parts = chosen.split(/\s+/);
      const extraArgs: string[] = [];
      if (match.server.compileCommandsProbe) {
        const cdbDir = await probeCompileCommandsDir(match.root);
        if (cdbDir) extraArgs.push(`--compile-commands-dir=${cdbDir}`);
      }
      client = new LspClient(match.server, match.root, { bin: parts[0], args: [...parts.slice(1), ...(match.server.args ?? []), ...extraArgs] }, (file, diags) => {
        if (diags.length === 0) this.diagnostics.delete(`${match.server.id}\u0000${file}`);
        else this.diagnostics.set(`${match.server.id}\u0000${file}`, diags);
      });
      this.clients.set(key, client);
    }

    try {
      await client.ensureStarted(signal);
      this.backoff.delete(key);
      return client;
    } catch (error) {
      const reason = (error as Error).message;
      const attempts = (this.backoff.get(key)?.retryAt ?? 0) > 0 ? 2 : 1;
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(attempts, 6));
      this.backoff.set(key, { retryAt: Date.now() + delay, reason });
      throw error;
    }
  }

  /** Opens the file on its matching server (starting one if needed). Returns undefined when no server matches. */
  async openFile(ctx: Ctx, file: string): Promise<{ client: LspClient; match: MatchedServer } | undefined> {
    const absolute = path.resolve(ctx.cwd, file);
    const match = await this.matchServer(absolute, ctx.cwd);
    if (!match) return undefined;
    const text = await fs.readFile(absolute, "utf8");
    const client = await this.getClient(match, ctx.signal);
    const languageId = languageIdFor(match.server, absolute);
    await client.openOrChange(absolute, languageId, text, ctx.signal);
    return { client, match };
  }

  latestDiagnostics(file: string): { serverId: string; diagnostics: Diagnostic[] }[] {
    const absolute = path.resolve(file);
    const out: { serverId: string; diagnostics: Diagnostic[] }[] = [];
    for (const [key, diags] of this.diagnostics) {
      const [serverId, f] = key.split("\u0000");
      if (f === absolute) out.push({ serverId, diagnostics: diags });
    }
    return out;
  }

  /** Opens every file, waits for diagnostics to settle, returns them. */
  async collectDiagnostics(ctx: Ctx, files: string[], waitMs: number): Promise<Map<string, { serverId: string; diagnostics: Diagnostic[] }[]>> {
    const opened = new Map<string, { client: LspClient; match: MatchedServer }>();
    for (const file of files) {
      try {
        const target = await this.openFile(ctx, file);
        if (target) opened.set(path.resolve(ctx.cwd, file), target);
      } catch {
        // unmatchable / unopenable files are skipped silently in batch mode
      }
    }
    await delay(waitMs, ctx.signal);
    const result = new Map<string, { serverId: string; diagnostics: Diagnostic[] }[]>();
    for (const file of opened.keys()) result.set(file, this.latestDiagnostics(file));
    return result;
  }

  async listFiles(dir: string, server: LspServerConfig, root: string): Promise<string[]> {
    const out: string[] = [];
    const queue = [dir];
    while (queue.length > 0 && out.length < MAX_DIR_FILES) {
      const current = queue.shift()!;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (out.length >= MAX_DIR_FILES) break;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) queue.push(full);
        } else if (entry.isFile() && server.include?.includes(path.extname(entry.name).toLowerCase())) {
          if (!path.relative(root, full).startsWith("..")) out.push(full);
        }
      }
    }
    return out.sort();
  }

  async shutdownAll(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((client) => client.shutdown()));
  }
}

export function languageIdFor(server: LspServerConfig, file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".ts": return "typescript";
    case ".tsx": return "typescriptreact";
    case ".js": case ".mjs": case ".cjs": return "javascript";
    case ".jsx": return "javascriptreact";
    case ".py": case ".pyi": return "python";
    case ".go": return "go";
    case ".rs": return "rust";
    case ".c": case ".h": return "c";
    case ".cpp": case ".cc": case ".cxx": case ".hpp": case ".hh": return "cpp";
    default: return ext.replace(".", "") || "plaintext";
  }
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }, { once: true });
  });
}

const SEVERITY_LABEL = ["?", "E", "W", "I", "H"];

export function formatDiagnostic(d: Diagnostic): string {
  const pos = `${d.range.start.line + 1}:${d.range.start.character + 1}`;
  const source = d.source ? ` [${d.source}]` : "";
  const message = typeof d.message === "string" ? d.message : String((d.message as { value?: string })?.value ?? "");
  return `${SEVERITY_LABEL[d.severity ?? 1]} ${pos}  ${message.split("\n")[0]}${source}`;
}

export function severityRank(name: string): number {
  switch (name) {
    case "error": return 1;
    case "warning": return 2;
    case "information": return 3;
    default: return 4;
  }
}
