#!/usr/bin/env node
/**
 * leeloo.js -- OpenAI-compatible proxy powered by pi-multi-pass
 *
 * "Leeloo Dallas Multi Pass!"
 *
 * Reads pi-multi-pass config and pi's auth storage, then exposes a local
 * OpenAI-compatible API that routes requests through your configured
 * subscriptions with pool failover.
 *
 * Usage:
 *   ./leeloo.js [--port 4000]
 *
 * Then point your tools at:
 *   OPENAI_BASE_URL=http://localhost:4000/v1
 *
 * Endpoints:
 *   GET  /v1/models             List all available models
 *   POST /v1/chat/completions   Chat completions (streaming + non-streaming)
 *   GET  /health                Proxy status
 *
 * Requires pi to be installed globally (npm i -g @mariozechner/pi-coding-agent).
 * Symlink the SDK into node_modules/:
 *   mkdir -p node_modules/@mariozechner
 *   ln -s $(npm root -g)/@mariozechner/pi-coding-agent node_modules/@mariozechner/pi-coding-agent
 *   ln -s $(npm root -g)/@mariozechner/pi-coding-agent/node_modules/@mariozechner/pi-ai node_modules/@mariozechner/pi-ai
 */

import { createServer } from "node:http";
import { readFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import {
	AuthStorage,
	getAgentDir,
} from "@mariozechner/pi-coding-agent";
import {
	getModel,
	getModels,
	stream,
} from "@mariozechner/pi-ai";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let PORT = parseInt(process.env.LEELOO_PORT || "4000", 10);
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--port" && args[i + 1]) PORT = parseInt(args[i + 1], 10);
}

// ─── Config loading ───────────────────────────────────────────────────────────

const AGENT_DIR = getAgentDir();
const CONFIG_PATH = join(AGENT_DIR, "multi-pass.json");

function loadMultiPassConfig() {
	if (!existsSync(CONFIG_PATH)) return { subscriptions: [], pools: [], chains: [], presets: [] };
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		return {
			subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
			pools: Array.isArray(raw.pools) ? raw.pools : [],
			chains: Array.isArray(raw.chains) ? raw.chains : [],
			presets: Array.isArray(raw.presets) ? raw.presets : [],
		};
	} catch {
		return { subscriptions: [], pools: [], chains: [], presets: [] };
	}
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

const authStorage = AuthStorage.create();

// ─── Model registry ───────────────────────────────────────────────────────────

const SUPPORTED_PROVIDERS = [
	"anthropic",
	"openai-codex",
	"github-copilot",
	"google-gemini-cli",
	"google-antigravity",
];

/**
 * Build a flat list of all servable models with their provider info.
 * Includes base providers + extra subscriptions from multi-pass config.
 */
function buildModelList() {
	const config = loadMultiPassConfig();
	const models = [];
	const seen = new Set();

	for (const provider of SUPPORTED_PROVIDERS) {
		if (!authStorage.hasAuth(provider)) continue;
		try {
			const providerModels = getModels(provider);
			for (const m of providerModels) {
				const key = `${provider}/${m.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				models.push({ ...m, provider });
			}
		} catch {
			// Provider not available
		}
	}

	// Extra subscriptions (e.g. openai-codex-2, anthropic-3)
	for (const sub of config.subscriptions) {
		const provName = `${sub.provider}-${sub.index}`;
		if (!authStorage.hasAuth(provName)) continue;
		try {
			const providerModels = getModels(sub.provider);
			for (const m of providerModels) {
				const key = `${provName}/${m.id}`;
				if (seen.has(key)) continue;
				seen.add(key);
				models.push({ ...m, provider: provName });
			}
		} catch {
			// Provider not available
		}
	}

	return models;
}

/**
 * Find the best provider for a model ID, considering pools and auth.
 */
function resolveModel(modelId) {
	const config = loadMultiPassConfig();
	const candidates = [];

	for (const provider of SUPPORTED_PROVIDERS) {
		if (!authStorage.hasAuth(provider)) continue;
		try {
			const m = getModel(provider, modelId);
			if (m) candidates.push({ model: m, provider });
		} catch { /* not found */ }
	}

	for (const sub of config.subscriptions) {
		const provName = `${sub.provider}-${sub.index}`;
		if (!authStorage.hasAuth(provName)) continue;
		try {
			const m = getModel(sub.provider, modelId);
			if (m) candidates.push({ model: { ...m, provider: provName }, provider: provName });
		} catch { /* not found */ }
	}

	if (candidates.length === 0) return null;

	// Prefer pool member ordering
	for (const pool of config.pools) {
		if (!pool.enabled) continue;
		for (const member of pool.members) {
			const match = candidates.find((c) => c.provider === member);
			if (match) return match;
		}
	}

	return candidates[0];
}

/**
 * Get failover candidate, excluding already-tried providers.
 */
function getFailoverCandidate(modelId, triedProviders) {
	const config = loadMultiPassConfig();
	const tried = new Set(triedProviders);

	for (const pool of config.pools) {
		if (!pool.enabled) continue;
		for (const member of pool.members) {
			if (tried.has(member)) continue;
			if (!authStorage.hasAuth(member)) continue;
			const base = getBaseProvider(member);
			if (!base) continue;
			try {
				const m = getModel(base, modelId);
				if (m) return { model: { ...m, provider: member }, provider: member };
			} catch { continue; }
		}
	}

	for (const provider of SUPPORTED_PROVIDERS) {
		if (tried.has(provider)) continue;
		if (!authStorage.hasAuth(provider)) continue;
		try {
			const m = getModel(provider, modelId);
			if (m) return { model: m, provider };
		} catch { continue; }
	}

	return null;
}

function getBaseProvider(providerName) {
	if (SUPPORTED_PROVIDERS.includes(providerName)) return providerName;
	const match = providerName.match(/^(.+)-(\d+)$/);
	if (match && SUPPORTED_PROVIDERS.includes(match[1])) return match[1];
	return null;
}

// ─── Rate limit detection ─────────────────────────────────────────────────────

const RATE_LIMIT_PATTERNS = [
	/usage.?limit/i, /rate.?limit/i, /limit.*reached/i,
	/too many requests/i, /overloaded/i, /capacity/i, /429/, /quota/i,
];

function isRateLimitError(msg) {
	return RATE_LIMIT_PATTERNS.some((p) => p.test(msg));
}

// ─── OpenAI format helpers ────────────────────────────────────────────────────

function makeCompletionChunk(id, model, delta, finishReason) {
	return {
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{
			index: 0,
			delta,
			finish_reason: finishReason || null,
		}],
	};
}

function makeCompletionResponse(id, model, content, usage) {
	return {
		id,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{
			index: 0,
			message: { role: "assistant", content },
			finish_reason: "stop",
		}],
		usage: usage ? {
			prompt_tokens: usage.input,
			completion_tokens: usage.output,
			total_tokens: usage.totalTokens,
		} : undefined,
	};
}

// ─── Request handler ──────────────────────────────────────────────────────────

async function handleChatCompletions(req, res) {
	const body = await readBody(req);
	let parsed;
	try {
		parsed = JSON.parse(body);
	} catch {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
		return;
	}

	const { model: modelId, messages, stream: doStream, temperature, max_tokens } = parsed;
	if (!modelId || !messages) {
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message: "model and messages are required" } }));
		return;
	}

	const triedProviders = [];
	let lastError = null;
	const maxAttempts = 5;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const resolved = attempt === 0
			? resolveModel(modelId)
			: getFailoverCandidate(modelId, triedProviders);

		if (!resolved) {
			const msg = triedProviders.length > 0
				? `All providers exhausted for model "${modelId}" (tried: ${triedProviders.join(", ")})`
				: `No provider found for model "${modelId}"`;
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: msg } }));
			return;
		}

		triedProviders.push(resolved.provider);

		try {
			const apiKey = await authStorage.getApiKey(resolved.provider);
			if (!apiKey) {
				log(`[${resolved.provider}] no API key, skipping`);
				continue;
			}

			// Build pi-ai context from OpenAI messages
			const context = { messages: [] };
			const systemMsg = messages.find((m) => m.role === "system");
			if (systemMsg) {
				context.systemPrompt = typeof systemMsg.content === "string"
					? systemMsg.content
					: systemMsg.content.map((c) => c.text || "").join("");
			}
			context.messages = messages
				.filter((m) => m.role !== "system")
				.map((m) => ({ role: m.role, content: m.content, timestamp: Date.now() }));

			const streamOpts = { apiKey, temperature, maxTokens: max_tokens };
			log(`[${resolved.provider}] routing ${modelId} (attempt ${attempt + 1})`);

			if (doStream) {
				await handleStreamingResponse(res, resolved.model, context, streamOpts, modelId);
			} else {
				await handleNonStreamingResponse(res, resolved.model, context, streamOpts, modelId);
			}
			return;

		} catch (err) {
			const errMsg = err?.message || String(err);
			log(`[${resolved.provider}] error: ${errMsg}`);
			lastError = errMsg;

			if (isRateLimitError(errMsg) && attempt < maxAttempts - 1) {
				log(`[${resolved.provider}] rate limited, failover...`);
				continue;
			}
			if (attempt < maxAttempts - 1) continue;

			if (!res.headersSent) {
				res.writeHead(502, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: { message: `Provider error: ${errMsg}` } }));
			}
			return;
		}
	}

	if (!res.headersSent) {
		res.writeHead(502, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: { message: lastError || "All providers failed" } }));
	}
}

async function handleStreamingResponse(res, model, context, opts, modelId) {
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});

	const id = `chatcmpl-${Date.now()}`;
	const eventStream = stream(model, context, opts);

	for await (const event of eventStream) {
		if (res.destroyed) break;

		if (event.type === "text_delta") {
			const chunk = makeCompletionChunk(id, modelId, { content: event.delta }, null);
			res.write(`data: ${JSON.stringify(chunk)}\n\n`);
		} else if (event.type === "done") {
			const chunk = makeCompletionChunk(id, modelId, {}, "stop");
			res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			res.write("data: [DONE]\n\n");
		} else if (event.type === "error") {
			const errMsg = event.error?.errorMessage || "Unknown error";
			if (isRateLimitError(errMsg)) throw new Error(errMsg);
			const chunk = makeCompletionChunk(id, modelId, { content: `\n\n[Error: ${errMsg}]` }, "stop");
			res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			res.write("data: [DONE]\n\n");
		}
	}

	res.end();
}

async function handleNonStreamingResponse(res, model, context, opts, modelId) {
	const eventStream = stream(model, context, opts);
	let fullText = "";
	let usage = null;

	for await (const event of eventStream) {
		if (event.type === "text_delta") {
			fullText += event.delta;
		} else if (event.type === "done") {
			usage = event.message?.usage;
		} else if (event.type === "error") {
			const errMsg = event.error?.errorMessage || "Unknown error";
			if (isRateLimitError(errMsg)) throw new Error(errMsg);
			throw new Error(errMsg);
		}
	}

	const id = `chatcmpl-${Date.now()}`;
	const response = makeCompletionResponse(id, modelId, fullText, usage);
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(response));
}

function handleModels(req, res) {
	const models = buildModelList();
	const unique = new Map();
	for (const m of models) {
		if (!unique.has(m.id)) unique.set(m.id, {
			id: m.id, object: "model", created: 0, owned_by: m.provider,
		});
	}
	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({ object: "list", data: [...unique.values()] }));
}

function handleHealth(req, res) {
	const config = loadMultiPassConfig();
	const authed = SUPPORTED_PROVIDERS.filter((p) => authStorage.hasAuth(p));
	const extraSubs = config.subscriptions
		.map((s) => `${s.provider}-${s.index}`)
		.filter((p) => authStorage.hasAuth(p));

	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify({
		status: "ok",
		providers: [...authed, ...extraSubs],
		pools: config.pools.filter((p) => p.enabled).map((p) => p.name),
		presets: config.presets.filter((p) => p.enabled).map((p) => p.name),
	}));
}

// ─── HTTP plumbing ────────────────────────────────────────────────────────────

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", reject);
	});
}

function log(...args) {
	const ts = new Date().toISOString().slice(11, 19);
	console.log(`[${ts}]`, ...args);
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
	if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

	const path = new URL(req.url, `http://localhost:${PORT}`).pathname;

	try {
		if (path === "/v1/chat/completions" && req.method === "POST") {
			await handleChatCompletions(req, res);
		} else if (path === "/v1/models" && req.method === "GET") {
			handleModels(req, res);
		} else if (path === "/health" && req.method === "GET") {
			handleHealth(req, res);
		} else {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: "Not found" } }));
		}
	} catch (err) {
		log("Unhandled error:", err?.message || err);
		if (!res.headersSent) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: { message: "Internal server error" } }));
		}
	}
});

server.listen(PORT, () => {
	const config = loadMultiPassConfig();
	const authed = SUPPORTED_PROVIDERS.filter((p) => authStorage.hasAuth(p));
	const extras = config.subscriptions.map((s) => `${s.provider}-${s.index}`).filter((p) => authStorage.hasAuth(p));
	const pools = config.pools.filter((p) => p.enabled);

	console.log(`
  ╔══════════════════════════════════════════╗
  ║         LEELOO DALLAS MULTI PASS         ║
  ╚══════════════════════════════════════════╝

  OpenAI-compatible proxy powered by pi-multi-pass

  Listening:  http://localhost:${PORT}
  Base URL:   http://localhost:${PORT}/v1

  Providers:  ${[...authed, ...extras].join(", ") || "none (login via pi first)"}
  Pools:      ${pools.map((p) => `${p.name} (${p.members.length} members)`).join(", ") || "none"}
  Presets:    ${config.presets.filter((p) => p.enabled).map((p) => p.name).join(", ") || "none"}

  Usage:
    OPENAI_BASE_URL=http://localhost:${PORT}/v1
`);
});
