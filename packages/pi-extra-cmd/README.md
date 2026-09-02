# pi-extra-cmd

A bundle of small extra slash commands for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). It carries what used to be the standalone `pi-exit` and `pi-init` packages (both retired into this bundle) and adds a newer `/context` command.

## Commands

### `/exit`

Gracefully shuts pi down — a familiar alias for the built-in `/quit` (which cannot be shadowed). Uses `ctx.shutdown()`, the same path `/quit` takes, so the `session_shutdown` event fires and other extensions can flush state before exit.

### `/init [extra instructions]`

Generates a high-quality `AGENTS.md` contributor guide for the current repository. This is a command-driven replacement for the auto-invoked `init` skill: instead of relying on the model to discover a skill, `/init` injects the generation instructions as a user message, which always triggers a turn. Any arguments are appended as extra instructions, e.g. `/init also document the CI`.

### `/context`

Shows the current context-window usage and a per-category composition breakdown:

```
[context] 45.2k / 200k tokens (22.6%)
composition is a chars/4 estimate (~44.8k tokens total)
  System prompt   12.3k ████████░░░░░░░░  27.5%
  Thinking        10.4k ██████░░░░░░░░░░  23.2%
  Tool results     9.2k █████░░░░░░░░░░░  20.5%
  Assistant text   8.1k ████░░░░░░░░░░░░  18.1%
  User messages    3.2k ██░░░░░░░░░░░░░░   7.1%
  Tool calls       2.0k █░░░░░░░░░░░░░░░   4.5%
```

- The headline number comes from `ctx.getContextUsage()` — the same value the footer shows, derived from the last assistant response's real token usage. Right after a compaction it is unknown (`?`) until the next LLM response.
- The breakdown replays exactly what the next LLM call would carry (via `buildSessionContext()`, so compaction and branch summaries are respected) and estimates tokens per category with pi's own chars/4 heuristic (`estimateTokens`).
- The report is stored as a custom session entry (`pi.appendEntry`), so it renders in the TUI but **never enters the LLM context** itself. In non-TUI modes a one-line summary notification is shown instead.

## Installation

```bash
pi install npm:@NekoSekaiMoe/pi-extra-cmd
```

Or load the source directly:

```bash
pi -e ./src/index.ts
```

## Notes

- `/context` percentages in the breakdown are shares of the *estimated* total, not of the context window; the headline percentage is measured usage vs. the context window.
- The estimate is conservative (chars/4 overestimates for most text), so the breakdown may total slightly more than the measured usage.

## License

BSD-2-Clause
