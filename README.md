# pi-packages

A Yarn workspaces monorepo of extensions for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), maintained by [@NekoSekaiMoe](https://github.com/NekoSekaiMoe).

Each directory under [`packages/`](packages/) is an independent Pi package with its own npm release under the `@NekoSekaiMoe` scope. Install only the extensions you need; the repository is a development workspace, not a single runtime bundle.

## Packages

| Package | Activation | Purpose |
| --- | --- | --- |
| [`@NekoSekaiMoe/pi-extra-cmd`](packages/pi-extra-cmd/) | `/exit`, `/init`, `/context` | Extra slash commands: a `/quit` alias, `AGENTS.md` generation, and a context-window usage breakdown with per-category composition. |
| [`@NekoSekaiMoe/pi-ui`](packages/pi-ui/) | Automatic on load | Reskins the interactive TUI with a gradient editor, compact usage footer, animated working state, todo/subagent integration, and flat tool rows. |
| [`@NekoSekaiMoe/pi-fake-codex`](packages/pi-fake-codex/) | Automatic on load | Makes Responses API traffic resemble official Codex CLI traffic, adds an `apply_patch` alias, and runs Codex-compatible project hooks. |
| [`@NekoSekaiMoe/pi-smart-flow`](packages/pi-smart-flow/) | Automatic on load | Adds delegation guidance, an adaptive `bash_bg` shell tool, and a provider-based `observe` tool. |

## Which packages should I use?

- Install **pi-extra-cmd** to get `/exit`, `/init`, and `/context` in one package.
- Install **pi-ui** if you use Pi interactively and prefer a compact Codex-style terminal interface.
- Install **pi-fake-codex** when using OpenAI Responses-compatible providers that expect Codex-shaped requests, or when your prompts expect an `apply_patch` tool. Review its hook security notes before enabling project hooks.
- Install **pi-smart-flow** for long-running shell commands and cleaner subagent delegation. It complements `pi-subagents`; it does not implement a subagent runtime itself.

The packages are independent and can be combined.

## Installation

Install a published package with Pi:

```bash
pi install npm:@NekoSekaiMoe/pi-extra-cmd
pi install npm:@NekoSekaiMoe/pi-ui
pi install npm:@NekoSekaiMoe/pi-fake-codex
pi install npm:@NekoSekaiMoe/pi-smart-flow
```

See each package README for behavior, configuration, compatibility notes, and security considerations.

## Repository layout

```text
.
├── packages/
│   ├── pi-exit/
│   ├── pi-fake-codex/
│   ├── pi-init/
│   ├── pi-smart-flow/
│   └── pi-ui/
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

Pi loads that source directly through `jiti`. There is no build output or `dist/` directory.

## Development

Requirements:

- Yarn with workspace support
- A local Pi installation for interactive testing

Install dependencies and type-check the entire workspace:

```bash
yarn install
yarn typecheck
```

There is currently no automated test suite and no build step. The repository uses `@typescript/native-preview` (`tsgo`) for type-checking only.

Load one extension directly from a checkout:

```bash
pi -e ./packages/pi-exit/src/index.ts
pi -e ./packages/pi-ui/src/index.ts
```

A package entry point must default-export an extension factory:

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  // Register commands, tools, or lifecycle handlers.
}
```

## Compatibility notes

The workspace currently pins `@earendil-works/pi-tui` and `@earendil-works/pi-agent-core` to `0.81.0` to keep type identity aligned with the installed Pi version. Update those resolutions together with `@earendil-works/pi-coding-agent`.

Most packages rely on documented extension APIs. `pi-ui` additionally uses guarded TUI internals for renderer normalization and can require maintenance after Pi upgrades. `pi-fake-codex` changes provider requests and can execute commands declared in `.pi/hooks.json`; consult its README before using it with untrusted repositories.

## Adding a package

1. Create `packages/pi-<name>/`.
2. Add a package manifest named `@NekoSekaiMoe/pi-<name>` with `license: "BSD-2-Clause"`, `files: ["src/", "README.md"]`, and a `pi.extensions` entry.
3. Add `tsconfig.json` extending `../../tsconfig.base.json`.
4. Implement the default-exported extension factory in `src/index.ts`.
5. Document installation, behavior, configuration, limitations, and security implications.
6. Run `yarn typecheck`.

## License

[BSD-2-Clause](LICENSE). Ported source files retain their original attribution where noted.
