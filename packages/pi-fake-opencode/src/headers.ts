/**
 * pi-fake-opencode — Identity header construction
 *
 * Pure helpers that build the identity headers the official OpenCode client
 * sends to the OpenCode Zen gateway, plus the scoping logic that decides
 * which requests get the treatment. Kept separate from the extension factory
 * so the values are easy to read and update without touching pi plumbing.
 *
 * OpenCode Zen's free tier rejects requests that do not look like they come
 * from the official OpenCode app:
 *
 *   Error: OpenAI API error (403):
 *   {"type":"FreeTierError","message":"Error from provider (Console):
 *    OpenCode's free tier can only be used from within OpenCode"}
 *
 * Verified against the live gateway (see README for the full experiment):
 *
 *   PASS  User-Agent: opencode/{recent version}
 *         x-opencode-session: ses_{26 chars of [0-9A-Za-z]}
 *   FAIL  any other User-Agent (including pi's, `opencode-foo/1.2`, bare
 *         `opencode`)                          -> FreeTierError
 *   FAIL  malformed session ids (short / no `ses_` prefix) -> FreeTierError
 *   FAIL  old versions (e.g. `opencode/0.6.9`) -> UpgradeRequired
 *
 * The other headers the real client sends (`x-opencode-request`,
 * `x-opencode-client`) are not checked by the gateway today, but we send
 * faithful values anyway so traffic is indistinguishable from real OpenCode.
 *
 * Reference: opencode's `packages/opencode/src/session/llm/request.ts`
 * (headers for providers whose id starts with "opencode") and
 * `packages/schema/src/identifier.ts` (ID format).
 */

/**
 * OpenCode client version to impersonate.
 *
 * The gateway rejects too-old versions with `UpgradeRequired`, so this must
 * track a recent OpenCode release. Override at runtime with the
 * `PI_FAKE_OPENCODE_VERSION` env var, or replace the whole User-Agent via
 * `PI_FAKE_OPENCODE_UA`, when the gateway starts rejecting older
 * fingerprints.
 */
export const DEFAULT_OPENCODE_VERSION = "1.18.31";

/**
 * pi provider ids that target OpenCode infrastructure.
 *
 * - `opencode`     — pi's built-in "OpenCode Zen" provider (OPENCODE_API_KEY)
 * - `opencode-go`  — pi's built-in "OpenCode Go" provider (OPENCODE_API_KEY)
 */
export const OPENCODE_PROVIDER_IDS = new Set(["opencode", "opencode-go"]);

/** Base-URL substring that marks a custom provider as pointing at Zen. */
export const OPENCODE_BASEURL_MARKER = "opencode.ai";

const IDENTIFIER_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Env vars read as truthy when set to 1/true/yes/on (case-insensitive). */
function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

/** Parse a comma-separated env var into a trimmed, lower-cased set. */
function envList(name: string): Set<string> {
  const raw = process.env[name];
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item !== ""),
  );
}

/** Random bytes as base62-ish characters, mirroring opencode's identifier tail. */
function randomChars(count: number): string {
  const bytes = new Uint8Array(count);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += IDENTIFIER_CHARS[byte % IDENTIFIER_CHARS.length];
  return out;
}

let lastTimestamp = 0;
let counter = 0;

/**
 * Generate an opencode-style ascending identifier: 12 lowercase-hex chars
 * (millisecond timestamp + per-process counter, exactly like
 * `Identifier.create()` in `packages/schema/src/identifier.ts`) followed by
 * 14 random alphanumerics.
 */
function ascendingIdentifier(): string {
  const timestamp = Date.now();
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((current >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0"),
  ).join("");
  return time + randomChars(26 - 12);
}

/**
 * Build the OpenCode client's User-Agent string.
 *
 * Priority:
 *   1. `PI_FAKE_OPENCODE_UA`       — full string override
 *   2. `PI_FAKE_OPENCODE_VERSION`  — version segment of `opencode/{version}`
 *   3. `DEFAULT_OPENCODE_VERSION`
 */
export function buildUserAgent(): string {
  const full = process.env.PI_FAKE_OPENCODE_UA?.trim();
  if (full) return full;

  const version =
    process.env.PI_FAKE_OPENCODE_VERSION?.trim() || DEFAULT_OPENCODE_VERSION;
  return `opencode/${version}`;
}

/** Per-pi-session cache: one stable opencode session id per pi session. */
const sessionIds = new Map<string, string>();

/**
 * Build the `x-opencode-session` value for a pi session.
 *
 * Real opencode sends its own session id (`ses_` + 26 chars); the gateway
 * validates the format. We derive a stable, well-formed id from pi's session
 * id so retries and follow-up requests within one pi session reuse the same
 * value, just like the real client would.
 */
export function buildSessionId(piSessionId: string): string {
  const existing = sessionIds.get(piSessionId);
  if (existing) return existing;

  const generated = `ses_${ascendingIdentifier()}`;
  sessionIds.set(piSessionId, generated);
  return generated;
}

/**
 * Build the `x-opencode-request` value: a fresh message id (`msg_` + 26
 * chars) per request, mirroring opencode's user-message id.
 */
export function buildRequestId(): string {
  return `msg_${ascendingIdentifier()}`;
}

/**
 * The `x-opencode-client` value: opencode's client flavor flag, defaulting
 * to "cli" (overridable via OpenCode's own `OPENCODE_CLIENT` env var).
 */
export function buildClient(): string {
  return process.env.OPENCODE_CLIENT?.trim() || "cli";
}

/**
 * Decide whether a request should carry the OpenCode identity.
 *
 * Spoofs when any of the following holds:
 *
 *   1. `PI_FAKE_OPENCODE_ALL` is set truthy — spoof every request, useful
 *      when a proxy in front of Zen forwards client headers verbatim.
 *   2. The model's provider is `opencode` / `opencode-go`, or listed in the
 *      comma-separated `PI_FAKE_OPENCODE_PROVIDERS` env var (for custom
 *      provider ids that point at Zen).
 *   3. The model's base URL contains `opencode.ai` (models.json providers
 *      configured with `https://opencode.ai/zen/v1` or similar).
 *
 * Untouched requests keep pi's own identity, so unrelated providers are never
 * affected.
 */
export function shouldSpoof(
  provider: string | undefined,
  baseUrl: string | undefined,
): boolean {
  if (envFlag("PI_FAKE_OPENCODE_ALL")) return true;

  if (provider) {
    const id = provider.toLowerCase();
    if (OPENCODE_PROVIDER_IDS.has(id)) return true;
    if (envList("PI_FAKE_OPENCODE_PROVIDERS").has(id)) return true;
  }

  if (baseUrl && baseUrl.toLowerCase().includes(OPENCODE_BASEURL_MARKER)) {
    return true;
  }

  return false;
}
