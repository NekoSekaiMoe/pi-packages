# @NekoSekaiMoe/pi-codex-compact

Codex-style context compaction for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). When pi compacts a session — manually via `/compact`, automatically at the context threshold, or during overflow recovery — this extension replaces the default compaction with the strategy used by the official OpenAI Codex CLI (`codex-rs/core/src/compact.rs`), so long sessions keep their bearings instead of degrading into "vague memory".

Companion package to [`@NekoSekaiMoe/pi-fake-codex`](https://www.npmjs.com/package/@NekoSekaiMoe/pi-fake-codex) (which impersonates Codex's wire traffic). The two are independent; compaction is provider-agnostic and works with any model.

## Installation

```bash
pi install npm:@NekoSekaiMoe/pi-codex-compact
```

For local development from this package directory:

```bash
pi -e ./src/index.ts
```

There are no commands or tools; every compaction in the session is taken over on load.

## How Codex avoids forgetting, and where this ports it

Codex's compaction never equals "keep only a summary". Four ideas make it forget-resistant, and all four are mapped onto pi's extension hooks:

| Codex mechanism | Codex source | This package |
| --- | --- | --- |
| Summaries are generated from the full un-truncated history, as a structured handoff | `prompts/templates/compact/prompt.md` | The summarization call reuses pi's `generateSummaryWithUsage` (retries, length-stop rejection, usage accounting) with Codex's compaction prompt as additional focus |
| The stored summary is wrapped in a handoff frame telling the next model to build on prior work instead of duplicating it | `prompts/templates/compact/summary_prefix.md`, `format!("{SUMMARY_PREFIX}\n{suffix}")` | The stored summary is assembled as `SUMMARY_PREFIX + "\n" + summary`, verbatim from Codex |
| Recent user messages are retained **verbatim** (up to `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` tokens), never summarized away | `build_compacted_history` in `core/src/compact.rs` | pi's cut point only guarantees a `keepRecentTokens` window over *all* messages, so user instructions can drop out while bulky tool output fills the window. We walk the branch backwards until the kept region covers the configured budget of user-message tokens and move `firstKeptEntryId` back to that boundary — those instructions then survive compaction exactly |
| Codex warns after every compaction that long threads degrade accuracy | `EventMsg::Warning` in `run_compact_task_inner_impl` | A `session_compact` handler appends the same warning as a TUI-only transcript row (never sent to the LLM) |

Two further pieces come for free with pi and are why they are not reimplemented:

- **Canonical context re-injection**: Codex rebuilds its "world state" (environment, AGENTS.md, instructions) after every compaction. pi already rebuilds the system prompt from live state on every run, so nothing canonical ever depends on the conversation history.
- **Roll-forward of old summaries**: Codex re-summarizes the previous summary as part of the full history; pi feeds `previousSummary` into a PRESERVE-rules update prompt. We pass the previous summary through with our handoff prefix stripped, so successive compactions merge instead of compounding loss.

File lists (`<read-files>` / `<modified-files>` tags appended to the summary, rolled forward across compactions) are kept in the same shape pi's native compaction uses, so session files stay compatible with pi tooling.

## What the model sees after compaction

```text
[system prompt — rebuilt fresh by pi]
[user] Another language model started to solve this problem and produced a
       summary of its thinking process. … use the information in this summary
       to assist with your own analysis:
       <structured summary>
       <read-files>…</read-files>
       <modified-files>…</modified-files>
[verbatim entries from the extended cut point: user messages, tool calls, …]
```

## Configuration

Read from the environment when a compaction runs:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_CODEX_COMPACT` | `1` | Set `0` to disable the takeover entirely (pi's default compaction runs) |
| `PI_CODEX_COMPACT_USER_TOKENS` | `20000` | Verbatim token budget for recent user messages across the cut point (Codex's `COMPACT_USER_MESSAGE_MAX_TOKENS`) |

## Failure policy

The takeover is strictly best-effort: if there is no model, auth cannot be resolved, nothing is left to summarize, or the summarization call fails, the `session_before_compact` handler returns without a result and pi's default compaction runs untouched. Compaction must never break because of this extension.

## Caveats

- Codex itself acknowledges repeated compaction degrades accuracy — hence the warning. When a task is done, start a new thread.
- Retention counting uses pi's conservative `estimateTokens` (chars/4) heuristic over raw session entries; context-edit omissions in the extended region are approximated by their raw content in the summarization input.
- The kept-region extension is bounded by the previous compaction boundary: entries already summarized in an earlier compaction are not resurrected; their content rides in the rolled-forward summary.

## License

BSD-2-Clause
