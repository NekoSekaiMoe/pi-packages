# @NekoSekaiMoe/pi-exit

Adds an `/exit` command to the [Pi coding agent](https://github.com/badlogic/pi-mono) — a friendly alias for the built-in `/quit`.

## Why

Pi ships `/quit`, but muscle memory from other shells and REPLs (`bash`, `python`, `node`, `psql`, …) reaches for `exit`. This extension makes `/exit` work too, delegating to the same graceful-shutdown path `/quit` uses.

## What it does

Registers a single `/exit` command that calls `ctx.shutdown()` — the documented "gracefully shutdown pi and exit" API. This fires the `session_shutdown` event (reason `quit`), so other extensions get a chance to flush their state before the process exits. Behaviorally identical to `/quit`.

## Install

```bash
# From npm
pi install npm:@NekoSekaiMoe/pi-exit

# Local development
pi -e ./src/index.ts
```

## Usage

```
/exit
```

## License

BSD-2-Clause
