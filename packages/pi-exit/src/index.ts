/**
 * pi-exit — Extension entry point
 *
 * Registers an `/exit` command that gracefully shuts pi down.
 *
 * Pi ships a built-in `/quit` command, but muscle memory from other shells and
 * REPLs (bash, python, node, psql, ...) reaches for `/exit`. This extension
 * makes that work too, delegating to the same graceful-shutdown path `/quit`
 * uses (`ctx.shutdown()`), which fires the `session_shutdown` event so other
 * extensions can flush their state before the process exits.
 *
 * Usage:
 *   pi -e ./src/index.ts
 *   pi install npm:@NekoSekaiMoe/pi-exit
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("exit", {
    description: "Quit pi (alias for /quit)",
    handler: async (_args, ctx) => {
      // Gracefully shutdown pi and exit. Available in all contexts.
      // This is the same path /quit takes and emits session_shutdown.
      ctx.shutdown();
    },
  });
}
