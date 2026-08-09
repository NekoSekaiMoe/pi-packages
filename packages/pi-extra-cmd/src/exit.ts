/**
 * pi-extra-cmd — /exit command
 *
 * Registers an `/exit` command that gracefully shuts pi down.
 *
 * Pi ships a built-in `/quit` command, but muscle memory from other shells and
 * REPLs (bash, python, node, psql, ...) reaches for `/exit`. This command
 * makes that work too, delegating to the same graceful-shutdown path `/quit`
 * uses (`ctx.shutdown()`), which fires the `session_shutdown` event so other
 * extensions can flush their state before the process exits.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerExit(pi: ExtensionAPI) {
  pi.registerCommand("exit", {
    description: "Quit pi (alias for /quit)",
    handler: async (_args, ctx) => {
      // Gracefully shutdown pi and exit. Available in all contexts.
      // This is the same path /quit takes and emits session_shutdown.
      ctx.shutdown();
    },
  });
}
