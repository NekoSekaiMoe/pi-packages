/**
 * pi-codex-compact — Compaction engine
 *
 * Takes over pi's compaction through the `session_before_compact` hook (returning
 * a custom `CompactionResult`) and rebuilds it the way Codex does
 * (`codex-rs/core/src/compact.rs`):
 *
 * 1. Verbatim user-message retention. Codex never lets recent user messages be
 *    summarized away: `build_compacted_history` keeps original user messages,
 *    newest-first, up to `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000` tokens, in
 *    addition to the summary. Pi's cut point only guarantees a
 *    `keepRecentTokens` window over *all* messages, so user instructions can
 *    fall out of it while bulky tool output fills it. We therefore walk the
 *    branch backwards until the kept region covers the configured budget of
 *    user-message tokens and move the cut point (`firstKeptEntryId`) back to
 *    that boundary. Context that "must not be forgotten" (recent user
 *    instructions, preferences, corrections) then survives compaction exactly,
 *    not through the summary.
 *
 * 2. Handoff summary. The summarization call reuses pi's
 *    `generateSummaryWithUsage` (retry policy, length-stop rejection, usage
 *    accounting) with Codex's compaction prompt as the additional focus, and the
 *    stored summary is wrapped in Codex's `SUMMARY_PREFIX` handoff framing.
 *    Old summaries roll forward: `previousSummary` is fed back into the update
 *    prompt, with our prefix stripped first.
 *
 * 3. Rolling file lists. Like pi's native compaction, file operations are
 *    extracted from the summarized region and appended as
 *    `<read-files>` / `<modified-files>` tags, and stored in the entry
 *    `details` so the next compaction can roll them forward (Codex keeps the
 *    same information in its retained context).
 *
 * Failure policy: any surprise (no model, auth failure, empty summarize set)
 * returns `undefined` so pi's default compaction runs untouched. We never want
 * to *break* compaction.
 *
 * Everything not summarized is kept verbatim by pi's session projection, and
 * the system prompt / environment are rebuilt fresh by pi every run — the
 * equivalents of Codex's canonical world-state re-injection.
 */

import {
  type CompactionResult,
  type ExtensionContext,
  estimateTokens,
  generateSummaryWithUsage,
  sessionEntryToContextMessages,
  type SessionBeforeCompactEvent,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { assembleCodexSummary, stripCodexPrefix, SUMMARIZATION_PROMPT } from "./prompt.ts";

/** Codex's `COMPACT_USER_MESSAGE_MAX_TOKENS`. */
export const DEFAULT_USER_RETAIN_TOKENS = 20_000;

export interface CodexCompactConfig {
  /** Verbatim token budget for recent user messages across the cut point. */
  userRetainTokens: number;
}

export function configFromEnv(): CodexCompactConfig {
  const raw = Number(process.env.PI_CODEX_COMPACT_USER_TOKENS);
  return {
    userRetainTokens: Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_USER_RETAIN_TOKENS,
  };
}

/** Request auth pieces `generateSummaryWithUsage` accepts. */
export interface SummarizationAuth {
  apiKey?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

type SessionModel = NonNullable<ExtensionContext["model"]>;

/** Estimated tokens of user-role messages an entry contributes to context. */
function entryUserTokens(entry: SessionEntry): number {
  let tokens = 0;
  for (const message of sessionEntryToContextMessages(entry)) {
    if (message.role === "user") tokens += estimateTokens(message);
  }
  return tokens;
}

/** Whether an entry projects only tool results (never a valid cut target). */
function projectsToolResultOnly(entry: SessionEntry): boolean {
  const messages = sessionEntryToContextMessages(entry);
  return messages.length > 0 && messages.every((message) => message.role === "toolResult");
}

/**
 * Index of the first raw entry still visible from the previous compaction.
 * Entries before it were already summarized; re-reading them would duplicate
 * what `previousSummary` already carries.
 */
function summarizeBoundary(branchEntries: SessionEntry[]): number {
  let previous: SessionEntry | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      previous = branchEntries[i];
      break;
    }
  }
  if (previous?.type !== "compaction" || !previous.firstKeptEntryId) return 0;
  const index = branchEntries.findIndex((entry) => entry.id === previous.firstKeptEntryId);
  return index >= 0 ? index : 0;
}

export interface RetentionPlan {
  /** Replacement cut point; `undefined` keeps pi's own cut. */
  firstKeptEntryId: string | undefined;
  /** Raw entries that should be summarized, or `undefined` to use pi's set. */
  summarizeEntries: SessionEntry[] | undefined;
}

/**
 * Extend pi's kept region backwards until it covers `budget` tokens of
 * user-role messages (mirrors Codex's `COMPACT_USER_MESSAGE_MAX_TOKENS`).
 *
 * The cut snaps to an entry that has an id and does not project tool results
 * only, so we never orphan an assistant tool call from its results. Walking
 * *earlier* on a bad target keeps strictly more context, which is safe.
 */
export function planUserRetention(
  branchEntries: SessionEntry[],
  firstKeptEntryId: string,
  budget: number,
): RetentionPlan {
  const cutIndex = branchEntries.findIndex((entry) => entry.id === firstKeptEntryId);
  if (cutIndex <= 0) return { firstKeptEntryId: undefined, summarizeEntries: undefined };

  let retained = 0;
  for (let i = cutIndex; i < branchEntries.length; i++) {
    retained += entryUserTokens(branchEntries[i]);
  }
  if (retained >= budget) {
    // Pi's window already covers the user-message budget.
    return { firstKeptEntryId: undefined, summarizeEntries: undefined };
  }

  let target = -1;
  for (let i = cutIndex - 1; i >= 0; i--) {
    retained += entryUserTokens(branchEntries[i]);
    target = i;
    if (retained >= budget) break;
  }
  while (target >= 0) {
    const entry = branchEntries[target];
    if (entry.id && !projectsToolResultOnly(entry)) break;
    target--;
  }
  // The budget covers the whole session: compaction has nothing left to
  // summarize. Signal the caller to fall back to pi's default plan.
  if (target < 0) return { firstKeptEntryId: undefined, summarizeEntries: undefined };

  return {
    firstKeptEntryId: branchEntries[target].id,
    summarizeEntries: branchEntries.slice(summarizeBoundary(branchEntries), target),
  };
}

/** Local copy of pi's file-operation tracking (not re-exported by the package). */
interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

function addFileOp(toolName: unknown, args: unknown, fileOps: FileOperations): void {
  const path =
    typeof args === "object" && args !== null && "path" in args && typeof (args as { path: unknown }).path === "string"
      ? (args as { path: string }).path
      : undefined;
  if (!path) return;
  if (toolName === "read") fileOps.read.add(path);
  else if (toolName === "write") fileOps.written.add(path);
  else if (toolName === "edit") fileOps.edited.add(path);
}

function extractFileOps(messages: readonly unknown[], fileOps: FileOperations): void {
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const role = (message as { role?: unknown }).role;
    const content = (message as { content?: unknown }).content;
    if (role === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const blockRecord = block as { type?: unknown; name?: unknown; arguments?: unknown };
        if (blockRecord.type === "toolCall") {
          addFileOp(blockRecord.name, blockRecord.arguments, fileOps);
        }
      }
    } else if (role === "toolResult") {
      const nested = (message as { nestedCalls?: { calls?: unknown[] } }).nestedCalls?.calls ?? [];
      for (const call of nested) {
        if (typeof call !== "object" || call === null) continue;
        const callRecord = call as { name?: unknown; arguments?: unknown };
        addFileOp(callRecord.name, callRecord.arguments, fileOps);
      }
    }
  }
}

/** pi's `computeFileLists`: read-only files vs. modified (written ∪ edited). */
function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((file) => !modified.has(file)).sort();
  const modifiedFiles = [...modified].sort();
  return { readFiles, modifiedFiles };
}

/** pi's `formatFileOperations`: XML tag appendix for the summary. */
function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

/**
 * Roll the previous compaction's file lists forward. Pi only inherits lists
 * from pi-generated entries; ours carry `fromExtension`, so we merge them here.
 */
function rollForwardFileLists(branchEntries: SessionEntry[], fileOps: FileOperations): void {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    if (entry.type !== "compaction") continue;
    const details = entry.details as { readFiles?: unknown; modifiedFiles?: unknown } | undefined;
    if (Array.isArray(details?.readFiles)) {
      for (const file of details.readFiles) if (typeof file === "string") fileOps.read.add(file);
    }
    if (Array.isArray(details?.modifiedFiles)) {
      for (const file of details.modifiedFiles) if (typeof file === "string") fileOps.edited.add(file);
    }
    break;
  }
}

/**
 * Produce a Codex-style CompactionResult, or `undefined` to let pi's default
 * compaction run.
 */
export async function runCodexCompaction(
  event: SessionBeforeCompactEvent,
  model: SessionModel,
  auth: SummarizationAuth,
  config: CodexCompactConfig,
  thinkingLevel: ExtensionContext["thinkingLevel"],
): Promise<CompactionResult | undefined> {
  const preparation = event.preparation;
  const plan = planUserRetention(event.branchEntries, preparation.firstKeptEntryId, config.userRetainTokens);

  const messages = plan.summarizeEntries
    ? plan.summarizeEntries.flatMap((entry) => sessionEntryToContextMessages(entry))
    : [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  if (messages.length === 0) return undefined;

  const focus = [SUMMARIZATION_PROMPT, event.customInstructions].filter(Boolean).join("\n\n");
  const { text, usage } = await generateSummaryWithUsage(
    messages,
    model,
    preparation.settings.reserveTokens,
    auth.apiKey,
    auth.headers,
    event.signal,
    focus,
    stripCodexPrefix(preparation.previousSummary),
    thinkingLevel,
    undefined,
    auth.env,
  );

  const fileOps: FileOperations = { read: new Set(), written: new Set(), edited: new Set() };
  extractFileOps(messages, fileOps);
  rollForwardFileLists(event.branchEntries, fileOps);
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);

  return {
    summary: assembleCodexSummary(`${text}${formatFileOperations(readFiles, modifiedFiles)}`),
    firstKeptEntryId: plan.firstKeptEntryId ?? preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    usage,
    details: { readFiles, modifiedFiles },
  };
}
