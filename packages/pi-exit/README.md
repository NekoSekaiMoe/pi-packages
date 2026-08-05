# @NekoSekaiMoe/pi-exit

A tiny extension for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) that adds `/exit` as a friendly alias for the built-in `/quit` command.

## Why

Pi uses `/quit`, while shells and REPLs such as Bash, Python, Node.js, and `psql` train users to type `exit`. This package preserves that muscle memory without replacing or shadowing Pi's built-in command.

## Installation

```bash
pi install npm:@NekoSekaiMoe/pi-exit
```

For local development from this package directory:

```bash
pi -e ./src/index.ts
```

## Usage

```text
/exit
```

Arguments after `/exit` are ignored.

## How it works

The extension registers one command with `pi.registerCommand("exit", ...)`. Its handler calls:

```ts
ctx.shutdown();
```

This is Pi's graceful shutdown API—the same shutdown path used by `/quit`. It emits the normal `session_shutdown` lifecycle event so other extensions can flush state, stop jobs, or release resources before the process exits.

The package deliberately does **not**:

- call `process.exit()` directly;
- rewrite `/exit` into a synthetic `/quit` message;
- change the behavior of Pi's built-in `/quit`; or
- add any configuration, tools, or background services.

## Source

```text
src/index.ts   command registration and shutdown handler
package.json   Pi extension entry point and npm metadata
```

Pi loads `src/index.ts` directly; there is no build step.

## License

BSD-2-Clause.
