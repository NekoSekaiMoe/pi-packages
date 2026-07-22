/**
 * pi-fake-codex — Header construction
 *
 * Pure helpers that build the identity headers an official OpenAI Codex CLI
 * (codex_cli_rs) would send. Kept separate from the extension factory so the
 * values are easy to read and update without touching pi plumbing.
 *
 * Scope: both OpenAI Responses-style APIs — `model.api === "openai-responses"` and
 * `"openai-codex-responses"`. For openai-codex-responses, pi-ai's
 * buildBaseCodexHeaders() hard-codes `originator: "pi"` and a `pi (...)`
 * User-Agent; for openai-responses the OpenAI SDK supplies its own defaults. This
 * extension overwrites both with the values the real Codex CLI sends, so requests
 * to third-party providers that fingerprint the client look like Codex.
 *
 * Values are derived from the Codex source:
 *   - DEFAULT_ORIGINATOR = "codex_cli_rs"
 *       (codex-rs/login/src/auth/default_client.rs)
 *   - User-Agent format from get_codex_user_agent():
 *       "{originator}/{version} ({os_type} {os_version}; {arch}) {terminal}"
 *   - version: latest Codex CLI release at time of writing (0.145.0)
 *
 * Only `originator` and `User-Agent` are touched. pi's other Codex headers
 * (Authorization, chatgpt-account-id, OpenAI-Beta, session-id, ...) are left
 * exactly as pi-ai sets them.
 *
 * The User-Agent imitates the real client's layout. Characters outside the
 * printable ASCII range are replaced with `_`, mirroring Codex's
 * sanitize_user_agent().
 */

/**
 * Default Codex originator (the client identifier sent in the `originator` header).
 *
 * pi-ai's openai-codex-responses path sets `originator: "pi"`; this constant is
 * the value the official Codex CLI (codex_cli_rs) uses instead.
 */
export const CODEX_ORIGINATOR = "codex_cli_rs";

/**
 * Codex CLI version to impersonate.
 *
 * Pinned to the latest rust release tag at time of writing. Override at runtime
 * with the `PI_FAKE_CODEX_VERSION` env var for testing newer/older versions.
 */
export const DEFAULT_CODEX_VERSION = "0.145.0";

/** Codex terminal/platform descriptor appended after the OS segment. */
export const CODEX_TERMINAL = "unknown";

/**
 * Build the value for Codex's `originator` header.
 *
 * Honors Codex's own override env var (`CODEX_INTERNAL_ORIGINATOR_OVERRIDE`)
 * so tests/users can redirect to a non-default originator exactly like the
 * real client would.
 */
export function buildOriginator(): string {
  const override = process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  return override && override.trim() !== "" ? override : CODEX_ORIGINATOR;
}

/**
 * Build a Codex-style User-Agent string.
 *
 * Format matches get_codex_user_agent():
 *   "{originator}/{version} ({osType} {osVersion}; {arch}) {terminal}"
 *
 * Defaults can be overridden via env vars for testing:
 *   - PI_FAKE_CODEX_VERSION     — version segment
 *   - PI_FAKE_CODEX_OS_TYPE     — OS type segment (e.g. "Linux", "Mac OS")
 *   - PI_FAKE_CODEX_OS_VERSION  — OS version segment (e.g. kernel/build)
 *   - PI_FAKE_CODEX_ARCH        — architecture segment (e.g. "x86_64")
 *   - PI_FAKE_CODEX_TERMINAL    — terminal descriptor segment
 */
export function buildUserAgent(): string {
  const originator = buildOriginator();
  const version =
    process.env.PI_FAKE_CODEX_VERSION?.trim() || DEFAULT_CODEX_VERSION;
  const osType =
    process.env.PI_FAKE_CODEX_OS_TYPE?.trim() || detectOsType();
  const osVersion =
    process.env.PI_FAKE_CODEX_OS_VERSION?.trim() || detectOsVersion();
  const arch = process.env.PI_FAKE_CODEX_ARCH?.trim() || process.arch;
  const terminal =
    process.env.PI_FAKE_CODEX_TERMINAL?.trim() || CODEX_TERMINAL;

  const candidate = `${originator}/${version} (${osType} ${osVersion}; ${arch}) ${terminal}`;
  return sanitizeUserAgent(candidate);
}

/**
 * Replace non-printable-ASCII characters with `_`, mirroring Codex's
 * sanitize_user_agent() fallback. Printable ASCII (0x20..0x7E) is kept as-is.
 */
function sanitizeUserAgent(candidate: string): string {
  let sanitized = "";
  for (const ch of candidate) {
    const code = ch.codePointAt(0)!;
    sanitized += code >= 0x20 && code <= 0x7e ? ch : "_";
  }
  return sanitized;
}

/** Best-effort OS type label matching the `os_info` crate's output. */
function detectOsType(): string {
  switch (process.platform) {
    case "linux":
      return "Linux";
    case "darwin":
      return "Mac OS";
    case "win32":
      return "Windows";
    default:
      return process.platform;
  }
}

/**
 * Best-effort OS version string.
 *
 * The real Codex uses the `os_info` crate, which on Linux reports the kernel
 * release (`uname -r`). Node doesn't expose that portably, so we fall back to
 * `process.version`; this segment is rarely inspected server-side.
 */
function detectOsVersion(): string {
  return process.version;
}
