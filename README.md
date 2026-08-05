# pi-packages

Extensions for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), by [@NekoSekaiMoe](https://github.com/NekoSekaiMoe).

A yarn-workspaces monorepo. Each package under `packages/` is a self-contained pi extension, published independently to npm under the `@NekoSekaiMoe` scope.

## Packages

| Package | Command | Description |
| --- | --- | --- |
| [`@NekoSekaiMoe/pi-exit`](packages/pi-exit) | `/exit` | A friendly alias for the built-in `/quit` — gracefully shuts pi down. |
| [`@NekoSekaiMoe/pi-init`](packages/pi-init) | `/init` | Generates a high-quality `AGENTS.md` contributor guide, replacing the auto-invoked `init` skill. |
| [`@NekoSekaiMoe/pi-ui`](packages/pi-ui) | — | Reskins the interactive TUI with a Codex-style open gradient input, single-line status toolbar, animated Working shimmer, and flat tool-call rows. |
| [`@NekoSekaiMoe/pi-fake-codex`](packages/pi-fake-codex) | — | Makes pi impersonate the official Codex CLI on Responses-API requests (identity headers + `openai-responses` body reshape) and registers an `apply_patch` editing alias. |
| [`@NekoSekaiMoe/pi-smart-flow`](packages/pi-smart-flow) | — | A lightweight delegation-experience layer complementing pi-subagents: delegation nudge, `bash_bg` adaptive shell, and blocking `observe` tool. |

## Install

```bash
pi install npm:@NekoSekaiMoe/pi-exit
pi install npm:@NekoSekaiMoe/pi-init
pi install npm:@NekoSekaiMoe/pi-ui
pi install npm:@NekoSekaiMoe/pi-fake-codex
pi install npm:@NekoSekaiMoe/pi-smart-flow
```

## Development

Pi loads extensions as TypeScript source directly (via [jiti](https://github.com/unjs/jiti)) — there is no build/emit step. `@typescript/native-preview` (`tsgo`) is used only for type checking.

```bash
yarn install       # install dev dependencies
yarn typecheck     # type-check all packages with tsgo

# Load a package into a live pi session for local testing
pi -e ./packages/pi-exit/src/index.ts
```

Each extension is a default-exported factory `(pi: ExtensionAPI) => void` declared in the package's `package.json` under `pi.extensions`.

## License

[BSD-2-Clause](LICENSE)
