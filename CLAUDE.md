# Repository Guidelines

## Project Structure & Module Organization

Yarn workspaces monorepo of extensions for the Pi coding agent. Each directory under `packages/` (e.g. `pi-extra-cmd`, `pi-ui`, `pi-smart-flow`, `pi-todo-mini`) is an independent, separately published package. Source lives in `src/index.ts` per package (`pi-todo-mini` uses a root `index.ts` re-exporting `src/index.ts`, with tests in `src/__tests__/`). There is no build output — Pi runs the `.ts` source directly via jiti. Shared config sits at the root (`package.json`, `tsconfig.base.json`, `yarn.lock`).

## Build, Test, and Development Commands

- `yarn install` — install workspace dependencies.
- `yarn typecheck` — run `tsgo --noEmit` across all packages; this is the primary verification gate.
- `yarn workspace todo-lite run test` — run the vitest unit tests shipped by `pi-todo-mini`.
- `pi -e ./packages/<name>/src/index.ts` — live-test an extension inside a real Pi session.

There is no build, lint, or format step.

## Coding Style & Naming Conventions

- TypeScript strict mode, 2-space indent (see `tsconfig.base.json`); `verbatimModuleSyntax` requires `import type` for type-only imports.
- Each entry point default-exports an extension factory: `export default function (pi: ExtensionAPI): void`.
- New packages go in `packages/pi-<name>/`, named `@NekoSekaiMoe/pi-<name>`, with a `pi.extensions` entry, `license: "BSD-2-Clause"`, `files: ["src/", "README.md"]`, and a `tsconfig.json` extending `../../tsconfig.base.json`.
- Every `@earendil-works/*` import must be declared in both `devDependencies` and `peerDependencies` as `"*"` (the Pi host provides them at runtime).
- Root `resolutions` pins all `@earendil-works/*` packages to 0.84.1 — bump these pins together.

## Testing Guidelines

No repo-wide test suite; coverage requirements do not apply. Verification means `yarn typecheck` passing clean plus interactive testing in Pi, since `pi install` and live commands need a real session. For `pi-todo-mini`, add tests under `src/__tests__/` named `*.test.ts` and run `yarn workspace todo-lite run test`.

## Commit & Pull Request Guidelines

History has no enforced convention; the prevailing useful pattern is `package: imperative summary`, e.g. `pi-ui: flatten pi-subagents async widget into Codex-style rows`. Keep commits scoped to one package where practical. PRs should state what changed and which packages are affected, call out any behavior or security implications, and confirm `yarn typecheck` passes.
