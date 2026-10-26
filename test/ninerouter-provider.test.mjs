import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const moduleUrl = name => JSON.stringify(new URL(`../${name}.ts`, import.meta.url).href);
const BASE = "https://router.example.com/v1";
const SEARCH = `${BASE}/search`;
const ok = (urls, answer = null) => `new Response(${JSON.stringify(JSON.stringify({ results: urls.map(url => ({ title: "Page", url, snippet: "Snippet" })), answer }))})`;

async function child(config, script) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-ninerouter-"));
	try {
		await writeFile(join(home, "web-search.json"), JSON.stringify(config));
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/API_KEY|_KEY$|^NINEROUTER_/.test(key)));
		const run = spawnSync(process.execPath, ["--input-type=module"], { input: script, encoding: "utf8", env: { ...env, PI_CODING_AGENT_DIR: home, HOME: home, USERPROFILE: home }, timeout: 20_000 });
		assert.equal(run.status, 0, run.stderr);
		return JSON.parse(run.stdout.trim());
	} finally {
		await rm(home, { recursive: true, force: true });
	}
}

test("9router posts the unified search body with optional Bearer auth and filters domains locally", async () => {
	const output = await child({ ninerouterBaseUrl: `${BASE}/`, ninerouterApiKey: "key" }, `
		let captured;
		globalThis.fetch = async (url, init) => { captured = { url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) }; return ${ok(["https://docs.example.com/a", "https://other.com/b", "https://blocked.example.com/c"], " Router answer ")}; };
		const { searchWithNineRouter } = await import(${moduleUrl("ninerouter")});
		const result = await searchWithNineRouter("q", { recencyFilter: "week", domainFilter: ["example.com", "-blocked.example.com"] });
		console.log(JSON.stringify({ captured, answer: result.answer, urls: result.results.map(r => r.url) }));
	`);
	assert.deepEqual(output.captured, { url: SEARCH, auth: "Bearer key", body: { provider: "serper", query: "q", max_results: 5, time_range: "week", domain_filter: ["example.com"] } });
	assert.equal(output.answer, "Router answer");
	assert.deepEqual(output.urls, ["https://docs.example.com/a"]);
});

test("9router needs a base URL and is unavailable without one", async () => {
	const output = await child({}, `
		const { searchWithNineRouter, isNineRouterAvailable } = await import(${moduleUrl("ninerouter")});
		let error; try { await searchWithNineRouter("q"); } catch (e) { error = e.message; }
		console.log(JSON.stringify({ available: isNineRouterAvailable(), error }));
	`);
	assert.equal(output.available, false);
	assert.match(output.error, /9router base URL not found/);
});

test("9router errors keep the HTTP status, redact the key, and let searchRouting fall back on quota and timeouts", async () => {
	const error = await child({ ninerouterBaseUrl: BASE, ninerouterApiKey: "secret" }, `
		globalThis.fetch = async () => new Response("bad key secret", { status: 401 });
		const { searchWithNineRouter } = await import(${moduleUrl("ninerouter")});
		let error; try { await searchWithNineRouter("q"); } catch (e) { error = e.message; }
		console.log(JSON.stringify(error));
	`);
	assert.equal(error, "9router error 401: bad key [redacted]");
	const timedOut = `Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))`;
	for (const [kind, failure] of [["quota", `new Response("slow down", { status: 429 })`], ["network", timedOut], ["network", `Object.assign(new Response("{}"), { json: () => ${timedOut} })`]]) {
		const routed = await child({ ninerouterBaseUrl: BASE, ceramicApiKey: "c", searchRouting: { providers: ["ninerouter", "ceramic"], fallbackOn: [kind] } }, `
			globalThis.fetch = async url => String(url) === ${JSON.stringify(SEARCH)}
				? ${failure}
				: new Response(JSON.stringify({ result: { results: [{ title: "Fallback", url: "https://example.com", description: "ok" }] } }));
			const { search } = await import(${moduleUrl("gemini-search")});
			console.log(JSON.stringify((await search("q")).provider));
		`);
		assert.equal(routed, "ceramic", kind);
	}
});

test("9router is explicit-only: it never joins auto or all", async () => {
	const output = await child({ ninerouterBaseUrl: BASE, webSearch: { allowedProviders: ["ninerouter", "exa"] } }, `
		globalThis.fetch = async url => String(url) === ${JSON.stringify(SEARCH)}
			? ${ok(["https://example.com"])}
			: new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Title: Exa\\nURL: https://example.net\\nText: result\\n---" }] } }));
		const { search } = await import(${moduleUrl("gemini-search")});
		const explicit = await search("q", { provider: "ninerouter" });
		const auto = await search("q", { provider: "auto" });
		const all = await search("q", { provider: "all" });
		console.log(JSON.stringify({ explicit: explicit.provider, auto: auto.provider, all: all.providerResponses.map(r => r.provider) }));
	`);
	assert.deepEqual(output, { explicit: "ninerouter", auto: "exa", all: ["exa"] });
});
