/**
 * pi-web-lite — minimal web access tools for pi.
 *
 * webfetch:  URL -> markdown.
 *   Chain: direct HTTP (readability + turndown)
 *        -> Gemini Web (browser cookies, via pi-web-access helpers)
 *        -> Gemini API url_context (via pi-web-access helpers)
 *        -> Tavily extract (TAVILY_API_KEY or ~/.pi/web-search.json)
 *
 * websearch: query -> answer + sources, via Exa.
 *   Keyless through mcp.exa.ai by default; with an EXA_API_KEY
 *   (env or ~/.pi/web-search.json exaApiKey) it uses the Exa API directly.
 *
 * Gemini fallbacks and the Exa client are dynamically imported from the
 * installed pi-web-access package (files stay on disk even when that
 * package is disabled in settings). Missing pieces are skipped silently.
 */
/// <reference lib="dom" />
import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PWA_DIR = "/home/user/.pi/agent/npm/node_modules/pi-web-access";
const WEB_SEARCH_CONFIG = "/home/user/.pi/web-search.json";
const DEFAULT_MAX_LENGTH = 50_000;
const FETCH_TIMEOUT_MS = 30_000;

const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

interface LiteResult {
	url: string;
	title: string;
	content: string;
	error: string | null;
	via?: string;
}

const BROWSER_HEADERS: Record<string, string> = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
};

function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, max) + "\n\n[truncated at " + max + " chars]";
}

function textResult(text: string): { content: Array<{ type: "text"; text: string }>; details: {} } {
	return { content: [{ type: "text", text }], details: {} };
}

// ---------------------------------------------------------------------------
// webfetch: direct + Gemini Web + Gemini API + Tavily
// ---------------------------------------------------------------------------

async function directFetch(url: string, signal?: AbortSignal): Promise<LiteResult> {
	const response = await fetch(url, {
		headers: BROWSER_HEADERS,
		signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]),
		redirect: "follow",
	});
	if (!response.ok) {
		return { url, title: "", content: "", error: "HTTP " + response.status + " " + response.statusText };
	}
	const contentType = (response.headers.get("content-type") || "").toLowerCase();

	if (contentType.includes("pdf") || /\.pdf(\?|$)/i.test(url)) {
		return { url, title: "", content: "", error: "PDF not supported by webfetch (use bash to download)" };
	}
	if (
		contentType.startsWith("image/") ||
		contentType.startsWith("audio/") ||
		contentType.startsWith("video/") ||
		contentType.includes("octet-stream")
	) {
		return { url, title: "", content: "", error: "Binary content (" + (contentType || "unknown") + ") not supported" };
	}

	const text = await response.text();
	const isHtml = contentType.includes("html") || /^\s*<(?:!doctype|html)/i.test(text);
	if (!isHtml) {
		return { url, title: url, content: text, error: null, via: "direct" };
	}

	const { document } = parseHTML(text);
	const article = new Readability(document as unknown as Document).parse();
	if (!article?.content) {
		return {
			url,
			title: "",
			content: "",
			error: "No readable content (page may be JavaScript-rendered or blocked)",
		};
	}
	const markdown = turndown.turndown(article.content);
	if (markdown.trim().length < 80) {
		return { url, title: article.title || "", content: "", error: "Extracted content too short to be useful" };
	}
	return { url, title: article.title || url, content: markdown, error: null, via: "direct" };
}

async function geminiFallback(
	kind: "web" | "api",
	url: string,
	signal?: AbortSignal,
): Promise<LiteResult | null> {
	try {
		const mod: any = await import(PWA_DIR + "/gemini-url-context.ts");
		const fn = kind === "web" ? mod.extractWithGeminiWeb : mod.extractWithUrlContext;
		const result = await fn(url, signal);
		if (!result || result.error || !result.content || !result.content.trim()) return null;
		return {
			url,
			title: result.title || url,
			content: result.content,
			error: null,
			via: kind === "web" ? "gemini-web" : "gemini-api",
		};
	} catch {
		return null;
	}
}

function tavilyKey(): string | null {
	if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY;
	try {
		const cfg = JSON.parse(readFileSync(WEB_SEARCH_CONFIG, "utf-8"));
		return cfg.tavilyApiKey || null;
	} catch {
		return null;
	}
}

async function tavilyFetch(url: string, signal?: AbortSignal): Promise<LiteResult | null> {
	const key = tavilyKey();
	if (!key) return null;
	try {
		const res = await fetch("https://api.tavily.com/extract", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ api_key: key, urls: [url] }),
			signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]),
		});
		if (!res.ok) return null;
		const data: any = await res.json();
		const raw = data?.results?.[0]?.raw_content;
		if (!raw || !raw.trim()) return null;
		return { url, title: url, content: raw, error: null, via: "tavily" };
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// websearch: Exa (keyless MCP, or Exa API when EXA_API_KEY is set)
// ---------------------------------------------------------------------------

async function exaSearch(
	query: string,
	opts: { numResults?: number; recency?: string; signal?: AbortSignal },
): Promise<string> {
	const mod: any = await import(PWA_DIR + "/exa.ts");
	const r = await mod.searchWithExa(query, {
		numResults: opts.numResults,
		...(opts.recency ? { recencyFilter: opts.recency } : {}),
		signal: opts.signal,
	});
	if (!r || ((!r.answer || !String(r.answer).trim()) && (!r.results || r.results.length === 0))) {
		throw new Error("Exa returned an empty response");
	}
	const lines: string[] = [];
	if (r.answer) lines.push(String(r.answer));
	const results = r.results || [];
	if (results.length > 0) {
		lines.push("", "Sources:");
		for (const s of results) lines.push("- " + (s.title ? s.title + " — " : "") + String(s.url));
	}
	lines.push("", "(searched via exa)");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
	pi.registerTool({
		name: "webfetch",
		label: "Fetch Webpage",
		description:
			"Fetch an http(s) URL and return its main content as clean markdown (readability-extracted; raw text for non-HTML). Blocked or JS-rendered pages fall back to Gemini Web (Chrome cookies) -> Gemini API -> Tavily automatically.",
		promptSnippet: "Fetch a URL as markdown",
		parameters: Type.Object({
			url: Type.String({ description: "The http(s) URL to fetch" }),
			maxLength: Type.Optional(
				Type.Number({ description: "Max characters to return (default " + DEFAULT_MAX_LENGTH + ")" }),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const url: string = params.url;
			const maxLength: number = params.maxLength || DEFAULT_MAX_LENGTH;
			const attempts: string[] = [];

			const steps: Array<[string, () => Promise<LiteResult | null>]> = [
				["direct", () => directFetch(url, signal)],
				["gemini-web", () => geminiFallback("web", url, signal)],
				["gemini-api", () => geminiFallback("api", url, signal)],
				["tavily", () => tavilyFetch(url, signal)],
			];

			for (const [name, step] of steps) {
				let result: LiteResult | null = null;
				try {
					result = await step();
				} catch (err) {
					attempts.push(name + ": " + (err instanceof Error ? err.message : String(err)));
					continue;
				}
				if (result && !result.error && result.content && result.content.trim()) {
					const header = "# " + result.title + "\n\n(fetched via " + result.via + ")\n\n";
					return textResult(truncate(header + result.content, maxLength));
				}
				if (result && result.error) attempts.push(name + ": " + result.error);
			}

			return {
				content: [
					{
						type: "text",
						text:
							"Failed to fetch " +
							url +
							". Attempts:\n" +
							attempts.map((a) => "  - " + a).join("\n"),
					},
				],
				details: {},
				isError: true,
			};
		},
	});

	pi.registerTool({
		name: "websearch",
		label: "Web Search",
		description:
			"Search the web and return results with source links via Exa. Works keyless; setting EXA_API_KEY switches to the official Exa API. Optional numResults and recency (day/week/month/year).",
		promptSnippet: "Search the web, return results with sources",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			numResults: Type.Optional(Type.Number({ description: "Max results to list" })),
			recency: Type.Optional(
				Type.Unsafe<string>({ description: "Recency filter: day | week | month | year" }),
			),
		}),

		async execute(_toolCallId, params, signal) {
			try {
				const text = await exaSearch(String(params.query), {
					numResults: params.numResults as number | undefined,
					recency: params.recency as string | undefined,
					signal,
				});
				return textResult(truncate(text, DEFAULT_MAX_LENGTH));
			} catch (err) {
				return {
					content: [
						{
							type: "text",
							text:
								"websearch failed: " +
								(err instanceof Error ? err.message : String(err)) +
								"\nHint: set EXA_API_KEY (env or exaApiKey in ~/.pi/web-search.json) for the official Exa API path.",
						},
					],
					details: {},
					isError: true,
				};
			}
		},
	});
}
