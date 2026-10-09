/**
 * pi-codex-compact — Codex compaction prompts
 *
 * Ported verbatim from the official Codex CLI (openai/codex):
 *
 *   - `codex-rs/prompts/templates/compact/prompt.md`         → SUMMARIZATION_PROMPT
 *   - `codex-rs/prompts/templates/compact/summary_prefix.md` → SUMMARY_PREFIX
 *
 * In Codex (`codex-rs/core/src/compact.rs`), the stored summary is assembled as
 * `format!("{SUMMARY_PREFIX}\n{summary_suffix}")`, so the model resuming after a
 * compaction treats the summary as an authoritative handoff from "another
 * language model" rather than as vague memory. We assemble ours the same way.
 */

/** Instructions for the summarization turn (Codex's compaction prompt). */
export const SUMMARIZATION_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

/** Prepended to the stored summary, framing it as a handoff (Codex's summary prefix). */
export const SUMMARY_PREFIX = `Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has been already done and avoid duplicating work. This is the summary produced by the other language model, use the information in this summary to assist with your own analysis.`;

/** True when `text` is one of our handoff-framed summaries. */
export function isCodexSummary(text: string | undefined): boolean {
  return !!text && text.startsWith(`${SUMMARY_PREFIX}\n`);
}

/** Remove our handoff prefix so re-summarization starts from the bare summary. */
export function stripCodexPrefix(text: string | undefined): string | undefined {
  if (!text) return undefined;
  return isCodexSummary(text) ? text.slice(SUMMARY_PREFIX.length + 1) : text;
}

/** Assemble the stored summary exactly like Codex: `{SUMMARY_PREFIX}\n{suffix}`. */
export function assembleCodexSummary(suffix: string): string {
  return `${SUMMARY_PREFIX}\n${suffix}`;
}
