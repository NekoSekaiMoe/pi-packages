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
 * The alias is only declared to models whose API we impersonate as Codex
 * (`openai-responses`, `openai-codex-responses`). On every session start and
 * model switch we remove it from the active tool set when the current model
 * speaks another protocol, and re-add it when switching back (but only when we
 * were the ones who removed it, so an explicit user deactivation sticks). The
 * tool stays registered and callable in both states; only the model-facing
 * declaration is gated.
 *
 * This is unrelated to the header/body Codex impersonation in `index.ts`; it
 * lives in this package purely as a packaging decision.
 */

import { createEditToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** APIs whose traffic we impersonate as Codex CLI — `apply_patch` rides along. */
export const CODEX_APIS = new Set(["openai-responses", "openai-codex-responses"]);

/** Register the `apply_patch` editing alias, scoped to Codex-impersonated APIs. */
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

  // `removedByUs` distinguishes "inactive because we hid it for this model"
  // from "inactive because the user turned it off": we only re-add the former.
  let removedByUs = false;

  const sync = (model: { api?: string } | undefined): void => {
    const wanted = !!model?.api && CODEX_APIS.has(model.api);
    const active = pi.getActiveTools();
    const has = active.includes("apply_patch");
    if (!wanted && has) {
      pi.setActiveTools(active.filter((name) => name !== "apply_patch"));
      removedByUs = true;
    } else if (wanted && !has && removedByUs) {
      pi.setActiveTools([...active, "apply_patch"]);
      removedByUs = false;
    }
  };

  // Fires after the tool registry is bound: hides the alias when the session's
  // model is not a Codex-impersonated Responses API.
  pi.on("session_start", (_event, ctx) => sync(ctx.model));
  // Fires on /model switches and programmatic setModel().
  pi.on("model_select", (event) => sync(event.model));
}
