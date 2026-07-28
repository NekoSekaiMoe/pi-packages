/**
 * pi-fake-codex — `apply_patch` editing tool alias
 *
 * Registers an LLM-callable `apply_patch` tool with the exact same parameter
 * schema, exact-replacement behavior, file mutation queue, and result renderer
 * as Pi's built-in `edit` tool — just under the name `apply_patch`. Built on
 * top of `createEditToolDefinition()` so behavior is identical to `edit`;
 * only the tool name, prompt snippet, and prompt guidelines differ.
 *
 * Useful for agents whose editing instructions are written against an
 * `apply_patch`-named tool (e.g. Codex-style prompts), and as an alias that
 * accepts `path` + one-or-more `edits[].oldText` / `edits[].newText` pairs
 * rather than unified-diff text.
 *
 * This is unrelated to the header/body Codex impersonation in `index.ts`; it
 * lives in this package purely as a packaging decision. It is registered as a
 * plain tool and can be ignored by anyone who only wants the impersonation.
 */

import { createEditToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Register the `apply_patch` editing alias on the given extension API. */
export function registerApplyPatchTool(pi: ExtensionAPI): void {
  const edit = createEditToolDefinition(process.cwd());
  pi.registerTool({
    ...edit,
    name: "apply_patch",
    label: "apply_patch",
    promptSnippet:
      "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    promptGuidelines: [
      "Use apply_patch for precise changes (edits[].oldText must match exactly)",
      "When changing multiple separate locations in one file, use one apply_patch call with multiple entries in edits[] instead of multiple calls",
      "Each apply_patch edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
      "Keep apply_patch edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
    ],
  });
}
