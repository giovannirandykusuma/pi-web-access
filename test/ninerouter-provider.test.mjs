import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = name => new URL(`../${name}.ts`, import.meta.url).href;
const BASE = "https://router.example.com/v1";
const SEARCH = `${BASE}/search`;
const result = (url = "https://example.com/page", extra = {}) => ({ title: "Page", url, snippet: "Snippet", position: 1, score: null, published_at: null, content: null, ...extra });
const response = (entries, answer = null) => `new Response(${JSON.stringify(JSON.stringify({ provider: "serper", query: "q", results: entries, answer, usage: {}, metrics: {}, errors: [] }))})`;

async function child(config, script, extraEnv = {}) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-ninerouter-"));
	try {
		await writeFile(join(home, "web-search.json"), typeof config === "string" ? config : JSON.stringify(config));
		const env = { ...process.env };
		for (const key of Object.keys(env)) {
			if (/API_KEY|_KEY$|^SEARXNG_|^NINEROUTER_|^PI_WEB_ACCESS_CACHE_ROOT$/.test(key)) delete env[key];
		}
		Object.assign(env, { PI_CODING_AGENT_DIR: home, XDG_CONFIG_HOME: "", HOME: home, USERPROFILE: home }, extraEnv);
		const run = spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env, timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
		assert.equal(run.status, 0, run.stderr);
		return JSON.parse(run.stdout.trim());
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

const importProvider = `const { searchWithNineRouter, isNineRouterAvailable } = await import(${JSON.stringify(moduleUrl("ninerouter"))});`;
const importSearch = `const { search } = await import(${JSON.stringify(moduleUrl("gemini-search"))});`;

test("9router posts the unified search body with Bearer auth and maps bounded, deduplicated results", async () => {
	const output = await child({ ninerouterBaseUrl: `${BASE}/`, ninerouterApiKey: "key" }, `
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, headers: { ...init.headers }, body: JSON.parse(init.body) };
			return ${response([
				result(undefined, { snippet: "x".repeat(900), content: { format: "text", text: "First line\n\n" + "y".repeat(6000), length: 6012 } }),
				result(),
				result("https://example.org", { title: " " }),
				result("file:///tmp/private"), result("javascript:alert(1)"), { title: "no url" }, null,
			])};
		};
		${importProvider}
		const output = await searchWithNineRouter("question", { numResults: 50, includeContent: true });
		console.log(JSON.stringify({ captured, available: isNineRouterAvailable(), output }));
	`);
	assert.equal(output.available, true);
	assert.equal(output.captured.url, SEARCH);
	assert.equal(output.captured.method, "POST");
	assert.equal(output.captured.headers.Authorization, "Bearer key");
	assert.deepEqual(output.captured.body, { provider: "serper", query: "question", max_results: 20 });
	assert.equal(output.output.results.length, 2);
	assert.equal(output.output.results[0].snippet.length, 500);
	assert.equal(output.output.results[1].title, "Source 2");
	assert.equal(output.output.inlineContent.length, 1);
	assert.equal(output.output.inlineContent[0].content.length, 4000);
	assert.ok(output.output.inlineContent[0].content.startsWith("First line\n\n"));
	assert.match(output.output.answer, /Source: Page/);
});

test("9router defaults to five results, omits inline content unless requested, and passes the router's answer through", async () => {
	const output = await child({ ninerouterBaseUrl: BASE }, `
		let init;
		globalThis.fetch = async (_url, i) => { init = i; return ${response(Array.from({ length: 10 }, (_, i) => result(`https://example.com/${i}`, { content: { text: "body" } })), "  Synthesized answer  ")}; };
		${importProvider}
		const output = await searchWithNineRouter("q");
		console.log(JSON.stringify({ body: JSON.parse(init.body), authorization: init.headers.Authorization ?? null, output }));
	`);
	assert.equal(output.body.max_results, 5);
	assert.equal(output.output.results.length, 5);
	assert.equal(output.output.inlineContent, undefined);
	assert.equal(output.output.answer, "Synthesized answer");
	assert.equal(output.authorization, null, "no key configured means no Authorization header (auth-disabled router)");
});

test("9router selects the router provider or combo from config, environment, and default", async () => {
	const cases = [
		[{ ninerouterBaseUrl: BASE }, {}, "serper"],
		[{ ninerouterBaseUrl: BASE, ninerouterProvider: " my-combo " }, {}, "my-combo"],
		[{ ninerouterBaseUrl: BASE, ninerouterProvider: "tavily" }, { NINEROUTER_SEARCH_PROVIDER: "exa" }, "exa"],
	];
	for (const [config, env, expected] of cases) {
		const output = await child(config, `
			let body;
			globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return ${response([result()])}; };
			${importProvider}
			await searchWithNineRouter("q");
			console.log(JSON.stringify(body.provider));
		`, env);
		assert.equal(output, expected);
	}
	const invalid = await child({ ninerouterBaseUrl: BASE, ninerouterProvider: "  " }, `
		globalThis.fetch = async () => { throw new Error("unexpected fetch"); };
		${importProvider}
		let error; try { await searchWithNineRouter("q"); } catch (e) { error = String(e); }
		console.log(JSON.stringify(error));
	`);
	assert.match(invalid, /ninerouterProvider .* must be a non-empty/);
});

test("9router base URL: required, environment overrides config, prefixes are kept, and invalid URLs are rejected before fetching", async () => {
	const missing = await child({ ninerouterApiKey: "k" }, `
		globalThis.fetch = async () => { throw new Error("unexpected fetch"); };
		${importProvider}
		let error; try { await searchWithNineRouter("q"); } catch (e) { error = String(e); }
		console.log(JSON.stringify({ available: isNineRouterAvailable(), error }));
	`);
	assert.equal(missing.available, false);
	assert.match(missing.error, /9router base URL not found/);
	const env = await child({ ninerouterBaseUrl: "https://config.example.com/v1" }, `
		let url;
		globalThis.fetch = async u => { url = String(u); return ${response([result()])}; };
		${importProvider}
		await searchWithNineRouter("q");
		console.log(JSON.stringify({ url, available: isNineRouterAvailable() }));
	`, { NINEROUTER_BASE_URL: "https://env.example.com/prefix/v1///" });
	assert.equal(env.url, "https://env.example.com/prefix/v1/search");
	assert.equal(env.available, true);
	for (const bad of ["http://router.example.com/v1", "https://user:pass@router.example.com/v1", "https://router.example.com/v1?x=1", "not a url"]) {
		const output = await child({ ninerouterBaseUrl: bad }, `
			globalThis.fetch = async () => { throw new Error("unexpected fetch"); };
			${importProvider}
			let error; try { await searchWithNineRouter("q"); } catch (e) { error = String(e); }
			console.log(JSON.stringify(error));
		`);
		assert.match(output, /ninerouterBaseUrl .* must/);
	}
});

test("9router resolves the key from environment and credential sources", async () => {
	const sources = [
		[{ ninerouterBaseUrl: BASE }, { NINEROUTER_API_KEY: "from-env" }, "from-env"],
		[{ ninerouterBaseUrl: BASE, ninerouterApiKey: "$MY_ROUTER_TOKEN" }, { MY_ROUTER_TOKEN: "from-ref" }, "from-ref"],
		[{ ninerouterBaseUrl: BASE, ninerouterApiKey: "!printf from-cmd" }, {}, "from-cmd"],
	];
	for (const [config, env, expected] of sources) {
		const output = await child(config, `
			let auth;
			globalThis.fetch = async (_url, init) => { auth = init.headers.Authorization; return ${response([result()])}; };
			${importProvider}
			await searchWithNineRouter("q");
			console.log(JSON.stringify(auth));
		`, env);
		assert.equal(output, `Bearer ${expected}`);
	}
});

test("9router sends recency and allowed domains, and reapplies include and exclude filters locally", async () => {
	const output = await child({ ninerouterBaseUrl: BASE }, `
		let body;
		globalThis.fetch = async (_url, init) => {
			body = JSON.parse(init.body);
			return ${response([result("https://docs.example.com/a"), result("https://other.com/b"), result("https://blocked.example.com/c"), result("https://example.com/d")])};
		};
		${importProvider}
		const output = await searchWithNineRouter("q", { recencyFilter: "week", domainFilter: ["https://Example.com/path", "example.com", "-blocked.example.com"] });
		console.log(JSON.stringify({ body, urls: output.results.map(r => r.url) }));
	`);
	assert.equal(output.body.time_range, "week");
	assert.deepEqual(output.body.domain_filter, ["example.com"]);
	assert.deepEqual(output.urls, ["https://docs.example.com/a", "https://example.com/d"]);
});

test("9router reports router error messages with status, rejects invalid responses, and redacts the key everywhere", async () => {
	const cases = [
		[`new Response(JSON.stringify({ error: { message: "Unknown provider: nope secret", code: "bad_request" } }), { status: 400 })`, /9router error 400: Unknown provider: nope /],
		[`new Response("upstream down secret", { status: 502 })`, /9router error 502: upstream down/],
		[`new Response("{}")`, /9router returned invalid response: expected results array/],
		[`new Response("not json secret")`, /9router returned invalid JSON/],
	];
	for (const [body, pattern] of cases) {
		const output = await child({ ninerouterBaseUrl: BASE, ninerouterApiKey: "secret" }, `
			globalThis.fetch = async () => ${body};
			${importProvider}
			let error; try { await searchWithNineRouter("q"); } catch (e) { error = String(e); }
			console.log(JSON.stringify(error));
		`);
		assert.match(output, pattern);
		assert.doesNotMatch(output, /secret/);
	}
	const transport = await child({ ninerouterBaseUrl: BASE, ninerouterApiKey: "secret" }, `
		globalThis.fetch = async () => { throw new TypeError("connect failed secret"); };
		${importProvider}
		let error; try { await searchWithNineRouter("q"); } catch (e) { error = { name: e.name, message: e.message, type: e instanceof TypeError }; }
		console.log(JSON.stringify(error));
	`);
	assert.equal(transport.type, true);
	assert.doesNotMatch(transport.message, /secret/);
});

test("9router errors classify for searchRouting fallback: quota, transient and network fall through; invalid request does not", async () => {
	const fallback = (status) => `
		const calls = [];
		globalThis.fetch = async url => {
			calls.push(String(url));
			if (String(url) === ${JSON.stringify(SEARCH)}) {
				if (${status} === 0) throw new TypeError("fetch failed");
				return new Response(JSON.stringify({ error: { message: "nope" } }), { status: ${status} });
			}
			return new Response(JSON.stringify({ result: { results: [{ title: "Fallback", url: "https://example.com", description: "ok" }] } }));
		};
		${importSearch}
		let provider = null, error = null;
		try { provider = (await search("q")).provider; } catch (e) { error = String(e); }
		console.log(JSON.stringify({ provider, error, calls: calls.length }));
	`;
	const routing = kinds => ({ ninerouterBaseUrl: BASE, ceramicApiKey: "c", searchRouting: { providers: ["ninerouter", "ceramic"], fallbackOn: kinds } });
	for (const [status, kind] of [[429, "quota"], [502, "transient"], [504, "transient"], [0, "network"]]) {
		const output = await child(routing([kind]), fallback(status));
		assert.equal(output.provider, "ceramic", `status ${status} should fall back on ${kind}`);
		assert.equal(output.calls, 2);
	}
	const invalid = await child(routing(["transient", "quota", "network"]), fallback(400));
	assert.equal(invalid.provider, null);
	assert.match(invalid.error, /9router error 400/);
	assert.equal(invalid.calls, 1);
});

test("9router applies the deadline and distinguishes caller cancellation", async () => {
	const output = await child({ ninerouterBaseUrl: BASE }, `
		globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
		${importProvider}
		const controller = new AbortController();
		const pending = searchWithNineRouter("q", { signal: controller.signal });
		controller.abort();
		let error; try { await pending; } catch (e) { error = String(e); }
		console.log(JSON.stringify(error));
	`);
	assert.match(output, /Aborted/);
});

test("9router strips Authorization on cross-origin redirects", async () => {
	const output = await child({ ninerouterBaseUrl: BASE, ninerouterApiKey: "secret" }, `
		const seen = [];
		globalThis.fetch = async (url, init) => {
			seen.push({ url: String(url), auth: init.headers?.Authorization ?? (init.headers instanceof Headers ? init.headers.get("Authorization") : null) ?? null });
			if (String(url) === ${JSON.stringify(SEARCH)}) return new Response(null, { status: 307, headers: { location: "https://elsewhere.example.net/search" } });
			return ${response([result()])};
		};
		${importProvider}
		await searchWithNineRouter("q");
		console.log(JSON.stringify(seen));
	`);
	assert.equal(output.length, 2);
	assert.equal(output[0].auth, "Bearer secret");
	assert.equal(output[1].auth, null);
});

test("9router is explicit-only: selectable explicitly and in routing, never joins auto or all", async () => {
	const config = { ninerouterBaseUrl: BASE, webSearch: { allowedProviders: ["ninerouter", "exa"] } };
	const output = await child(config, `
		const calls = [];
		globalThis.fetch = async url => {
			calls.push(String(url));
			if (String(url) === ${JSON.stringify(SEARCH)}) return ${response([result()])};
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }));
		};
		${importSearch}
		const explicit = await search("q", { provider: "ninerouter" });
		const array = await search("q", { provider: ["ninerouter", "exa"] });
		const auto = await search("q", { provider: "auto" });
		const all = await search("q", { provider: "all" });
		console.log(JSON.stringify({ explicit: explicit.provider, array: array.providerResponses.map(r => r.provider), auto: auto.provider, all: all.providerResponses.map(r => r.provider), calls }));
	`);
	assert.equal(output.explicit, "ninerouter");
	assert.deepEqual(output.array, ["ninerouter", "exa"]);
	assert.equal(output.auto, "exa");
	assert.deepEqual(output.all, ["exa"]);
	assert.equal(output.calls.filter(url => url === SEARCH).length, 2);
});

test("9router is exposed in Pi and MCP schemas and Curator, and obeys the provider allowlist", async () => {
	const output = await child({ ninerouterBaseUrl: BASE, webSearch: { allowedProviders: ["ninerouter"] } }, `
		const tools = [];
		(await import(${JSON.stringify(moduleUrl("index"))})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
		const { MCP_TOOL_DEFINITIONS, validateMcpToolArguments } = await import(${JSON.stringify(moduleUrl("mcp-tool-definitions"))});
		const mcpSchemas = MCP_TOOL_DEFINITIONS.filter(t => ["web_search", "source_check"].includes(t.name)).map(t => t.inputSchema.properties.provider.anyOf[0].enum);
		const mcpErrors = validateMcpToolArguments(MCP_TOOL_DEFINITIONS.find(t => t.name === "web_search"), { query: "q", provider: "ninerouter" });
		globalThis.fetch = async () => ${response([result()])};
		const sourceCheck = await tools.find(t => t.name === "source_check").execute("call", { claim: "q", provider: "ninerouter" }, undefined, undefined, { modelRegistry: {} });
		const { generateCuratorPage } = await import(${JSON.stringify(moduleUrl("curator-page"))});
		const available = new Proxy({ all: false, ninerouter: true }, { get: (obj, key) => obj[key] ?? false });
		const page = generateCuratorPage(["q"], "token", 20, available, "ninerouter", "ninerouter", [], null);
		console.log(JSON.stringify({ mcpSchemas, mcpErrors, sourceProvider: sourceCheck.details.artifact.provider, schemas: tools.filter(t => ["web_search", "source_check"].includes(t.name)).map(t => t.parameters.properties.provider.description), button: page.includes('data-provider="ninerouter"'), label: page.includes('provider === "ninerouter") return "9router"') }));
	`);
	assert.equal(output.schemas.length, 2);
	for (const description of output.schemas) assert.match(description, /Allowed: ninerouter\./);
	assert.ok(output.mcpSchemas.every(schema => schema.includes("ninerouter")));
	assert.deepEqual(output.mcpErrors, []);
	assert.equal(output.sourceProvider, "ninerouter");
	assert.equal(output.button, true);
	assert.equal(output.label, true);
	const blocked = await child({ ninerouterBaseUrl: BASE, webSearch: { allowedProviders: ["exa"] } }, `
		globalThis.fetch = async () => { throw new Error("unexpected fetch"); };
		${importSearch}
		let error; try { await search("q", { provider: "ninerouter" }); } catch (e) { error = String(e); }
		console.log(JSON.stringify(error));
	`);
	assert.match(blocked, /disabled provider/);
});
