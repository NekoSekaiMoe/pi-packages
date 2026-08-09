# CLAUDE.md

Guidance for Claude Code and other AI agents working in this repository.

## What this is

A yarn-workspaces monorepo of extensions ("packages") for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), published under the `@NekoSekaiMoe/*` scope.

- `packages/pi-exit` — registers `/exit` as an alias for the built-in `/quit`.
- `packages/pi-fake-codex` — impersonates Codex CLI for Responses-API requests and adds an `apply_patch` tool.
- `packages/pi-init` — registers `/init`, which injects an `AGENTS.md`-generation prompt (a command-driven replacement for the auto-invoked `init` skill).
- `packages/pi-smart-edit` — hashline-style line-anchored editing: `[path#TAG]` content-hash anchors on read results and a `hash_edit` patch tool that rejects stale anchors.
- `packages/pi-smart-flow` — lightweight delegation experience (delegation nudge, `bash_bg`, `observe`).
- `packages/pi-ui` — reskins the interactive TUI with Codex-style gradient, working shimmer, and flat tool rows.

## How Pi loads extensions

- An extension is a TypeScript module with a **default export** `(pi: ExtensionAPI) => void`.
- The entry point is declared in the package's `package.json` under `pi.extensions`, e.g. `"pi": { "extensions": ["./src/index.ts"] }`.
- Pi runs the `.ts` source **directly via jiti** — there is **no build/emit step**. Do not add a bundler or expect a `dist/`.
- `@typescript/native-preview` (the `tsgo` binary) is used **for type-checking only**.
- Import types from `@earendil-works/pi-coding-agent` (the installed package, currently v0.80.10). At runtime Pi also aliases `@mariozechner/pi-coding-agent` to the same module, so either specifier resolves — prefer `@earendil-works/*` since that is what is on disk.

## Commands

```bash
yarn install      # install workspace deps
yarn typecheck    # tsgo --noEmit -p tsconfig.base.json
```

There is no test suite yet, and no build. Verification = `yarn typecheck` passing clean.

## Conventions

- TypeScript, 2-space indent, strict mode (see `tsconfig.base.json`).
- Each package extends the root `tsconfig.base.json`.
- Keep extensions small and single-purpose: register one command/handler, delegate to documented `ExtensionAPI` methods (`registerCommand`, `ctx.shutdown()`, `pi.sendUserMessage`, …) rather than reaching into internals.
- License is **BSD-2-Clause** across all packages. Keep the `license` field and README footer consistent when adding a package.

## Adding a new package

1. Create `packages/pi-<name>/` with `package.json` (name `@NekoSekaiMoe/pi-<name>`, `pi.extensions` entry, `license: BSD-2-Clause`, `files: ["src/", "README.md"]`).
2. Add `tsconfig.json` extending `../../tsconfig.base.json`.
3. Write `src/index.ts` with the default-export factory, and a `README.md`.
4. Run `yarn typecheck`.

## Caveats

- `/quit` is a built-in command name and cannot be shadowed; that is why the alias is `/exit`.
- The root `package.json` pins `@earendil-works/pi-tui` and `@earendil-works/pi-agent-core` to **0.81.0** via `resolutions`. Without the pin, fresh installs hoist the latest (e.g. 0.83.x) for the `*` ranges next to pi-coding-agent 0.80.10's nested 0.81.0 copy, and type identity across the two copies (private fields) breaks `yarn typecheck`. Bump the pins together with the installed pi-coding-agent.
- End-to-end behavior (`pi install`, running commands live) requires a real Pi session and cannot be verified by typecheck alone.
