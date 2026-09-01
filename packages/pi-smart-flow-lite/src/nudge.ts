/**
 * pi-smart-flow — Delegation nudge (slimmed)
 *
 * Appends a compact delegation guidance block to the system prompt on
 * `before_agent_start`, but only when `subagent_spawn` (pi-subagents) is
 * actually active — otherwise the guidance would point at a tool the
 * model cannot call.
 *
 * Slimmed 2026-09: bullets already covered by pi-subagents' own tool
 * guidelines (work-inline-when, async-first, role picking, file-only
 * outputMode) were removed; only the unique guidance remains.
 * ~90 tokens (was ~250). Original in nudge.ts.bak.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * The injected guidance. Keep this short, stable, and cache-friendly:
 * it is appended verbatim on every agent start, so any change invalidates
 * the prompt cache prefix for the whole session.
 */
const DELEGATION_GUIDANCE = `<delegation_guidance>
Delegate via subagent_spawn to keep this main context clean.

Delegate when:
- Exploration spans multiple files/modules, or bulk output (logs, large files, test runs) would flood this context.

Write each task as a compact contract: GOAL, CONTEXT (files/decisions/constraints), EXPECTED OUTPUT (shape and where), STOP RULES (when to report back or ask).
Never edit files an async worker is changing; run parallel writers only in isolated worktrees.
After three failed attempts at the same problem, stop — delegate a fresh investigation or ask the user for direction.
</delegation_guidance>`;

/** Set PI_SMART_FLOW_NUDGE=0 to disable the nudge. */
function nudgeEnabled(): boolean {
  return process.env.PI_SMART_FLOW_NUDGE !== "0";
}

export function registerDelegationNudge(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    if (!nudgeEnabled()) return;
    if (!pi.getActiveTools().includes("subagent_spawn")) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${DELEGATION_GUIDANCE}`,
    };
  });
}
