# @NekoSekaiMoe/pi-ui

A UI reskin for the [Pi coding agent](https://github.com/badlogic/pi-mono) that
gives the interactive TUI a Codex-style look:

- **Open gradient input** — pink-to-cyan top/bottom rules, a pink left accent,
  and an embedded `model  provider  thinking` row like the reference UI.
- **Single-line status toolbar** — existing extension statuses stay visible on
  the left; a context meter (`[▓▓░░░░░░] 25%/272k`), token totals, and cost stay
  right-aligned. All values are real Pi data.
- **Animated Working shimmer** — `· Working (9s · esc to interrupt)` with a
  moving white/cyan/green gradient and a live elapsed counter.
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
| `working.ts`  | `ctx.ui.setWorkingIndicator()` + `setWorkingMessage()` | Animated shimmer + live counter              |
| `tools.ts`    | `pi.registerTool()` + `ToolExecutionComponent`      | Flat tool rows and edit/write diffs             |
| `gradient.ts` | —                                                   | Truecolor gradient helpers                      |

The tool-row restyle re-registers a tool of the **same name** for each built-in
(`bash`, `read`, `edit`, `write`, `grep`, `find`, `ls`). It spreads the built-in
definition first, so the real `execute`, parameters, and prompt metadata are
reused verbatim — only `renderShell`, `renderCall`, and `renderResult` change.
`write` additionally captures the previous file contents so its result can carry
the same display-oriented diff that `edit` already returns. Diff rows include
`(+added -removed)` totals and collapse long changes behind the normal tool
expand shortcut.

Shell results keep an up-to-seven-line collapsed preview (three leading lines,
a hidden line count, and three trailing lines when output is longer). `fffind`, `ask_user_question`, and
`subagent` are registered by their owning extensions, so their definitions and
execution stay untouched. Pi UI only redirects their TUI renderer lookups to the
same flat rows used by the built-in tools; subagent activity is presented as an
`Explored` list.

## Version coupling

The tool-row restyle depends on Pi internals that are not part of the stable
extension contract:

- the `create<Tool>ToolDefinition(cwd)` factories exported from
  `@earendil-works/pi-coding-agent`, and
- the private renderer lookup methods on the exported `ToolExecutionComponent`
  used to normalize externally registered tool rows, and
- the `ToolRenderContext` flags (`executionStarted`, `argsComplete`, `isPartial`,
  `isError`).

Verified against **pi-coding-agent 0.81.0** (this repo's pinned version). Each
tool swap is wrapped in `try`/`catch`: if a factory import or shape changes, that
tool silently keeps its built-in rendering rather than breaking execution. The
gradient indicator, footer, and bordered editor use only stable public APIs.

## Limitations

- The `›` user-message line and generic assistant-text styling are not
  reskinnable through the public API and are left as-is.
- Truecolor frame and shimmer colors require a truecolor-capable terminal; elsewhere they
  degrade to the nearest supported color (text stays intact).

## License

BSD-2-Clause.
