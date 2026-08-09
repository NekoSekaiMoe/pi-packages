/**
 * pi-extra-cmd — Extension entry point
 *
 * A bundle of small extra slash commands for Pi:
 *
 *   /exit                       gracefully quit pi (alias for /quit)
 *   /init [instructions]        generate an AGENTS.md contributor guide
 *   /context                    show context-window usage and composition
 *
 * Usage:
 *   pi -e ./src/index.ts
 *   pi install npm:@NekoSekaiMoe/pi-extra-cmd
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContext } from "./context.ts";
import { registerExit } from "./exit.ts";
import { registerInit } from "./init.ts";

export default function (pi: ExtensionAPI) {
  registerExit(pi);
  registerInit(pi);
  registerContext(pi);
}
