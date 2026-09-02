# pi-packages

A Yarn workspaces monorepo of extensions ("packages") for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), maintained by [@NekoSekaiMoe](https://github.com/NekoSekaiMoe).

Each directory under [`packages/`](packages/) is an independent Pi package with its own npm release. Install only the extensions you need; the repository is a development workspace, not a single runtime bundle.

## Packages

| Package | Activation | Purpose |
| --- | --- | --- |
| [`@NekoSekaiMoe/pi-extra-cmd`](packages/pi-extra-cmd/) | `/exit`, `/init`, `/context` | Extra slash commands: a `/quit` alias, `AGENTS.md` generation, and a context-window usage breakdown with per-category composition. |
| [`@NekoSekaiMoe/pi-ui`](packages/pi-ui/) | Automatic on load | Reskins the interactive TUI with a gradient editor, compact usage footer, animated working shimmer, collapsed thinking rows, todo/subagent integration, and flat tool rows. |
| [`@NekoSekaiMoe/pi-fake-codex`](packages/pi-fake-codex/) | Automatic on load | Makes Responses-API traffic resemble official Codex CLI traffic, adds an `apply_patch` tool, and runs Codex-compatible project hooks. |
| [`@NekoSekaiMoe/pi-smart-flow`](packages/pi-smart-flow/) | Automatic on load | Delegation nudge, adaptive `bash_bg` shell tool, `observe` multi-target wait/status, and a compact-thinking summary mode (`/compact-thinking`). |
| [`@NekoSekaiMoe/pi-smart-flow-lite`](packages/pi-smart-flow-lite/) | Automatic on load | Slimmed `pi-smart-flow`: ~90-token nudge, `bash_bg`, compact-thinking — `observe` removed to save prompt tokens. |
| [`@NekoSekaiMoe/pi-smart-edit`](packages/pi-smart-edit/) | Automatic on load | Hashline-style line-anchored editing: `[path#TAG]` content-hash anchors on `read` results and a `hash_edit` tool that rejects stale anchors. |
| [`pi-subagent-mini`](packages/pi-subagent-mini/) | `subagent` tool | Lean single-tool subagent runtime: spawn isolated `pi --mode json` children, receive reports via completion notification (~296 prompt tokens). |
| [`pi-todo-mini`](packages/pi-todo-mini/) | `todo` tool, `/todos` | Lean three-state todo list with session persistence, status line/widget rendering, and delayed-steer task progression (fork of `@zhushanwen/pi-todo`; ships vitest tests). |
| [`pi-lsp-mini`](packages/pi-lsp-mini/) | `lsp_*` tools, `/lsp` | Zero-dependency LSP extension: diagnostics, references, call graph, workspace rename, symbol delete (~660 prompt tokens). |
| [`pi-web-lite`](packages/pi-web-lite/) | Automatic on load | Minimal web access: `webfetch` (URL → markdown with Gemini/Tavily fallbacks) and `websearch` (Exa). |
| [`pi-dsh-minimal`](packages/pi-dsh-minimal/) | Model-gated | Replicates DeepSeek Harness's `minimal` preset flow (persona + two tools first round, then promotion) for eligible DeepSeek models only; inert otherwise. |

The packages are independent and can be combined. A few natural pairs: `pi-smart-flow` + `pi-subagent-mini` (nudge keyed on the subagent tool), `pi-ui` + either subagent/todo package (display integration).

## Which packages should I use?

- Install **pi-extra-cmd** to get `/exit`, `/init`, and `/context` in one package.
- Install **pi-ui** if you use Pi interactively and prefer a compact Codex-style terminal interface.
- Install **pi-fake-codex** when using OpenAI Responses-compatible providers that expect Codex-shaped requests, or when your prompts expect an `apply_patch` tool. Review its hook security notes before enabling project hooks.
- Install **pi-smart-flow** (or the leaner **pi-smart-flow-lite**) for long-running shell commands and cleaner subagent delegation. It complements a subagent extension such as **pi-subagent-mini**; it does not implement a subagent runtime itself.
- Install **pi-smart-edit** if you want stale-view protection on edits instead of exact-text matching.
- Install **pi-todo-mini** for lightweight task tracking, and **pi-lsp-mini** for diagnostics/rename support without heavyweight tooling.
- Install **pi-web-lite** when the model needs `webfetch`/`websearch` and `pi-web-access` is more than you need.
- **pi-dsh-minimal** is a behavioral experiment for DeepSeek V4 models; it only activates on eligible models.

## Installation

Install a published package with Pi:

```bash
pi install npm:@NekoSekaiMoe/pi-extra-cmd
pi install npm:@NekoSekaiMoe/pi-ui
pi install npm:@NekoSekaiMoe/pi-fake-codex
pi install npm:@NekoSekaiMoe/pi-smart-flow
```

The unscoped packages (`pi-subagent-mini`, `pi-todo-mini`, `pi-lsp-mini`, `pi-web-lite`, `pi-dsh-minimal`) are developed here; load them directly from a checkout (see below) or publish them under your own scope.

Load any package directly from this repository:

```bash
pi -e ./packages/pi-extra-cmd/src/index.ts
pi -e ./packages/pi-ui/src/index.ts
pi -e ./packages/pi-todo-mini/index.ts
```

See each package README for behavior, configuration, compatibility notes, and security considerations.

## Repository layout

```text
.
├── packages/
│   ├── pi-dsh-minimal/
│   ├── pi-extra-cmd/
│   ├── pi-fake-codex/
│   ├── pi-lsp-mini/
│   ├── pi-smart-edit/
│   ├── pi-smart-flow/
│   ├── pi-smart-flow-lite/
│   ├── pi-subagent-mini/
│   ├── pi-todo-mini/
│   ├── pi-ui/
│   └── pi-web-lite/
├── package.json
├── tsconfig.base.json
└── yarn.lock
```

Every package declares its TypeScript entry point in `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

(`pi-todo-mini` uses `./index.ts` at the package root, which re-exports `src/index.ts`.) Pi loads that source directly through `jiti`. There is no build output or `dist/` directory.

## Development

Requirements:

- Yarn with workspace support
- A local Pi installation for interactive testing

Install dependencies and type-check the entire workspace:

```bash
yarn install
yarn typecheck
```

`pi-todo-mini` additionally ships vitest unit tests (`yarn workspace todo-lite run test`).

There is no build step. The repository uses `@typescript/native-preview` (`tsgo`) for type-checking only; end-to-end behavior (`pi install`, live commands) requires a real Pi session.

A package entry point must default-export an extension factory:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  // Register commands, tools, or lifecycle handlers.
}
```

## Compatibility notes

The workspace pins `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `@earendil-works/pi-agent-core`, and `@earendil-works/pi-ai` to **0.84.1** via `resolutions` to keep type identity aligned across packages. Update those pins together.

Licensing and naming are currently mixed: the `@NekoSekaiMoe/*` packages are BSD-2-Clause, while the adopted `-mini`/`-lite` packages keep their own MIT (or unset, for `pi-web-lite`) licenses — check each `package.json` before publishing.

Most packages rely on documented extension APIs. `pi-ui` additionally uses guarded TUI internals for renderer normalization and can require maintenance after Pi upgrades. `pi-fake-codex` changes provider requests and can execute commands declared in `.pi/hooks.json`; consult its README before using it with untrusted repositories. `pi-web-lite` probes helpers from an installed `pi-web-access` package for its Gemini/Exa fallbacks.

## Adding a package

1. Create `packages/pi-<name>/`.
2. Add a package manifest named `@NekoSekaiMoe/pi-<name>` with `license: "BSD-2-Clause"`, `files: ["src/", "README.md"]`, and a `pi.extensions` entry.
3. Add `tsconfig.json` extending `../../tsconfig.base.json`.
4. Implement the default-exported extension factory in `src/index.ts`.
5. Document installation, behavior, configuration, limitations, and security implications.
6. Run `yarn typecheck`.

## License

[BSD-2-Clause](LICENSE) for the `@NekoSekaiMoe/*` packages. Ported source files retain their original attribution where noted; adopted packages keep their own licenses.
