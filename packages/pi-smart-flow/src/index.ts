/**
 * pi-smart-flow — Extension entry point
 *
 * A lightweight delegation experience layer on top of pi-subagents:
 *
 * - nudge.ts     appends delegation guidance to the system prompt (only when
 *                the subagent tool is active)
 * - bash-bg.ts   adaptive foreground/background shell with job control
 * - observe.ts   blocking status/wait/watch over observation providers
 *
 *   pi -e ./src/index.ts
 *   pi install npm:@NekoSekaiMoe/pi-smart-flow
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDelegationNudge } from "./nudge.ts";
import { registerBashBg } from "./bash-bg.ts";
import { registerObserve } from "./observe.ts";

export default function (pi: ExtensionAPI): void {
  registerDelegationNudge(pi);
  registerBashBg(pi);
  registerObserve(pi);
}
