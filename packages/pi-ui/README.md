# @NekoSekaiMoe/pi-ui

A UI reskin for the [Pi coding agent](https://github.com/badlogic/pi-mono) that
gives the interactive TUI a Codex-style look:

- **Open gradient input** — pink-to-cyan top/bottom rules, a pink left accent,
  and an embedded `model  provider  thinking` row like the reference UI.
- **Single-line status toolbar** — existing extension statuses stay visible on
  the left; a context meter (`[▓▓░░░░░░] 25%/272k`), token totals, and cost stay
  right-aligned. All values are real Pi data.
- **Animated status shimmer** — `· Working (9s · esc to interrupt)` with a
  moving rainbow gradient and a live elapsed counter. Retry countdowns
  and context compaction use the same shimmer while preserving their status
  details. Once the agent settles, a persistent `Worked for 9s` transcript row
  records the full run time.
- **Todo plan hijack** — when a todo extension (e.g. `@zhushanwen/pi-todo`)
  creates a plan, the transcript keeps a single `● Plan created · N steps` tool
  row (the full list stays in that extension's own widget/status). Later todo
  updates render nothing at all — the Working line silently glides to the next
  step: `1/3 · implement rainbow shimmer (9s · esc to interrupt)`. Finished or
  cleared plans fall back to the plain `Working` label; failed updates still
  surface their error row. The extension's own plan widget above the editor is
  suppressed (`setWidget("todo")` writes are forced to `undefined`) since the
  Working line already tracks the current step.
- **Flat Codex-style tool rows** — the built-in tools render as a status-dot
  title row plus a `└ …` output sub-row:

  ```
  • Running rg --files
  • Ran rg --files
    └ execution error: …
  • Ran ls
    └ (no output)
  ```

## Usage

```bash
pi -e ./src/index.ts          # run from a checkout
pi install npm:@NekoSekaiMoe/pi-ui
```

Everything visual is gated to interactive (TUI) mode. In `rpc`, `print`, and
`json` modes the extension is inert and Pi's defaults are used.

## How it works

The extension is wiring only (`src/index.ts`); each concern is a small module
built on documented `ExtensionAPI` / `ExtensionUIContext` methods:

| Module        | Pi API                                              | What it does                                    |
| ------------- | --------------------------------------------------- | ----------------------------------------------- |
| `editor.ts`   | `ctx.ui.setEditorComponent()`                       | Open frame + embedded model toolbar             |
| `footer.ts`   | `ctx.ui.setFooter()`                                | Extension statuses + usage toolbar              |
| `working.ts`  | Working UI methods + guarded TUI `Loader` hook       | Status shimmer + elapsed transcript row         |
| `tools.ts`    | `pi.registerTool()` + `ToolExecutionComponent`      | Flat tool rows and edit/write diffs             |
| `gradient.ts` | —                                                   | Truecolor gradient helpers                      |

The tool-row restyle re-registers same-name definitions for `bash`, `read`,
`edit`, `write`, and `ls`. It spreads each built-in definition first, so the real
`execute`, parameters, and prompt metadata are reused verbatim. `grep` and `find`
use renderer-only lookup redirects instead, preserving FFF or other extension
implementations regardless of package load order. `write` additionally captures
the previous file contents so its result can carry
the same display-oriented diff that `edit` already returns. Diff rows include
`(+added -removed)` totals and collapse long changes behind the normal tool
expand shortcut.

Shell results keep an up-to-seven-line collapsed preview (three leading lines,
a hidden line count, and three trailing lines when output is longer). Every
other tool — `grep` and `find`, extension tools like `fffind`, `ffgrep`,
`web_search`, `batch_web_fetch`, `ask_user_question`, and `subagent`, plus any
tool added later by newly installed extensions or MCP servers — is covered
automatically: Pi UI redirects the TUI renderer lookups on
`ToolExecutionComponent` to the same flat rows without touching the owning
extension's definition or execution. Tools with a curated entry get tailored
verbs (`Searched`, `Fetched`, …); unknown tools get a derived
`Running <name>` row whose label comes from common argument keys or a compact
JSON summary. Subagent activity is presented as an `Explored` list. The
redirect is process-lifetime and survives session switches, so FFF or other
extension implementations keep their flat rendering regardless of package
load order.

## Version coupling

The tool-row restyle depends on Pi internals that are not part of the stable
extension contract:

- the `create<Tool>ToolDefinition(cwd)` factories exported from
  `@earendil-works/pi-coding-agent`, and
- the private renderer lookup methods on the exported `ToolExecutionComponent`
  used to normalize externally registered tool rows,
- the TUI `Loader.updateDisplay` implementation used to style retry and
  compaction statuses, and
- the `ToolRenderContext` flags (`executionStarted`, `argsComplete`, `isPartial`,
  `isError`).

Verified against **pi-coding-agent 0.81.0** (the current lockfile version). Each
internal hook is guarded by shape checks and `try`/`catch`; incompatible shapes
keep Pi's default rendering. Prototype changes are restored on session shutdown.
The normal Working indicator, elapsed entry, footer, and bordered editor use
stable public APIs.

## Limitations

- The `›` user-message line and generic assistant-text styling are not
  reskinnable through the public API and are left as-is.
- Truecolor frame and shimmer colors require a truecolor-capable terminal; elsewhere they
  degrade to the nearest supported color (text stays intact).

## License

BSD-2-Clause.
