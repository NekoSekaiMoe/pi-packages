/**
 * pi-smart-flow — Extension entry point
 *
 * A lightweight delegation experience layer on top of pi-subagents:
 *
 * - nudge.ts     appends delegation guidance to the system prompt (only when
 *                the subagent tool is active)
 * - bash-bg.ts   adaptive foreground/background shell with job control
 * - observe.ts   blocking status/wait/watch over observation providers
 * - compact-thinking.ts   hides raw thinking blocks and shows a ≤3-line
 *                summary instead (toggle: /compact-thinking)
 *
 *   pi -e ./src/index.ts
 *   pi install npm:@NekoSekaiMoe/pi-smart-flow
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCompactThinking } from "./compact-thinking.ts";
import { registerDelegationNudge } from "./nudge.ts";
import { registerBashBg } from "./bash-bg.ts";

export default function (pi: ExtensionAPI): void {
  registerDelegationNudge(pi);
  registerBashBg(pi);
  // observe removed 2026-09: no other observation providers exist; bash_bg wait covers it (-659 tokens)
  registerCompactThinking(pi);
}
