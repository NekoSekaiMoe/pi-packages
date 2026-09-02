import type { Location, Position, TextEdit, WorkspaceEdit } from "./lsp-types.ts";
import { uriToFilePath } from "./client.ts";

// ---------------------------------------------------------------------------
// WorkspaceEdit -> per-file TextEdits
// ---------------------------------------------------------------------------

export interface FileEdit {
  file: string;
  edits: TextEdit[];
}

/** Flattens a WorkspaceEdit into per-file TextEdit lists; collects unsupported ops (file create/rename/delete). */
export function normalizeWorkspaceEdit(ws: WorkspaceEdit | null): { fileEdits: FileEdit[]; skipped: string[] } {
  const byFile = new Map<string, TextEdit[]>();
  const skipped: string[] = [];
  if (!ws) return { fileEdits: [], skipped };

  for (const [uri, edits] of Object.entries(ws.changes ?? {})) {
    if (!Array.isArray(edits) || edits.length === 0) continue;
    const file = uriToFilePath(uri);
    byFile.set(file, [...(byFile.get(file) ?? []), ...edits]);
  }

  for (const change of ws.documentChanges ?? []) {
    const kind = (change as { kind?: string }).kind;
    if (kind && kind !== "edit") {
      const c = change as { uri?: string; oldUri?: string };
      skipped.push(`${kind}: ${c.oldUri ?? c.uri ?? ""}`);
      continue;
    }
    const e = change as { textDocument?: { uri: string }; edits?: TextEdit[] };
    if (!e.textDocument?.uri || !Array.isArray(e.edits) || e.edits.length === 0) continue;
    const file = uriToFilePath(e.textDocument.uri);
    byFile.set(file, [...(byFile.get(file) ?? []), ...e.edits]);
  }

  return { fileEdits: [...byFile.entries()].map(([file, edits]) => ({ file, edits })), skipped };
}

// ---------------------------------------------------------------------------
// TextEdit application (UTF-16 aware, CRLF preserving)
// ---------------------------------------------------------------------------

function posCmp(a: Position, b: Position): number {
  return a.line - b.line || a.character - b.character;
}

function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? "\r\n" : "\n";
}

function overlaps(a: TextEdit, b: TextEdit): boolean {
  // inclusive-range overlap test on [start, end]
  return posCmp(a.range.start, b.range.end) <= 0 && posCmp(b.range.start, a.range.end) <= 0;
}

/** Applies LSP TextEdits to file text, bottom-up. Later (lower) overlapping edits win; content preserved as LF/CRLF. */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  if (edits.length === 0) return text;
  const eol = dominantEol(text);
  const lines = text.split(/\r?\n/);
  const sorted = [...edits].sort((a, b) => posCmp(a.range.start, b.range.start));
  const applied: TextEdit[] = [];

  for (let i = sorted.length - 1; i >= 0; i--) {
    const edit = sorted[i];
    if (applied.some((done) => overlaps(done, edit))) continue; // already covered by a later edit
    applied.push(edit);

    const { start, end } = edit.range;
    const first = lines[start.line] ?? "";
    const last = lines[end.line] ?? "";
    const replaced = first.slice(0, start.character) + edit.newText + last.slice(end.character);
    lines.splice(start.line, end.line - start.line + 1, ...replaced.split("\n"));
  }
  return lines.join(eol);
}

// ---------------------------------------------------------------------------
// Symbol deletion planning
// ---------------------------------------------------------------------------

export interface LineRange {
  start: number; // 0-based, inclusive
  end: number;   // 0-based, inclusive
}

export type UsagePlan =
  | { kind: "delete"; location: Location; lines: LineRange }
  | { kind: "manual"; location: Location; snippet: string };


/**
 * Decides whether a usage is a standalone call statement (optionally `await/defer/go` prefixed)
 * whose whole line range can be removed. Everything else (assignments, arguments, returns,
 * callbacks, decorators) is flagged manual.
 */
export function planUsage(lines: string[], location: Location): UsagePlan {
  const { range } = location;
  const startLine = range.start.line;
  const line = lines[startLine] ?? "";
  const manual = (): UsagePlan => ({ kind: "manual", location, snippet: line.trim().slice(0, 120) });

  // Only indentation + call keywords may precede the symbol on its line
  const before = line.slice(0, range.start.character);
  if (!/^\s*(?:(?:await|defer|go)\s+)*$/.test(before)) return manual();

  // Must be an actual call: symbol followed by `(` (or `[` for Go generics).
  // (Method receivers like `x.foo` are already excluded because only whitespace
  // plus await/defer/go keywords may precede the symbol.)
  const after = line.slice(range.end.character);
  if (!/^\s*[([]/.test(after)) return manual();

  // Extend from the symbol to the closing paren of the call (multi-line argument lists), cap 30 lines
  let depth = 0;
  let sawOpen = false;
  let closeLine = -1;
  let closeChar = -1;
  for (let i = startLine; i < Math.min(lines.length, startLine + 30); i++) {
    const text = lines[i] ?? "";
    for (let c = i === startLine ? range.end.character : 0; c < text.length; c++) {
      const ch = text[c];
      if (ch === "(" || ch === "[") {
        depth++;
        sawOpen = true;
      } else if (ch === ")" || ch === "]") {
        depth--;
        if (sawOpen && depth <= 0) {
          closeLine = i;
          closeChar = c;
          break;
        }
      }
    }
    if (closeLine >= 0) break;
  }
  if (!sawOpen || closeLine < 0) return manual();

  // Trailing text after the closing paren must be inert (statement ends there)
  const tail = (lines[closeLine] ?? "").slice(closeChar + 1);
  if (!/^[\s;)\],:]*$/.test(tail)) return manual();

  return { kind: "delete", location, lines: { start: startLine, end: closeLine } };
}

/** Extends a declaration range upward over directly-attached comments / decorators. */
export function expandOverDocLines(lines: string[], range: LineRange): LineRange {
  let start = range.start;
  while (start > 0) {
    const t = (lines[start - 1] ?? "").trimStart();
    if (t.startsWith("#") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("@")) start--;
    else break;
  }
  return { start, end: range.end };
}

/** Merges overlapping / adjacent 0-based inclusive line ranges; collapses double blanks left between them. */
export function mergeLineRanges(lines: string[], ranges: LineRange[]): LineRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  // avoid leaving double blank lines behind: if both neighbours of a removal are blank, eat the one below
  for (const range of merged) {
    const above = lines[range.start - 1];
    const below = lines[range.end + 1];
    if (above !== undefined && above.trim() === "" && below !== undefined && below.trim() === "") range.end += 1;
  }
  return merged;
}

/** Removes 0-based inclusive line ranges from a line array (applies bottom-up). */
export function applyLineRangeDeletes(lines: string[], ranges: LineRange[]): string[] {
  const out = [...lines];
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    out.splice(range.start, range.end - range.start + 1);
  }
  return out;
}
