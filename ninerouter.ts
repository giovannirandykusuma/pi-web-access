import { existsSync, readFileSync } from "node:fs";
import { activityMonitor } from "./activity.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { ExtractedContent } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { formatSearchResultsAsAnswer } from "./search-answer-formatting.ts";
import { normalizeSearchResultCount } from "./search-result-count-normalization.ts";
import { fetchWithCredentialRedirects, getWebSearchConfigPath, resolveApiBaseUrl } from "./utils.ts";

// 9router (https://github.com/decolua/9router) is a self-hosted AI router whose unified
// POST /v1/search fronts many search APIs (Serper, Tavily, Exa, Brave, ...) and dashboard
// combos that fail over between them. There is no official host: the base URL is required.
const CONFIG_PATH = getWebSearchConfigPath();
const SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_PROVIDER = "serper";

interface NineRouterConfig {
	ninerouterBaseUrl?: unknown;
	ninerouterApiKey?: unknown;
	ninerouterProvider?: unknown;
}

interface NineRouterResult {
	title?: unknown;
	url?: unknown;
	snippet?: unknown;
	content?: unknown;
}

let cachedConfig: NineRouterConfig | undefined;

function loadConfig(): NineRouterConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) return cachedConfig = {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
	} catch {
		// JSON parse errors can quote credentials from the config file.
		throw new Error(`Failed to parse ${CONFIG_PATH}: expected valid JSON`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Invalid config in ${CONFIG_PATH}: expected a JSON object`);
	}
	return cachedConfig = parsed as NineRouterConfig;
}

function configuredBaseUrl(): unknown {
	return process.env.NINEROUTER_BASE_URL ?? loadConfig().ninerouterBaseUrl;
}

function searchUrl(): string {
	const base = resolveApiBaseUrl({
		configKey: "ninerouterBaseUrl",
		configuredValue: loadConfig().ninerouterBaseUrl,
		defaultValue: "",
		environmentKey: "NINEROUTER_BASE_URL",
		environmentValue: process.env.NINEROUTER_BASE_URL,
	});
	if (!base) {
		throw new Error(`9router base URL not found. Set ninerouterBaseUrl in ${CONFIG_PATH} or NINEROUTER_BASE_URL (e.g. https://your-router/v1)`);
	}
	return `${base}/search`;
}

function routerProvider(): string {
	const fromEnvironment = process.env.NINEROUTER_SEARCH_PROVIDER !== undefined;
	const value = fromEnvironment ? process.env.NINEROUTER_SEARCH_PROVIDER : loadConfig().ninerouterProvider;
	if (value === undefined) return DEFAULT_PROVIDER;
	if (typeof value !== "string" || !value.trim()) {
		const source = fromEnvironment ? "NINEROUTER_SEARCH_PROVIDER" : `ninerouterProvider in ${CONFIG_PATH}`;
		throw new Error(`${source} must be a non-empty 9router search provider id or combo name`);
	}
	return value.trim();
}

function domainFilters(values: string[] | undefined): { include: string[]; exclude: string[] } {
	const include: string[] = [];
	const exclude: string[] = [];
	for (const raw of values ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? exclude : include;
		if (!target.includes(domain)) target.push(domain);
	}
	return { include, exclude };
}

function text(value: unknown): string {
	return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function parseResponse(value: unknown): { results: NineRouterResult[]; answer: string } {
	if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray((value as Record<string, unknown>).results)) {
		throw new Error("9router returned invalid response: expected results array");
	}
	const envelope = value as { results: NineRouterResult[]; answer?: unknown };
	return { results: envelope.results, answer: typeof envelope.answer === "string" ? envelope.answer.trim() : "" };
}

function errorDetail(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: { message?: unknown } | unknown };
		const message = parsed && typeof parsed === "object" && parsed.error && typeof parsed.error === "object"
			? (parsed.error as { message?: unknown }).message
			: undefined;
		if (typeof message === "string" && message.trim()) return message.trim();
	} catch {
		// Not JSON: fall back to the raw body.
	}
	return body;
}

export function isNineRouterAvailable(): boolean {
	const base = configuredBaseUrl();
	return typeof base === "string" && base.trim().length > 0;
}

export async function searchWithNineRouter(query: string, options: SearchOptions & { includeContent?: boolean } = {}): Promise<SearchResponse> {
	const url = searchUrl();
	const provider = routerProvider();
	const filters = domainFilters(options.domainFilter);
	const keySource = { provider: "9router", configuredValue: loadConfig().ninerouterApiKey, environmentValue: process.env.NINEROUTER_API_KEY };
	// The key is optional: a self-hosted router may run with auth disabled.
	const apiKey = hasCredentialSource(keySource)
		? await resolveCredential({ ...keySource, signal: options.signal })
		: undefined;
	const numResults = normalizeSearchResultCount(options.numResults);
	const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
	const redact = (value: string) => apiKey ? redactCredential(value, apiKey) : value;
	const activityId = activityMonitor.logStart({ type: "api", query });
	let parsed: { results: NineRouterResult[]; answer: string };
	try {
		const response = await fetchWithCredentialRedirects(url, {
			method: "POST",
			headers: {
				...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				provider,
				query,
				max_results: numResults,
				...(options.recencyFilter ? { time_range: options.recencyFilter } : {}),
				...(filters.include.length ? { domain_filter: filters.include } : {}),
			}),
			signal,
		}, ["Authorization"]);
		if (!response.ok) {
			const detail = redact(errorDetail(await response.text())).slice(0, 300);
			throw new Error(`9router error ${response.status}: ${detail}`);
		}
		let data: unknown;
		try {
			data = await response.json();
		} catch (err) {
			// Preserve transport and cancellation errors for routing. Syntax errors
			// can quote response content, so do not echo their messages.
			if (!(err instanceof SyntaxError)) throw err;
			throw new Error("9router returned invalid JSON");
		}
		parsed = parseResponse(data);
		activityMonitor.logComplete(activityId, response.status);
	} catch (err) {
		if (options.signal?.aborted) {
			activityMonitor.logComplete(activityId, 0);
			throw new Error("Aborted");
		}
		const message = timeout.aborted || (err instanceof Error && err.name === "TimeoutError")
			? "9router request timed out after 30s"
			: redact(err instanceof Error ? err.message : String(err));
		activityMonitor.logError(activityId, message);
		const outgoing = err instanceof TypeError ? new TypeError(message) : new Error(message);
		if (err instanceof Error && !timeout.aborted) outgoing.name = err.name;
		throw outgoing;
	}
	const results: SearchResponse["results"] = [];
	const inlineContent: ExtractedContent[] = [];
	const seen = new Set<string>();
	for (const entry of parsed.results) {
		if (!entry || typeof entry !== "object" || typeof entry.url !== "string") continue;
		let resultUrl: URL;
		try { resultUrl = new URL(entry.url); } catch { continue; }
		if (resultUrl.protocol !== "http:" && resultUrl.protocol !== "https:") continue;
		const matches = (domain: string) => resultUrl.hostname === domain || resultUrl.hostname.endsWith(`.${domain}`);
		// The router forwards domain_filter, but not every upstream honours it, and exclusions are local only.
		if (filters.exclude.some(matches) || (filters.include.length && !filters.include.some(matches))) continue;
		if (seen.has(resultUrl.href)) continue;
		seen.add(resultUrl.href);
		const title = text(entry.title) || `Source ${results.length + 1}`;
		results.push({ title, url: resultUrl.href, snippet: text(entry.snippet).slice(0, 500) });
		const contentText = entry.content && typeof entry.content === "object" && typeof (entry.content as { text?: unknown }).text === "string"
			? (entry.content as { text: string }).text.trim().slice(0, 4_000)
			: "";
		if (options.includeContent && contentText) inlineContent.push({ url: resultUrl.href, title, content: contentText, error: null });
		if (results.length >= numResults) break;
	}
	return {
		answer: parsed.answer || formatSearchResultsAsAnswer(results),
		results,
		...(inlineContent.length ? { inlineContent } : {}),
	};
}
