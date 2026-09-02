import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** One language-server entry. `command` may be a list of alternatives; the first found on PATH wins. */
export interface LspServerConfig {
  id: string;
  command: string | string[];
  args?: string[];
  /** File extensions this server handles, e.g. [".ts", ".tsx"] */
  include?: string[];
  /** Walk up from the file until one of these exists; fallback: cwd */
  rootMarkers?: string[];
  diagnosticsWaitMs?: number;
  settings?: unknown;
  initializationOptions?: unknown;
  enabled?: boolean;
  /** Scan common build subdirectories (build/, cmake-build-*, ...) for compile_commands.json and pass
   *  --compile-commands-dir to the server. For clangd-style servers. */
  compileCommandsProbe?: boolean;
}

export const DEFAULT_SERVERS: LspServerConfig[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    include: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
  },
  {
    id: "python",
    command: ["pyright-langserver --stdio", "pylsp"],
    include: [".py", ".pyi"],
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
  },
  {
    id: "go",
    command: "gopls",
    include: [".go"],
    rootMarkers: ["go.mod"],
  },
  {
    id: "rust",
    command: "rust-analyzer",
    include: [".rs"],
    rootMarkers: ["Cargo.toml"],
  },
  {
    id: "cpp",
    command: ["clangd", "/usr/bin/clangd"],
    args: ["--background-index"],
    include: [".c", ".h", ".cpp", ".cc", ".cxx", ".hpp", ".hh"],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", "CMakeLists.txt", "Makefile", ".git"],
    diagnosticsWaitMs: 3000,
    compileCommandsProbe: true,
  },
];

function userConfigPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "lsp.json");
}

let cachedServers: LspServerConfig[] | undefined;

/** Built-in defaults, overridden per-id by ~/.pi/agent/lsp.json ({ "servers": [{ "id": ..., ... }] }). */
export function loadServers(): LspServerConfig[] {
  if (cachedServers) return cachedServers;

  let userEntries: LspServerConfig[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(userConfigPath(), "utf8"));
    if (Array.isArray(raw?.servers)) userEntries = raw.servers;
  } catch {
    // no config file / invalid json -> defaults only
  }

  const byId = new Map<string, LspServerConfig>();
  for (const server of DEFAULT_SERVERS) byId.set(server.id, { ...server });
  for (const entry of userEntries) {
    if (!entry?.id) continue;
    const base = byId.get(entry.id) ?? ({ id: entry.id } as LspServerConfig);
    byId.set(entry.id, { ...base, ...entry });
  }

  cachedServers = [...byId.values()].filter((s) => s.enabled !== false && s.command);
  return cachedServers;
}
