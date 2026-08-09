/**
 * pi-smart-edit — hashline core.
 *
 * A compact, line-anchored patch language inspired by oh-my-pi's `@oh-my-pi/hashline`
 * (see packages/pi-ui/ref/packages/hashline). Every file section binds to a
 * 4-hex content-hash tag recorded when the file was last read; the applier
 * re-reads the live file and rejects stale anchors before they corrupt code.
 *
 * This is a clean-room subset: section headers, `PUT N.=M:` / `PUT <N:` /
 * `PUT >N:` / `PUT >$:`, `CUT N.=M`, and `REM`. AST block ops (`PUT N*:`),
 * named registers/paste, and `MV` from the original format are intentionally
 * not supported and produce explicit parse errors.
 */

import { createHash } from "node:crypto";

// ─── Content normalization and tags ─────────────────────────────────────────

/** Normalize raw file text for hashing and line addressing: strip BOM, LF endings. */
export function normalizeContent(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/** 4-hex content tag. Only meaningful alongside the SnapshotStore that recorded it. */
export function contentTag(normalizedContent: string): string {
  return createHash("sha256").update(normalizedContent).digest("hex").slice(0, 4).toUpperCase();
}

/** Split normalized content into addressable lines (no phantom trailing line). */
export function splitLines(normalizedContent: string): string[] {
  if (normalizedContent === "") return [];
  const body = normalizedContent.endsWith("\n") ? normalizedContent.slice(0, -1) : normalizedContent;
  return body.split("\n");
}

/** Whether normalized content ends with a trailing newline. Empty files count as "yes". */
export function hasTrailingNewline(normalizedContent: string): boolean {
  return normalizedContent === "" || normalizedContent.endsWith("\n");
}

// ─── Snapshot store ─────────────────────────────────────────────────────────

export interface FileSnapshot {
  tag: string;
  /** Normalized full-file content observed at record time. */
  content: string;
}

/** Records the latest known content per resolved path and hands out tags. */
export class SnapshotStore {
  #byPath = new Map<string, FileSnapshot>();

  /** Record freshly observed normalized content; returns its tag. */
  record(resolvedPath: string, normalizedContent: string): string {
    const tag = contentTag(normalizedContent);
    this.#byPath.set(resolvedPath, { tag, content: normalizedContent });
    return tag;
  }

  get(resolvedPath: string): FileSnapshot | undefined {
    return this.#byPath.get(resolvedPath);
  }

  drop(resolvedPath: string): void {
    this.#byPath.delete(resolvedPath);
  }

  clear(): void {
    this.#byPath.clear();
  }
}

// ─── Patch model ────────────────────────────────────────────────────────────

export interface PutRangeOp {
  kind: "putRange";
  /** Inclusive original line range. */
  start: number;
  end: number;
  body: string[];
}

export interface InsertOp {
  kind: "insert";
  position: "before" | "after";
  /** Original line to anchor at; `line` is 1-based. `>$` is normalized to after=lineCount at apply time. */
  line: number | "$";
  body: string[];
}

export interface CutOp {
  kind: "cut";
  start: number;
  end: number;
}

export type SectionOp = PutRangeOp | InsertOp | CutOp;

export interface FileSection {
  /** Path exactly as written inside the header brackets. */
  path: string;
  tag: string;
  ops: SectionOp[];
  /** REM: delete the whole file. Must be the section's only op. */
  remove: boolean;
}

export class HashlineError extends Error {}

const HEADER_RE = /^\[(.+)#([0-9a-fA-F]{4})\]\s*$/;
const PUT_RANGE_RE = /^PUT (\d+)\.=(\d+):$/;
const PUT_GAP_RE = /^PUT ([<>])(\d+|\$):$/;
const CUT_RE = /^CUT (\d+)\.=(\d+)$/;
const REM_RE = /^REM$/;
const BODY_RE = /^\+(.*)$/;

/** Explicit errors for hashline constructs this subset does not implement. */
function unsupportedOp(line: string): string | undefined {
  if (/^PUT \d+\*:/.test(line) || /^PUT >\d+\*:/.test(line) || /^CUT \d+\*$/.test(line)) {
    return "block ops (PUT N*: / CUT N*) are not supported by pi-smart-edit; use an explicit PUT N.=M: / CUT N.=M range";
  }
  if (/^MV\s/.test(line)) {
    return "MV is not supported by pi-smart-edit; move the file with bash and re-read it";
  }
  if (/\s@\S+$/.test(line) || /^PUT [<>]\d+$/.test(line) || /^PUT \d+\.=\d+\s/.test(line)) {
    return "named registers / paste are not supported by pi-smart-edit; inline the moved text as + body rows";
  }
  return undefined;
}

/**
 * Parse a hashline patch into file sections. Throws HashlineError with a
 * model-actionable message on malformed input.
 */
export function parsePatch(patch: string): FileSection[] {
  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  const sections: FileSection[] = [];
  let section: FileSection | undefined;
  let pendingBody: { body: string[] } | undefined;

  const closeBody = () => {
    pendingBody = undefined;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const where = `line ${index + 1}`;

    // Skip blank lines between sections/ops (never inside a body — a blank
    // body row must be written as a bare "+").
    if (line.trim() === "" && pendingBody === undefined) continue;

    const header = HEADER_RE.exec(line);
    if (header) {
      closeBody();
      section = { path: header[1]!.trim(), tag: header[2]!.toUpperCase(), ops: [], remove: false };
      sections.push(section);
      continue;
    }

    const body = BODY_RE.exec(line);
    if (body) {
      if (!pendingBody) throw new HashlineError(`${where}: body row "${line}" without a preceding "PUT ...:" header`);
      pendingBody.body.push(body[1]!);
      continue;
    }

    if (!section) {
      throw new HashlineError(
        `${where}: expected a [PATH#TAG] section header, got "${line}". Take PATH and TAG from your latest read result.`,
      );
    }

    closeBody();

    const putRange = PUT_RANGE_RE.exec(line);
    if (putRange) {
      const start = Number(putRange[1]);
      const end = Number(putRange[2]);
      if (start < 1 || end < start) throw new HashlineError(`${where}: invalid range ${start}.=${end}`);
      const op: PutRangeOp = { kind: "putRange", start, end, body: [] };
      section.ops.push(op);
      pendingBody = op;
      continue;
    }

    const putGap = PUT_GAP_RE.exec(line);
    if (putGap) {
      const raw = putGap[2]!;
      const lineNo = raw === "$" ? ("$" as const) : Number(raw);
      if (lineNo !== "$" && lineNo < 1) throw new HashlineError(`${where}: invalid gap anchor ${line}`);
      const op: InsertOp = { kind: "insert", position: putGap[1] === "<" ? "before" : "after", line: lineNo, body: [] };
      if (lineNo === "$" && op.position === "before") throw new HashlineError(`${where}: PUT <$: is not a thing; use PUT <1: for head or PUT >$: for tail`);
      section.ops.push(op);
      pendingBody = op;
      continue;
    }

    const cut = CUT_RE.exec(line);
    if (cut) {
      const start = Number(cut[1]);
      const end = Number(cut[2]);
      if (start < 1 || end < start) throw new HashlineError(`${where}: invalid range ${start}.=${end}`);
      section.ops.push({ kind: "cut", start, end });
      continue;
    }

    if (REM_RE.test(line)) {
      section.remove = true;
      continue;
    }

    const hint = unsupportedOp(line);
    if (hint) throw new HashlineError(`${where}: ${hint}`);
    throw new HashlineError(`${where}: unrecognized op "${line}". Expected PUT N.=M:, PUT <N:, PUT >N:, PUT >$:, CUT N.=M, REM, or + body rows.`);
  }

  if (sections.length === 0) {
    throw new HashlineError("empty patch: expected at least one [PATH#TAG] section");
  }
  for (const sec of sections) {
    if (sec.remove && sec.ops.length > 0) {
      throw new HashlineError(`[${sec.path}#${sec.tag}]: REM must be the section's only op`);
    }
    if (!sec.remove && sec.ops.length === 0) {
      throw new HashlineError(`[${sec.path}#${sec.tag}]: section has no ops`);
    }
  }
  return sections;
}

// ─── Applier ────────────────────────────────────────────────────────────────

/**
 * Apply a section's ops to original lines. Line numbers always address the
 * ORIGINAL array; earlier hunks never shift later ones. Throws HashlineError
 * on out-of-range anchors or overlapping hunks.
 */
export function applySectionOps(originalLines: readonly string[], ops: readonly SectionOp[], label: string): string[] {
  const lineCount = originalLines.length;

  // Empty file: no line can anchor a range or gap; every op must be an insert,
  // and all insert bodies concatenate in op order.
  if (lineCount === 0) {
    const out: string[] = [];
    for (const op of ops) {
      if (op.kind !== "insert") {
        throw new HashlineError(`${label}: file is empty; only PUT <1: / PUT >$: inserts are valid`);
      }
      out.push(...op.body);
    }
    return out;
  }

  const replacements: { start: number; end: number; body: string[] }[] = [];
  const cuts: { start: number; end: number }[] = [];
  const insertsBefore = new Map<number, string[][]>();
  const insertsAfter = new Map<number, string[][]>();

  const pushInsert = (map: Map<number, string[][]>, line: number, body: string[]) => {
    const list = map.get(line) ?? [];
    list.push(body);
    map.set(line, list);
  };

  for (const op of ops) {
    if (op.kind === "putRange") {
      if (op.end > lineCount) {
        throw new HashlineError(`${label}: PUT ${op.start}.=${op.end}: exceeds file length (${lineCount} lines); re-read the file`);
      }
      replacements.push({ start: op.start, end: op.end, body: op.body });
    } else if (op.kind === "cut") {
      if (op.end > lineCount) {
        throw new HashlineError(`${label}: CUT ${op.start}.=${op.end} exceeds file length (${lineCount} lines); re-read the file`);
      }
      cuts.push({ start: op.start, end: op.end });
    } else {
      const anchor = op.line === "$" ? lineCount : op.line;
      if (anchor < 1 || anchor > lineCount) {
        throw new HashlineError(`${label}: PUT ${op.position === "before" ? "<" : ">"}${op.line}: no such line in a ${lineCount}-line file; re-read the file`);
      }
      if (op.position === "before") pushInsert(insertsBefore, anchor, op.body);
      else pushInsert(insertsAfter, anchor, op.body);
    }
  }

  // Overlap check: ranges (replacements + cuts) must be disjoint.
  const ranges = [...replacements, ...cuts].sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i]!.start <= ranges[i - 1]!.end) {
      throw new HashlineError(
        `${label}: overlapping hunks at original lines ${ranges[i - 1]!.start}.=${ranges[i - 1]!.end} and ${ranges[i]!.start}.=${ranges[i]!.end}; merge or split them`,
      );
    }
  }
  // Gap-semantic conflict check: `<N` anchors the gap BEFORE line N, `>N` the
  // gap AFTER line N. A gap swallowed by a replaced/cut range conflicts, but a
  // gap at a range boundary survives (before the start / after the end).
  const gapConflicts = (line: number, position: "before" | "after") =>
    ranges.some((r) => (position === "after" ? line >= r.start && line < r.end : line > r.start && line <= r.end));
  for (const [line] of insertsBefore) {
    if (gapConflicts(line, "before")) {
      throw new HashlineError(`${label}: PUT <${line}: anchors a gap swallowed by a replaced/deleted range; anchor at the range boundary instead`);
    }
  }
  for (const [line] of insertsAfter) {
    if (gapConflicts(line, "after")) {
      throw new HashlineError(`${label}: PUT >${line}: anchors a gap swallowed by a replaced/deleted range; anchor at the range boundary instead`);
    }
  }

  const replacementAt = new Map(replacements.map((r) => [r.start, r]));
  const cutAt = new Map(cuts.map((c) => [c.start, c]));

  const out: string[] = [];
  let i = 1;
  while (i <= lineCount) {
    for (const body of insertsBefore.get(i) ?? []) out.push(...body);
    const replacement = replacementAt.get(i);
    if (replacement) {
      out.push(...replacement.body);
      // The gap after the range's last line survives: emit its inserts now.
      for (const body of insertsAfter.get(replacement.end) ?? []) out.push(...body);
      i = replacement.end + 1;
      continue;
    }
    const cut = cutAt.get(i);
    if (cut) {
      for (const body of insertsAfter.get(cut.end) ?? []) out.push(...body);
      i = cut.end + 1;
      continue;
    }
    out.push(originalLines[i - 1]!);
    for (const body of insertsAfter.get(i) ?? []) out.push(...body);
    i++;
  }
  return out;
}

// ─── Read-result line numbering ─────────────────────────────────────────────

/**
 * Count how many file lines (from `fileLines[startIndex]` onward) form a
 * prefix of `displayedText`. Built-in read output is exactly a joined slice of
 * the file plus an optional trailing "[...]" continuation notice, so walking
 * line by line recovers the displayed line count deterministically — including
 * when truncation cut the slice short.
 */
export function matchDisplayedLineCount(displayedText: string, fileLines: readonly string[], startIndex: number): number {
  let count = 0;
  let pos = 0;
  while (startIndex + count < fileLines.length) {
    const line = fileLines[startIndex + count]!;
    if (count === 0) {
      if (!displayedText.startsWith(line)) break;
      pos = line.length;
    } else {
      if (!displayedText.startsWith(`\n${line}`, pos)) break;
      pos += 1 + line.length;
    }
    count++;
  }
  return count;
}

/** Prepend `[path#TAG]` and number the displayed lines, keeping any trailing notice verbatim. */
export function annotateReadText(displayedText: string, displayPath: string, tag: string, fileLines: readonly string[], startIndex: number): string {
  const count = matchDisplayedLineCount(displayedText, fileLines, startIndex);
  if (count === 0) return `[${displayPath}#${tag}]\n${displayedText}`;
  let consumed = 0;
  for (let i = 0; i < count; i++) consumed += fileLines[startIndex + i]!.length + (i > 0 ? 1 : 0);
  const numbered: string[] = [];
  for (let i = 0; i < count; i++) {
    numbered.push(`${startIndex + i + 1}:${fileLines[startIndex + i]!}`);
  }
  const remainder = displayedText.slice(consumed);
  return `[${displayPath}#${tag}]\n${numbered.join("\n")}${remainder}`;
}
