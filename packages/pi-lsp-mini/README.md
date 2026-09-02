# pi-lsp-mini

Lean LSP extension for the [pi](https://github.com/earendil-works/pi) coding agent.
Three features, minimal prompt footprint (~660 tokens measured: full JSON
schemas + descriptions + snippets of all 5 tools; zero injected system
instructions):

- **Diagnostics** — `lsp_diagnostics` on a file or a whole directory; issues are
  also appended automatically after every `write`/`edit`.
- **Call relations** — `lsp_callgraph` walks incoming/outgoing call hierarchy
  recursively (who calls this function / what it calls).
- **Batch replace / delete** — `lsp_rename` (scope-aware workspace rename) and
  `lsp_delete` (removes a function plus every standalone call-site line;
  non-standalone usages are listed for manual cleanup, dry-run by default).

Also: `lsp_references`, `/lsp` command, post-edit auto re-check after
rename/delete.

## Tools

| Tool | What it does |
| --- | --- |
| `lsp_diagnostics` | Errors/warnings for a file or directory (`severity` filter). Omit `path` to scan cwd. |
| `lsp_callgraph` | Callers/callees tree around a function (`direction`, `depth` 1-4). |
| `lsp_references` | All usages of a symbol. |
| `lsp_rename` | Workspace rename. `apply=false` for dry-run. Applies + re-checks diagnostics. |
| `lsp_delete` | Delete declaration + standalone call lines. Dry-run by default, `apply=true` executes. |

All positions are 1-based (`line`, `character`); columns are auto-snapped to the
nearest identifier, so off-by-one is tolerated.

## Language servers

Built-in (auto-enabled if the binary is on PATH):

| id | binaries | files |
| --- | --- | --- |
| typescript | `typescript-language-server --stdio` | .ts .tsx .js .jsx ... |
| python | `pyright-langserver --stdio` or `pylsp` | .py .pyi |
| go | `gopls` | .go |
| rust | `rust-analyzer` | .rs |
| cpp | `clangd` (+ `--background-index`) | .c .h .cpp .hpp ... |

**clangd extras**: project root falls back through `compile_commands.json` → `CMakeLists.txt` → `Makefile` → `.git`; if `compile_commands.json` lives in a build subdirectory (`build/`, `cmake-build-*/`, `build-*/`, `out/`, ...), it is auto-detected and passed via `--compile-commands-dir` (clangd's own detection only covers a plain `build/`). Absolute-path commands are supported (e.g. `/usr/lib/llvm-19/bin/clangd`).

Override or extend via `~/.pi/agent/lsp.json`:

```json
{
  "servers": [
    { "id": "python", "enabled": false },
    { "id": "lua", "command": "lua-language-server", "args": [], "include": [".lua"], "rootMarkers": [".luarc.json", ".git"] }
  ]
}
```

Each entry: `id`, `command` (string or list of alternatives; first on PATH wins,
inline args allowed, absolute paths supported), `args`, `include` (extensions),
`rootMarkers`, `diagnosticsWaitMs`, `settings`, `initializationOptions`,
`compileCommandsProbe` (bool, cpp default true), `enabled`.

## Install

This package lives in `~/.pi/agent/packages/pi-lsp-mini` and is referenced from
`~/.pi/agent/settings.json` → `"packages": ["./packages/pi-lsp-mini"]`.

## Notes

- Prompt budget: all 5 tools cost ~660 request tokens (schemas serialized).
  Tool texts live in `src/schemas.ts` — keep them lean when editing.

- Delete heuristics: only *standalone* statement lines (`foo(x);`, `await foo()`,
  `defer foo()`, multi-line argument lists) are removed automatically. Usages in
  assignments, arguments, or callbacks are reported as `✋ manual`.
- Rename/delete re-open changed files on the server and re-run diagnostics,
  reporting new errors introduced by the change.
