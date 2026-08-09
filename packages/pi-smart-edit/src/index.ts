/**
 * pi-smart-edit — hashline-style smart editing for Pi.
 *
 * Borrowed from oh-my-pi's `@oh-my-pi/hashline` idea (see packages/pi-ui/ref):
 *
 * 1. A `tool_result` middleware rewrites `read` results into the anchored
 *    shape `[path#TAG]` + `N:TEXT` numbered lines and records a content
 *    snapshot; `write`/`edit` results get a fresh `[path#TAG]` appended so the
 *    model always has a live anchor.
 * 2. A `hash_edit` tool applies line-anchored patches (`PUT N.=M:`, `PUT <N:`,
 *    `PUT >N:`, `PUT >$:`, `CUT N.=M`, `REM`). Before writing, it re-reads the
 *    live file and rejects the patch when the content hash no longer matches
 *    the section's #TAG — stale views become explicit, recoverable errors
 *    instead of silent corruption.
 *
 * Subset notes: AST block ops (PUT N*:), named registers/paste, and MV are not
 * implemented; using them produces a parse error explaining the subset.
 */

import { readFile, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  type ExtensionAPI,
  type ExtensionContext,
  isEditToolResult,
  isReadToolResult,
  isWriteToolResult,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  applySectionOps,
  annotateReadText,
  contentTag,
  type FileSection,
  HashlineError,
  hasTrailingNewline,
  normalizeContent,
  parsePatch,
  SnapshotStore,
  splitLines,
} from "./hashline.ts";

const TOOL_NAME = "hash_edit";
const HEADER_LINE_RE = /^\[.+#[0-9A-Fa-f]{4}\]\n/;

const store = new SnapshotStore();

// ─── Path helpers ───────────────────────────────────────────────────────────

/** Strip a leading @ (some models prefix paths with it) and resolve against cwd. */
function resolveModelPath(rawPath: string, cwd: string): string {
  const cleaned = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  return isAbsolute(cleaned) ? cleaned : resolve(cwd, cleaned);
}

function inputPath(input: Record<string, unknown>): string | undefined {
  return typeof input.path === "string" ? input.path : undefined;
}

// ─── tool_result middleware: keep snapshots and anchors fresh ───────────────

async function annotateReadResult(
  event: { input: Record<string, unknown>; content: { type: string; text?: string }[] },
  ctx: ExtensionContext,
): Promise<{ content: { type: "text"; text: string }[] } | undefined> {
  const rawPath = inputPath(event.input);
  if (!rawPath) return undefined;
  // Only single-text-block results are plain file reads; skip images etc.
  if (event.content.length !== 1 || event.content[0]!.type !== "text") return undefined;
  const text = event.content[0]!.text ?? "";
  if (HEADER_LINE_RE.test(text)) return undefined; // already annotated (defensive)

  let raw: string;
  try {
    raw = await readFile(resolveModelPath(rawPath, ctx.cwd), "utf8");
  } catch {
    return undefined; // remote/unreadable — leave the built-in result untouched
  }
  const normalized = normalizeContent(raw);
  const absPath = resolveModelPath(rawPath, ctx.cwd);
  const tag = store.record(absPath, normalized);
  const lines = splitLines(normalized);
  const offset = typeof event.input.offset === "number" ? event.input.offset : 1;
  const startIndex = Math.max(0, offset - 1);
  const displayPath = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const annotated = annotateReadText(text, displayPath, tag, lines, startIndex);
  return { content: [{ type: "text", text: annotated }] };
}

async function refreshMutationAnchor(
  event: { input: Record<string, unknown>; content: { type: string; text?: string }[] },
  ctx: ExtensionContext,
): Promise<{ content: { type: "text"; text: string }[] } | undefined> {
  const rawPath = inputPath(event.input);
  if (!rawPath) return undefined;
  const absPath = resolveModelPath(rawPath, ctx.cwd);
  let raw: string;
  try {
    raw = await readFile(absPath, "utf8");
  } catch {
    return undefined;
  }
  const tag = store.record(absPath, normalizeContent(raw));
  const displayPath = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const blocks = event.content.map((block) =>
    block.type === "text" ? { type: "text" as const, text: block.text ?? "" } : undefined,
  );
  if (blocks.some((b) => b === undefined)) return undefined;
  const textBlocks = blocks as { type: "text"; text: string }[];
  const last = textBlocks[textBlocks.length - 1];
  if (!last) return undefined;
  if (HEADER_LINE_RE.test(last.text)) return undefined;
  last.text = `${last.text}\n[${displayPath}#${tag}]`;
  return { content: textBlocks };
}

// ─── hash_edit execution ────────────────────────────────────────────────────

interface PreparedSection {
  section: FileSection;
  absPath: string;
  /** Serialized new content; undefined when the section removes the file. */
  newContent?: string;
  newLines?: number;
}

function errorResult(message: string) {
  return { content: [{ type: "text" as const, text: message }], details: undefined, isError: true };
}

/** Read, verify, and compute one section. Throws HashlineError on any mismatch. */
async function prepareSection(section: FileSection, cwd: string): Promise<PreparedSection> {
  const absPath = resolveModelPath(section.path, cwd);
  const label = `[${section.path}#${section.tag}]`;

  let raw: string;
  try {
    raw = await readFile(absPath, "utf8");
  } catch {
    if (section.remove) throw new HashlineError(`${label}: file does not exist (already removed?)`);
    throw new HashlineError(`${label}: cannot read file. Create new files with the write tool; hash_edit only edits existing files.`);
  }

  const normalized = normalizeContent(raw);
  const liveTag = contentTag(normalized);
  if (liveTag !== section.tag) {
    const known = store.get(absPath);
    const detail =
      known && known.tag === section.tag
        ? "it changed on disk since your last read"
        : "it does not match your last read";
    throw new HashlineError(
      `${label}: stale anchor — ${detail}. Re-read the file and retry with fresh line numbers; never reuse an old #TAG.`,
    );
  }

  if (section.remove) return { section, absPath };

  const lines = splitLines(normalized);
  const newLines = applySectionOps(lines, section.ops, label);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const bom = raw.startsWith("\uFEFF");
  const trailing = hasTrailingNewline(normalized);
  const body = newLines.join(eol) + (newLines.length > 0 && trailing ? eol : "");
  return { section, absPath, newContent: (bom ? "\uFEFF" : "") + body, newLines: newLines.length };
}

async function executePatch(patch: string, ctx: ExtensionContext) {
  let sections: FileSection[];
  try {
    sections = parsePatch(patch);
  } catch (error) {
    return errorResult(`hash_edit parse error: ${(error as Error).message}`);
  }

  // Resolve and deduplicate; one section per file.
  const seen = new Map<string, FileSection>();
  for (const section of sections) {
    const absPath = resolveModelPath(section.path, ctx.cwd);
    if (seen.has(absPath)) return errorResult(`hash_edit: duplicate section for ${section.path}; merge its hunks into one section`);
    seen.set(absPath, section);
  }
  // Consistent lock order across concurrent hash_edit calls.
  const ordered = [...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

  // Queue the whole batch on every target path so parallel edit/write calls
  // cannot interleave between our verify and write phases. Preflight inside
  // the queues guarantees a partial batch never lands.
  const run = async (): Promise<ReturnType<typeof errorResult> | { content: { type: "text"; text: string }[]; details: undefined }> => {
    const prepared: PreparedSection[] = [];
    try {
      for (const [, section] of ordered) {
        prepared.push(await prepareSection(section, ctx.cwd));
      }
    } catch (error) {
      return errorResult(`hash_edit: ${(error as Error).message}`);
    }

    const report: string[] = [];
    for (const item of prepared) {
      const { section, absPath } = item;
      if (section.remove) {
        await unlink(absPath);
        store.drop(absPath);
        report.push(`[${section.path}] removed.`);
        continue;
      }
      await writeFile(absPath, item.newContent!, "utf8");
      const normalized = normalizeContent(item.newContent!);
      const tag = store.record(absPath, normalized);
      const hunks = section.ops.length;
      report.push(
        `[${section.path}#${tag}] applied ${hunks} ${hunks === 1 ? "hunk" : "hunk"}; now ${item.newLines} ${item.newLines === 1 ? "line" : "lines"}. The #TAG above is live; re-read for fresh line numbers before editing this file again.`,
      );
    }
    return { content: [{ type: "text" as const, text: report.join("\n") }], details: undefined };
  };

  // Nest mutation queues in sorted path order.
  let chain = run;
  for (const [absPath] of ordered) {
    const inner = chain;
    chain = () => withFileMutationQueue(absPath, inner);
  }
  return chain();
}

const DESCRIPTION = `Line-anchored patch language for editing existing files: name original lines/gaps to replace, insert, or cut, then list the new content. Old text is never reproduced — the range deletes it.

HEADERS
Every file section starts with \`[PATH#TAG]\`. TAG is the 4-hex anchor shown by your latest read/write/edit result for that file — REQUIRED on every section. Create new files with the write tool; hash_edit only edits existing files.

OPS
- \`PUT N.=M:\` — replace original lines N through M (INCLUSIVE) with the following + body rows. Single line: \`PUT N.=N:\`.
- \`PUT <N:\` / \`PUT >N:\` — insert body rows before / after line N (\`PUT <1:\` = file head, \`PUT >$:\` = file tail).
- \`CUT N.=M\` — delete original lines N through M.
- \`REM\` — delete the whole section file. Must be the section's only op.

BODY ROWS
Only under a \`:\` header. Every row is \`+TEXT\`, verbatim (leading whitespace kept); \`+\` alone = blank line. NEVER emit old/content rows — the range already deletes; the body is only the final content. Keep a line: leave it out of every range. Literal leading \`-\`/\`+\` keeps the prefix: \`- item\` → \`+- item\`, \`+ item\` → \`++ item\`.

RULES
- Line numbers + #TAG come from your latest read (\`N:TEXT\` rows); numbers name ORIGINAL lines and are never shifted by earlier hunks in the same patch.
- Applied edits renumber the file and change the #TAG — the result reports the fresh tag; take further line numbers from a fresh read.
- Ranges cover ONLY changed lines — never widen over keepers. Non-adjacent changes = separate hunks. Hunks must not overlap or anchor inside each other.
- Pure additions → \`PUT <N:\` / \`PUT >N:\`, never a widened \`PUT N.=M:\`.
- Multiple [PATH#TAG] sections may be batched; every section is verified before any write lands.
- A stale #TAG means the file changed since your last read: re-read it and retry with fresh numbers. Never guess or reuse tags.

EXAMPLE
read showed:
  [greet.py#A1B2]
  1:def greet(name):
  2:    msg = "Hello, " + name
  3:    print(msg)

patch:
  [greet.py#A1B2]
  PUT 2.=3:
  +    print(f"Hello, {name}")
  PUT >$:
  +
  +greet("world")`;

// ─── Extension entry ────────────────────────────────────────────────────────

export default function piSmartEdit(pi: ExtensionAPI): void {
  pi.registerTool({
    name: TOOL_NAME,
    label: "hash_edit",
    description: DESCRIPTION,
    promptSnippet: "Apply line-anchored patches to files you have read, using [path#TAG] sections and original line numbers",
    promptGuidelines: [
      "Use hash_edit for targeted edits to files you have already read: anchor each hunk to the N: line numbers and #TAG from the read result instead of reproducing old text.",
      "When hash_edit rejects a stale #TAG, re-read the file and retry with fresh line numbers; the file changed since your last read.",
    ],
    parameters: Type.Object({
      patch: Type.String({ description: "One or more [PATH#TAG] sections of hashline ops" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return executePatch(params.patch, ctx);
    },
  });

  // Keep anchors in front of the model: numbered [path#TAG] reads, and a fresh
  // tag appended to every successful write/edit so the next hash_edit has a
  // live anchor without an extra read.
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError) return undefined;
    try {
      if (isReadToolResult(event)) return await annotateReadResult(event, ctx);
      if (isWriteToolResult(event) || isEditToolResult(event)) return await refreshMutationAnchor(event, ctx);
    } catch {
      // Never break a tool result over annotation.
    }
    return undefined;
  });

  pi.on("session_start", () => {
    store.clear();
  });
}
