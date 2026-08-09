# @NekoSekaiMoe/pi-smart-edit

Hashline-style smart editing for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent), borrowed from oh-my-pi's `@oh-my-pi/hashline`.

`pi-smart-edit` changes how the model addresses edits: instead of reproducing old text (Pi's built-in `edit`) it anchors every hunk to a **content-hash tag** plus **original line numbers**, so a stale view of the file becomes an explicit, recoverable error instead of silent corruption.

## How it works

1. **Anchored reads.** A `tool_result` middleware rewrites `read` results into

   ```text
   [greet.py#A16F]
   1:def greet(name):
   2:    msg = "Hello, " + name
   3:    print(msg)
   ```

   `#A16F` is a 4-hex hash of the full normalized file content, recorded in a session snapshot store. Successful `write`/`edit` results get a fresh `[path#TAG]` appended, so a live anchor is always available.

2. **Line-anchored patches.** The registered `hash_edit` tool accepts one `patch` string with one or more file sections:

   ```text
   [greet.py#A16F]
   PUT 2.=3:
   +    print(f"Hello, {name}")
   PUT >$:
   +
   +greet("world")
   ```

   - `PUT N.=M:` — replace original lines N–M (inclusive) with the `+` body rows.
   - `PUT <N:` / `PUT >N:` — insert body rows before/after line N (`PUT <1:` = head, `PUT >$:` = tail).
   - `CUT N.=M` — delete original lines N–M.
   - `REM` — delete the whole file (must be the section's only op).
   - Body rows are `+TEXT` verbatim; `+` alone is a blank line. A literal leading `-`/`+` keeps its prefix (`- item` → `+- item`).

3. **Stale-anchor rejection.** Before writing, the tool re-reads the live file and compares its content hash to the section's `#TAG`. A mismatch (linter, user edit, another tool) rejects the whole batch with a "re-read and retry" message. All sections are verified inside Pi's per-file mutation queues before any write lands, so a partial batch never applies.

Line numbers always name **original** lines — earlier hunks in the same patch never shift later ones. Inserts use gap semantics: `PUT >N:` anchors the gap after line N, which survives even when line N itself is replaced (the insert lands right after the replacement body).

## Differences from oh-my-pi's hashline

This is a clean-room subset, not a port. Not implemented (they produce explicit parse errors):

- AST block ops (`PUT N*:`, `CUT N*`) — the original resolves syntactic blocks via tree-sitter.
- Named registers / cut-and-paste across files (`CUT 5.=9 @fn`, `PUT >40 @fn`).
- `MV` rename op and session-aware 3-way-merge recovery — a stale anchor here is always a hard reject.

CRLF line endings and BOMs are preserved on write; hashing normalizes both.

## Installation

```bash
pi install npm:@NekoSekaiMoe/pi-smart-edit
```

The built-in `edit` tool stays active as a fallback. If you prefer hashline-only editing, deactivate `edit` via `pi.setActiveTools()` from another extension or leave both — `hash_edit`'s prompt guidelines steer the model to prefer it for files it has read.

## Files

| Path | Role |
| --- | --- |
| `src/hashline.ts` | Pure core: normalization, content tags, snapshot store, patch parser, gap-semantic applier, read-result annotation |
| `src/index.ts` | Extension wiring: `hash_edit` tool, `read`/`write`/`edit` result middleware, atomic multi-file apply |

## Caveats

- The middleware re-reads each file after `read`/`write`/`edit` results to record snapshots; files are warm in the OS page cache, so this is cheap, but it only works for local paths.
- `yarn typecheck` verifies types only. End-to-end validation requires a real Pi session.

## License

BSD-2-Clause.
