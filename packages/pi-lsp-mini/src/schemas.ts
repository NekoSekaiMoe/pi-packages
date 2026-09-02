import { Type } from "typebox";

/** Shared, token-lean parameter schemas + tool texts (measured: see README). */

const POSITION = {
  path: Type.String(),
  line: Type.Number({ description: "1-based line" }),
  character: Type.Number({ description: "1-based column" }),
};

export const DIAGNOSTICS = {
  description: "LSP errors/warnings for a file or directory. Omit path to scan cwd.",
  promptSnippet: "Check code errors via LSP",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "file or dir (default .)" })),
    severity: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("information")], { description: "min severity (default warning)" })),
  }),
};

export const REFERENCES = {
  description: "All references (usages) of the symbol at a 1-based line/column.",
  promptSnippet: "Find all usages of a symbol",
  parameters: Type.Object({ ...POSITION }),
};

export const CALLGRAPH = {
  description: "Call relations of the function at a 1-based position: callers and callees, recursive.",
  promptSnippet: "Trace callers/callees of a function",
  parameters: Type.Object({
    ...POSITION,
    direction: Type.Optional(Type.Union([Type.Literal("incoming"), Type.Literal("outgoing"), Type.Literal("both")], { description: "default both" })),
    depth: Type.Optional(Type.Number({ description: "1-4, default 2" })),
  }),
};

export const RENAME = {
  description: "Rename a symbol across the workspace (scope-aware batch replace). apply=false previews.",
  promptSnippet: "Rename a symbol workspace-wide",
  parameters: Type.Object({
    ...POSITION,
    newName: Type.String(),
    apply: Type.Optional(Type.Boolean({ description: "default true" })),
  }),
};

export const DELETE = {
  description: "Delete a function and its standalone call-statement lines; other usages are listed as manual. Dry-run unless apply=true.",
  promptSnippet: "Delete a function and its call sites",
  parameters: Type.Object({
    ...POSITION,
    apply: Type.Optional(Type.Boolean({ description: "default false" })),
  }),
};
