#!/usr/bin/env node
/**
 * leeloo.js -- OpenAI-compatible proxy powered by pi-multi-pass
 *
 * "Leeloo on multi-pass!"
 *
 * Reads pi-multi-pass config and pi's auth storage, then exposes a local
 * OpenAI-compatible API that routes requests through your configured
 * subscriptions with pool/chain/preset failover.
 *
 * Usage:
 *   ./leeloo.js [--port 4000]
 *
 * Then point your tools at:
 *   OPENAI_BASE_URL=http://localhost:4000/v1
 *
 * Endpoints:
 *   GET  /v1/models             List all available models + presets
 *   POST /v1/chat/completions   Chat completions (streaming + non-streaming)
 *   GET  /health                Proxy status
 *
 * Features:
 *   - Full OpenAI chat completions compatibility (text, tools, images, streaming)
 *   - Pool-aware routing with strategy support (round-robin, quota-first, scheduled, custom)
 *   - Chain-based cross-pool failover
 *   - Preset resolution (model: "coding-premium" routes through preset entries)
 *   - Automatic rate-limit failover (up to 5 attempts)
 *   - OAuth token auto-refresh via pi's AuthStorage
 *
 * Requires pi installed globally (npm i -g @mariozechner/pi-coding-agent).
 */

import { createServer } from "node:http";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage, getAgentDir } from "@mariozechner/pi-coding-agent";
import { getModel, getModels, stream } from "@mariozechner/pi-ai";

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let PORT = parseInt(process.env.LEELOO_PORT || "4000", 10);
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--port" && args[i + 1]) PORT = parseInt(args[i + 1], 10);
}

// ─── Config ───────────────────────────────────────────────────────────────────

const AGENT_DIR = getAgentDir();
const CONFIG_PATH = join(AGENT_DIR, "multi-pass.json");

function loadConfig() {
	if (!existsSync(CONFIG_PATH)) return { subscriptions: [], pools: [], chains: [], presets: [], rules: [] };
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		return {
			subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
			pools: Array.isArray(raw.pools) ? raw.pools : [],
			chains: Array.isArray(raw.chains) ? raw.chains : [],
			presets: Array.isArray(raw.presets) ? raw.presets : [],
			rules: Array.isArray(raw.rules) ? raw.rules : [],
		};
	} catch {
		return { subscriptions: [], pools: [], chains: [], presets: [], rules: [] };
	}
}

function saveConfig(config) {
	const dir = join(AGENT_DIR);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
}

const authStorage = AuthStorage.create();

const SUPPORTED_PROVIDERS = [
	"anthropic", "openai-codex", "github-copilot",
	"google-gemini-cli", "google-antigravity",
];

const PROVIDER_DISPLAY_NAMES = {
	"anthropic": "Anthropic (Claude Pro/Max)",
	"openai-codex": "ChatGPT Plus/Pro (Codex)",
	"github-copilot": "GitHub Copilot",
	"google-gemini-cli": "Google Cloud Code Assist",
	"google-antigravity": "Antigravity",
};

/** Get a human-readable label for a provider name. */
function getProviderLabel(providerName) {
	const config = loadConfig();
	// Check if it's an extra subscription with a label
	for (const sub of config.subscriptions) {
		const subName = sub.provider + "-" + sub.index;
		if (subName === providerName) {
			const base = PROVIDER_DISPLAY_NAMES[sub.provider] || sub.provider;
			const display = base + " #" + sub.index;
			return sub.label ? sub.label + " -- " + display : display;
		}
	}
	return PROVIDER_DISPLAY_NAMES[providerName] || providerName;
}

function getBaseProvider(name) {
	if (SUPPORTED_PROVIDERS.includes(name)) return name;
	const m = name.match(/^(.+)-(\d+)$/);
	if (m && SUPPORTED_PROVIDERS.includes(m[1])) return m[1];
	return null;
}

/** Get all provider names (base + extras) that are authenticated. */
function getAllProviders() {
	const config = loadConfig();
	const providers = [];
	for (const p of SUPPORTED_PROVIDERS) {
		if (authStorage.hasAuth(p)) providers.push(p);
	}
	for (const sub of config.subscriptions) {
		const name = `${sub.provider}-${sub.index}`;
		if (authStorage.hasAuth(name)) providers.push(name);
	}
	return providers;
}

// ─── Rate limit detection ─────────────────────────────────────────────────────

const RATE_LIMIT_RE = [
	/usage.?limit/i, /rate.?limit/i, /limit.*reached/i,
	/too many requests/i, /overloaded/i, /capacity/i, /429/, /quota/i,
];
function isRateLimit(msg) { return RATE_LIMIT_RE.some((r) => r.test(msg)); }

// ─── Pool state (exhausted tracking + cooldown) ──────────────────────────────

const COOLDOWN_MS = 5 * 60 * 1000; // 5 min, same as extension
const exhaustedMembers = new Map(); // provider -> timestamp

function markExhausted(provider) {
	exhaustedMembers.set(provider, Date.now());
	log(`[pool] marked ${provider} exhausted (cooldown ${COOLDOWN_MS / 1000}s)`);
}

function isExhausted(provider) {
	const ts = exhaustedMembers.get(provider);
	if (!ts) return false;
	if (Date.now() - ts >= COOLDOWN_MS) {
		exhaustedMembers.delete(provider);
		return false;
	}
	return true;
}

function isAvailable(provider) {
	return authStorage.hasAuth(provider) && !isExhausted(provider);
}

// ─── Schedule evaluation (same logic as extension) ────────────────────────────

const JS_DAY_TO_DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function getDayOfWeek(date) { return JS_DAY_TO_DOW[date.getDay()]; }

function isInHourRange(hour, range) {
	const [start, end] = range;
	return start <= end ? (hour >= start && hour < end) : (hour >= start || hour < end);
}

function isInScheduleWindow(window, now) {
	if (window.days?.length > 0 && !window.days.includes(getDayOfWeek(now))) return false;
	if (window.hours && !isInHourRange(now.getHours(), window.hours)) return false;
	if (window.dateRange) {
		const d = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,"0")}-${String(now.getDate()).padStart(2,"0")}`;
		if (window.dateRange.from && d < window.dateRange.from) return false;
		if (window.dateRange.to && d > window.dateRange.to) return false;
	}
	return true;
}

function getWindowRemainingMs(window, now) {
	if (!window.hours) return Infinity;
	const end = new Date(now);
	end.setHours(window.hours[1], 0, 0, 0);
	let remaining = end.getTime() - now.getTime();
	if (remaining <= 0) remaining += 24 * 60 * 60 * 1000;
	return remaining;
}

/** Order members by schedule: preferred (in-window, shortest-remaining first) > default > overflow */
function getScheduledOrder(pool, available) {
	const schedule = pool.memberSchedule || {};
	const now = new Date();
	const preferred = [], defaults = [], overflow = [];

	for (const prov of available) {
		const s = schedule[prov];
		if (!s) { defaults.push({ prov, remaining: Infinity }); continue; }
		const role = s.role || "default";
		if (role === "overflow") { overflow.push({ prov, remaining: Infinity }); continue; }
		if (role === "preferred") {
			const windows = s.windows || [];
			if (windows.length === 0) { defaults.push({ prov, remaining: Infinity }); continue; }
			let active = false, shortest = Infinity;
			for (const w of windows) {
				if (isInScheduleWindow(w, now)) {
					active = true;
					const r = getWindowRemainingMs(w, now);
					if (r < shortest) shortest = r;
				}
			}
			if (active) preferred.push({ prov, remaining: shortest });
			// Preferred but NOT in window -> skip entirely (not even default)
			continue;
		}
		defaults.push({ prov, remaining: Infinity });
	}

	preferred.sort((a, b) => a.remaining - b.remaining);
	return [...preferred, ...defaults, ...overflow].map((x) => x.prov);
}

// ─── Quota checkers (ported from extension) ──────────────────────────────────

const CODEX_USAGE_URL = process.env.CHATGPT_BASE_URL || "https://chatgpt.com/backend-api";
const GEMINI_QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const ANTIGRAVITY_QUOTA_URLS = [
	"https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels",
	"https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
];

function decodeJwtPayload(token) {
	try {
		const parts = token.split(".");
		if (parts.length < 2) return {};
		return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
	} catch { return {}; }
}

/** Check Codex (ChatGPT) quota. Returns 0-100 remaining percentage or null. */
// ── Detailed quota result format ──
// { score: 0-100, status: "ready"|"low"|"blocked"|"unknown",
//   windows: [...], models: [...], plan?: string, email?: string }

async function checkCodexQuotaDetailed(provider) {
	const cred = authStorage.get(provider);
	if (!cred || cred.type !== "oauth" || !cred.access) return { score: null, status: "no-auth" };

	const apiKey = await authStorage.getApiKey(provider);
	if (!apiKey) return { score: null, status: "no-auth" };

	const payload = decodeJwtPayload(apiKey);
	const authClaim = payload["https://api.openai.com/auth"];
	const profileClaim = payload["https://api.openai.com/profile"];
	const accountId = cred.accountId || authClaim?.chatgpt_account_id;

	const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
	if (accountId) headers["chatgpt-account-id"] = accountId;

	try {
		const resp = await fetch(`${CODEX_USAGE_URL.replace(/\/+$/, "")}/wham/usage`, { headers });
		if (!resp.ok) return { score: null, status: "error", error: `HTTP ${resp.status}` };
		const data = await resp.json();
		const rl = data?.rate_limit;

		const parseWindow = (w, name) => {
			if (!w) return null;
			const used = w.used_percent || 0;
			const remaining = Math.max(0, 100 - used);
			const windowSec = w.limit_window_seconds || 0;
			const resetAt = w.reset_at ? new Date(w.reset_at * 1000).toISOString() : null;
			return { name, used: Math.round(used), remaining: Math.round(remaining), windowSeconds: windowSec, resetAt };
		};

		const windows = [
			parseWindow(rl?.primary_window, "5-hour"),
			parseWindow(rl?.secondary_window, "7-day"),
		].filter(Boolean);

		const scores = windows.map((w) => w.remaining);
		const score = scores.length > 0 ? Math.min(...scores) : null;
		const status = score === null ? "unknown" : score > 30 ? "ready" : score > 5 ? "low" : "blocked";

		return {
			score,
			status,
			plan: data?.plan_type || authClaim?.chatgpt_plan_type || "unknown",
			email: profileClaim?.email || data?.email || null,
			windows,
		};
	} catch (e) { return { score: null, status: "error", error: e.message }; }
}

async function checkGeminiQuotaDetailed(provider) {
	const apiKey = await authStorage.getApiKey(provider);
	if (!apiKey) return { score: null, status: "no-auth" };

	let token;
	try { const p = JSON.parse(apiKey); token = p.token; } catch { token = apiKey; }

	try {
		const resp = await fetch(GEMINI_QUOTA_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"User-Agent": "google-api-nodejs-client/9.15.1",
				"X-Goog-Api-Client": "gl-node/22.17.0",
			},
			body: "{}",
		});
		if (!resp.ok) return { score: null, status: "error", error: `HTTP ${resp.status}` };
		const data = await resp.json();
		const models = (data?.buckets || []).map((b) => {
			const id = b?.modelId || "unknown";
			const remaining = typeof b?.remainingFraction === "number" ? Math.round(b.remainingFraction * 100) : null;
			const resetAt = b?.resetTime || null;
			return { model: id, remaining, resetAt };
		}).filter((m) => m.remaining !== null);

		const scores = models.map((m) => m.remaining);
		const score = scores.length > 0 ? Math.min(...scores) : null;
		const status = score === null ? "unknown" : score > 30 ? "ready" : score > 5 ? "low" : "blocked";
		return { score, status, models };
	} catch (e) { return { score: null, status: "error", error: e.message }; }
}

async function checkAntigravityQuotaDetailed(provider) {
	const apiKey = await authStorage.getApiKey(provider);
	if (!apiKey) return { score: null, status: "no-auth" };

	let token;
	try { const p = JSON.parse(apiKey); token = p.token; } catch { token = apiKey; }

	for (const url of ANTIGRAVITY_QUOTA_URLS) {
		try {
			const resp = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					"User-Agent": "antigravity/1.11.9 windows/amd64",
					"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
				},
				body: "{}",
			});
			if (!resp.ok) continue;
			const data = await resp.json();
			const entries = data?.models ? Object.entries(data.models) : [];
			const models = entries
				.filter(([, v]) => !v.isInternal)
				.map(([k, v]) => ({
					model: v.displayName || v.model || k,
					remaining: typeof v?.quotaInfo?.remainingFraction === "number" ? Math.round(v.quotaInfo.remainingFraction * 100) : null,
					resetAt: v?.quotaInfo?.resetTime || null,
				}))
				.filter((m) => m.remaining !== null);

			const scores = models.map((m) => m.remaining);
			const score = scores.length > 0 ? Math.min(...scores) : null;
			const status = score === null ? "unknown" : score > 30 ? "ready" : score > 5 ? "low" : "blocked";
			return { score, status, models };
		} catch { continue; }
	}
	return { score: null, status: "error", error: "all endpoints failed" };
}

async function checkQuotaDetailed(provider) {
	const base = getBaseProvider(provider);
	switch (base) {
		case "openai-codex": return checkCodexQuotaDetailed(provider);
		case "google-gemini-cli": return checkGeminiQuotaDetailed(provider);
		case "google-antigravity": return checkAntigravityQuotaDetailed(provider);
		default: return { score: null, status: "unsupported" };
	}
}

/** Simple score-only wrapper (used by sortByQuota). */
async function checkQuota(provider) {
	const detail = await checkQuotaDetailed(provider);
	return detail.score;
}

// ─── Request usage tracking ──────────────────────────────────────────────────

const usageLog = [];       // Recent requests (ring buffer)
const USAGE_LOG_MAX = 500;
const providerStats = {};  // { provider: { requests, tokens_in, tokens_out, errors, last_used } }

function trackRequest(provider, modelId, usage, durationMs, error) {
	const entry = {
		timestamp: new Date().toISOString(),
		provider,
		model: modelId,
		tokens_in: usage?.input || 0,
		tokens_out: usage?.output || 0,
		duration_ms: durationMs,
		error: error || null,
	};
	usageLog.push(entry);
	if (usageLog.length > USAGE_LOG_MAX) usageLog.shift();

	if (!providerStats[provider]) {
		providerStats[provider] = { requests: 0, tokens_in: 0, tokens_out: 0, errors: 0, last_used: null };
	}
	const s = providerStats[provider];
	s.requests++;
	s.tokens_in += entry.tokens_in;
	s.tokens_out += entry.tokens_out;
	if (error) s.errors++;
	s.last_used = entry.timestamp;
}

// ─── Rule engine (DLP / policy enforcement) ─────────────────────────────────
//
// Rule types:
//   block    - reject request/response if pattern matches
//   redact   - replace pattern matches with placeholder text
//   warn     - log but allow (audit trail)
//   model    - restrict allowed models (allow/deny list)
//   limit    - rate limiting per time window
//   custom   - run a JS function for custom logic
//
// Each rule has: name, enabled, type, scope (request|response|both), patterns, action config

const auditLog = [];
const AUDIT_LOG_MAX = 1000;
const rateLimitCounters = {}; // { ruleName: { count, windowStart } }

function auditEvent(rule, action, detail, matchedText, fullMessage, source) {
	const matched = typeof matchedText === "string" ? matchedText : null;
	const full = typeof fullMessage === "string" ? fullMessage : null;
	const base = full || matched;
	const entry = {
		timestamp: new Date().toISOString(),
		rule: rule.name,
		type: rule.type,
		action,
		detail,
		source: source || null,
		snippet: base ? base.slice(0, 200) : null,
		matched_text: matched,
		full_message: full,
	};
	auditLog.push(entry);
	if (auditLog.length > AUDIT_LOG_MAX) auditLog.shift();
	log(`[rule:${rule.name}] ${action}: ${detail}`);
}

/**
 * Extract all text from OpenAI-format messages for pattern matching.
 */
function extractText(messages) {
	const parts = [];
	for (const m of messages) {
		if (typeof m.content === "string") parts.push(m.content);
		else if (Array.isArray(m.content)) {
			for (const p of m.content) {
				if (p.type === "text") parts.push(p.text);
			}
		}
		if (m.tool_calls) {
			for (const tc of m.tool_calls) {
				parts.push(tc.function?.name || "");
				parts.push(tc.function?.arguments || "");
			}
		}
	}
	return parts.join("\n");
}

/**
 * Run content rules (block/redact/warn) against text.
 * Returns { blocked, message, redacted } where redacted is the
 * potentially modified messages array.
 */
function evaluateContentRules(rules, messages, scope) {
	let text = extractText(messages);
	let blocked = false;
	let blockMessage = "";
	let modified = false;

	for (const rule of rules) {
		if (!rule.enabled) continue;
		if (rule.type !== "block" && rule.type !== "redact" && rule.type !== "warn") continue;
		const ruleScope = rule.scope || "request";
		if (ruleScope !== "both" && ruleScope !== scope) continue;

		const patterns = (rule.patterns || []).map((p) => {
			try { return new RegExp(p, "gi"); } catch { return null; }
		}).filter(Boolean);

		for (const re of patterns) {
			if (re.test(text)) {
				const matched = text.match(re)?.[0] || null;
				if (rule.type === "block") {
					blocked = true;
					blockMessage = rule.message || `Blocked by rule: ${rule.name}`;
					auditEvent(rule, "blocked", blockMessage, matched, text, scope);
				} else if (rule.type === "warn") {
					auditEvent(rule, "warned", `Pattern matched: ${re.source}`, matched, text, scope);
				} else if (rule.type === "redact") {
					const replacement = rule.replacement || "[REDACTED]";
					// Redact in all message contents
					messages = messages.map((m) => {
						if (typeof m.content === "string") {
							return { ...m, content: m.content.replace(re, replacement) };
						}
						if (Array.isArray(m.content)) {
							return { ...m, content: m.content.map((p) =>
								p.type === "text" ? { ...p, text: p.text.replace(re, replacement) } : p
							)};
						}
						return m;
					});
					modified = true;
					auditEvent(rule, "redacted", `Pattern replaced: ${re.source}`, matched, text, scope);
				}
			}
			re.lastIndex = 0; // reset global regex
		}
	}

	return { blocked, message: blockMessage, messages: modified ? messages : messages };
}

/**
 * Check model access rules. Returns { allowed, message }.
 */
function evaluateModelRules(rules, modelId) {
	for (const rule of rules) {
		if (!rule.enabled || rule.type !== "model") continue;
		const allowList = rule.allow || [];
		const denyList = rule.deny || [];

		if (denyList.length > 0) {
			for (const pattern of denyList) {
				const re = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$", "i");
				if (re.test(modelId)) {
					auditEvent(rule, "denied", `Model ${modelId} denied by ${pattern}`, modelId, null, "model");
					return { allowed: false, message: rule.message || `Model "${modelId}" is not allowed by policy "${rule.name}"` };
				}
			}
		}
		if (allowList.length > 0) {
			const matched = allowList.some((pattern) => {
				const re = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$", "i");
				return re.test(modelId);
			});
			if (!matched) {
				auditEvent(rule, "denied", `Model ${modelId} not in allow list`, modelId, null, "model");
				return { allowed: false, message: rule.message || `Model "${modelId}" is not in the allowed list for policy "${rule.name}"` };
			}
		}
	}
	return { allowed: true };
}

/**
 * Check rate limit rules. Returns { allowed, message, retryAfter }.
 */
function evaluateRateLimitRules(rules) {
	const now = Date.now();
	for (const rule of rules) {
		if (!rule.enabled || rule.type !== "limit") continue;
		const windowMs = (rule.windowSeconds || 60) * 1000;
		const maxRequests = rule.maxRequests || 60;

		if (!rateLimitCounters[rule.name]) {
			rateLimitCounters[rule.name] = { count: 0, windowStart: now };
		}
		const counter = rateLimitCounters[rule.name];
		if (now - counter.windowStart >= windowMs) {
			counter.count = 0;
			counter.windowStart = now;
		}
		counter.count++;
		if (counter.count > maxRequests) {
			const retryAfter = Math.ceil((counter.windowStart + windowMs - now) / 1000);
			auditEvent(rule, "rate-limited", `${counter.count}/${maxRequests} in ${rule.windowSeconds || 60}s window`, `${counter.count}/${maxRequests}`, null, "limit");
			return { allowed: false, message: rule.message || `Rate limit exceeded: ${maxRequests} requests per ${rule.windowSeconds || 60}s`, retryAfter };
		}
	}
	return { allowed: true };
}

/**
 * Redact patterns in response text (for response-scoped rules).
 */
function redactResponse(rules, text) {
	for (const rule of rules) {
		if (!rule.enabled || rule.type !== "redact") continue;
		const scope = rule.scope || "request";
		if (scope !== "response" && scope !== "both") continue;
		const replacement = rule.replacement || "[REDACTED]";
		for (const p of (rule.patterns || [])) {
			try {
				const re = new RegExp(p, "gi");
				if (re.test(text)) {
					const matched = text.match(re)?.[0] || null;
					auditEvent(rule, "redacted-response", `Pattern replaced: ${re.source}`, matched, text, "response");
					re.lastIndex = 0;
					text = text.replace(re, replacement);
				}
			} catch {}
		}
	}
	return text;
}

/**
 * Check response text against block rules.
 */
function checkResponseBlock(rules, text) {
	for (const rule of rules) {
		if (!rule.enabled || rule.type !== "block") continue;
		const scope = rule.scope || "request";
		if (scope !== "response" && scope !== "both") continue;
		for (const p of (rule.patterns || [])) {
			try {
				const re = new RegExp(p, "gi");
				if (re.test(text)) {
					const matched = text.match(re)?.[0] || null;
					auditEvent(rule, "blocked-response", `Pattern matched: ${re.source}`, matched, text, "response");
					return { blocked: true, message: rule.message || `Response blocked by rule: ${rule.name}` };
				}
			} catch {}
		}
	}
	return { blocked: false };
}

// ─── Rules API handlers ──────────────────────────────────────────────────────

function handleRulesList(req, res) {
	const config = loadConfig();
	res.writeHead(200, json());
	res.end(JSON.stringify({ rules: config.rules || [] }));
}

async function handleRulesCreate(req, res) {
	const body = JSON.parse(await readBody(req));
	const config = loadConfig();
	const rule = {
		name: body.name || `rule-${Date.now()}`,
		enabled: body.enabled !== false,
		type: body.type || "warn",
		scope: body.scope || "request",
		patterns: body.patterns || [],
		replacement: body.replacement,
		message: body.message,
		allow: body.allow,
		deny: body.deny,
		maxRequests: body.maxRequests,
		windowSeconds: body.windowSeconds,
	};
	config.rules.push(rule);
	saveConfig(config);
	res.writeHead(201, json());
	res.end(JSON.stringify({ rule }));
}

async function handleRulesUpdate(req, res, ruleName) {
	const body = JSON.parse(await readBody(req));
	const config = loadConfig();
	const idx = config.rules.findIndex((r) => r.name === ruleName);
	if (idx < 0) { res.writeHead(404, json()); res.end(JSON.stringify({ error: { message: "Rule not found" } })); return; }
	config.rules[idx] = { ...config.rules[idx], ...body };
	saveConfig(config);
	res.writeHead(200, json());
	res.end(JSON.stringify({ rule: config.rules[idx] }));
}

function handleRulesDelete(req, res, ruleName) {
	const config = loadConfig();
	config.rules = config.rules.filter((r) => r.name !== ruleName);
	saveConfig(config);
	res.writeHead(200, json());
	res.end(JSON.stringify({ deleted: ruleName }));
}

function handleAuditLog(req, res) {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const limit = parseInt(url.searchParams.get("limit") || "100", 10);
	res.writeHead(200, json());
	res.end(JSON.stringify({ entries: auditLog.slice(-limit).reverse() }));
}

/** Sort providers by quota (best first). Providers with unknown quota go last. */
async function sortByQuota(providers) {
	const results = await Promise.all(
		providers.map(async (prov) => ({ prov, score: await checkQuota(prov) })),
	);
	results.sort((a, b) => {
		if (a.score === null && b.score === null) return 0;
		if (a.score === null) return 1;
		if (b.score === null) return -1;
		return b.score - a.score;
	});
	const best = results[0];
	if (best?.score !== null) {
		log(`[quota-first] scores: ${results.map((r) => `${r.prov}=${r.score ?? "?"}%`).join(", ")}`);
	}
	return results.map((r) => r.prov);
}

// ─── Custom selector script loader ────────────────────────────────────────────

const selectorCache = new Map();

async function loadSelector(scriptPath) {
	let resolved = scriptPath;
	if (!scriptPath.startsWith("/") && !scriptPath.startsWith("~/")) {
		resolved = join(AGENT_DIR, scriptPath);
	} else if (scriptPath.startsWith("~/")) {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		resolved = join(home, scriptPath.slice(2));
	}
	if (selectorCache.has(resolved)) return selectorCache.get(resolved);
	if (!existsSync(resolved)) { selectorCache.set(resolved, null); return null; }
	try {
		const mod = await import(resolved);
		const fn = typeof mod.default === "function" ? mod.default : typeof mod === "function" ? mod : null;
		selectorCache.set(resolved, fn);
		return fn;
	} catch { selectorCache.set(resolved, null); return null; }
}

async function runCustomSelector(pool, available, currentProvider, modelId) {
	if (!pool.selectorScript) return null;
	const fn = await loadSelector(pool.selectorScript);
	if (!fn) return null;
	const now = new Date();
	try {
		const result = await fn({
			members: [...available],
			currentProvider: currentProvider || "",
			modelId,
			pool: { name: pool.name, baseProvider: pool.baseProvider, members: [...pool.members] },
			timestamp: now.getTime(),
			hour: now.getHours(),
			day: getDayOfWeek(now),
		});
		if (typeof result === "string" && available.includes(result)) return result;
		if (Array.isArray(result)) {
			const first = result.find((r) => typeof r === "string" && available.includes(r));
			if (first) return first;
		}
	} catch { /* fall through */ }
	return null;
}

// ─── Model resolution ─────────────────────────────────────────────────────────

function tryGetModel(providerName, modelId) {
	const base = getBaseProvider(providerName);
	if (!base) return null;
	try {
		const m = getModel(base, modelId);
		return base !== providerName ? { ...m, provider: providerName } : m;
	} catch { return null; }
}

/**
 * Resolve a model ID (or preset name) into an ordered list of
 * { model, provider, modelId } candidates, respecting pools, chains,
 * presets, strategies, and exhausted state.
 */
/** Apply a pool's strategy to order its members. Returns reordered array. */
async function applyPoolStrategy(pool, members, modelId) {
	if (members.length <= 1) return members;
	const strategy = pool.strategy || "round-robin";
	let ordered = members;

	if (strategy === "scheduled" && pool.memberSchedule) {
		ordered = getScheduledOrder(pool, members);
		if (ordered.length > 0) log(`[pool:${pool.name}] scheduled: ${ordered[0]} selected`);
	} else if (strategy === "custom" && pool.selectorScript) {
		const best = await runCustomSelector(pool, members, "", modelId);
		if (best) {
			ordered = [best, ...members.filter((m) => m !== best)];
			log(`[pool:${pool.name}] custom: selector chose ${best}`);
		}
	} else if (strategy === "quota-first") {
		ordered = await sortByQuota(members);
		if (ordered.length > 0) log(`[pool:${pool.name}] quota-first: ${ordered[0]} preferred`);
	}

	return ordered;
}

async function resolveCandidates(modelId) {
	const config = loadConfig();

	// ── 0. Pool-scoped: "pool:<name>" or "pool:<name>/<model>" ──
	const poolMatch = modelId.match(/^pool:([^/]+)(?:\/(.+))?$/);
	if (poolMatch) {
		const poolName = poolMatch[1];
		let actualModel = poolMatch[2];
		const pool = config.pools.find((p) => p.name === poolName && p.enabled);
		if (!pool) return [];

		// Auto-pick default model if none specified
		if (!actualModel) {
			try {
				const models = getModels(pool.baseProvider);
				if (models.length > 0) actualModel = models[0].id;
			} catch {}
			if (!actualModel) return [];
		}

		const candidates = [];
		const members = pool.members.filter((m) => isAvailable(m));
		const ordered = await applyPoolStrategy(pool, members, actualModel);

		for (const member of ordered) {
			const m = tryGetModel(member, actualModel);
			if (m) candidates.push({ model: m, provider: member, modelId: actualModel });
		}
		return candidates;
	}

	// ── 0b. Provider-scoped: "provider:<name>/<model>" ──
	const provMatch = modelId.match(/^provider:([^/]+)\/(.+)$/);
	if (provMatch) {
		const [, provName, actualModel] = provMatch;
		if (!isAvailable(provName)) return [];
		const m = tryGetModel(provName, actualModel);
		return m ? [{ model: m, provider: provName, modelId: actualModel }] : [];
	}

	// ── 1. Preset resolution ──
	const preset = config.presets.find(
		(p) => p.enabled && p.name.toLowerCase() === modelId.toLowerCase(),
	);
	if (preset) {
		const candidates = [];
		const used = new Set();
		for (const entry of preset.entries) {
			if (!entry.enabled) continue;

			// If the entry's provider belongs to a pool, expand to all
			// pool members (with strategy) so pool rotation happens before
			// moving to the next preset entry.
			const pool = config.pools.find(
				(p) => p.enabled && p.members.includes(entry.provider),
			);
			if (pool) {
				let members = pool.members.filter((m) => isAvailable(m) && !used.has(m));
				if (members.length > 0) {
					members = await applyPoolStrategy(pool, members, entry.model);
					for (const member of members) {
						const m = tryGetModel(member, entry.model);
						if (m) { candidates.push({ model: m, provider: member, modelId: entry.model }); used.add(member); }
					}
				}
			} else {
				if (!isAvailable(entry.provider) || used.has(entry.provider)) continue;
				const m = tryGetModel(entry.provider, entry.model);
				if (m) { candidates.push({ model: m, provider: entry.provider, modelId: entry.model }); used.add(entry.provider); }
			}
		}
		return candidates;
	}

	// ── 2. Collect all providers that serve this model ──
	const allProviders = getAllProviders();
	const raw = [];
	for (const prov of allProviders) {
		if (!isAvailable(prov)) continue;
		const m = tryGetModel(prov, modelId);
		if (m) raw.push({ model: m, provider: prov, modelId });
	}
	if (raw.length === 0) return [];

	// ── 3. Strategy-aware pool ordering ──
	const ordered = [];
	const used = new Set();

	for (const pool of config.pools) {
		if (!pool.enabled) continue;
		const poolMembers = pool.members.filter((m) => raw.some((c) => c.provider === m));
		if (poolMembers.length === 0) continue;

		const memberOrder = await applyPoolStrategy(pool, poolMembers, modelId);

		for (const member of memberOrder) {
			const match = raw.find((c) => c.provider === member);
			if (match && !used.has(member)) {
				ordered.push(match);
				used.add(member);
			}
		}
	}

	// ── 4. Chain targets (with pool strategy) ──
	for (const chain of config.chains) {
		if (!chain.enabled) continue;
		for (const entry of chain.entries) {
			if (!entry.enabled) continue;
			const pool = config.pools.find((p) => p.name === entry.pool && p.enabled);
			if (!pool) continue;
			let members = pool.members.filter((m) => isAvailable(m) && !used.has(m));
			if (members.length === 0) continue;
			members = await applyPoolStrategy(pool, members, entry.model);
			for (const member of members) {
				const m = tryGetModel(member, entry.model);
				if (m) {
					ordered.push({ model: m, provider: member, modelId: entry.model });
					used.add(member);
				}
			}
		}
	}

	// ── 5. Remaining non-pool providers ──
	for (const c of raw) {
		if (!used.has(c.provider)) { ordered.push(c); used.add(c.provider); }
	}

	return ordered;
}

// ─── OpenAI <-> pi-ai message conversion ──────────────────────────────────────

/**
 * Convert OpenAI-format messages to pi-ai Context.
 */
function toContext(messages, tools) {
	const ctx = { messages: [], systemPrompt: "You are a helpful assistant.", tools: undefined };

	// System prompt
	const sysMessages = messages.filter((m) => m.role === "system");
	if (sysMessages.length > 0) {
		ctx.systemPrompt = sysMessages
			.map((m) => typeof m.content === "string" ? m.content : flattenContent(m.content))
			.join("\n\n");
	}

	// Messages (skip system)
	for (const m of messages) {
		if (m.role === "system") continue;
		const ts = Date.now();

		if (m.role === "user") {
			ctx.messages.push({
				role: "user",
				content: convertUserContent(m.content),
				timestamp: ts,
			});

		} else if (m.role === "assistant") {
			const content = [];

			// Text content
			if (m.content) {
				content.push({ type: "text", text: typeof m.content === "string" ? m.content : flattenContent(m.content) });
			}

			// Tool calls
			if (m.tool_calls) {
				for (const tc of m.tool_calls) {
					content.push({
						type: "toolCall",
						id: tc.id,
						name: tc.function.name,
						arguments: safeParseJson(tc.function.arguments),
					});
				}
			}

			ctx.messages.push({
				role: "assistant",
				content,
				api: "openai-completions",
				provider: "proxy",
				model: "proxy",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: m.tool_calls ? "toolUse" : "stop",
				timestamp: ts,
			});

		} else if (m.role === "tool") {
			ctx.messages.push({
				role: "toolResult",
				toolCallId: m.tool_call_id,
				toolName: m.name || "",
				content: [{ type: "text", text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }],
				isError: false,
				timestamp: ts,
			});
		}
	}

	// Tools
	if (tools && tools.length > 0) {
		ctx.tools = tools.map((t) => ({
			name: t.function.name,
			description: t.function.description || "",
			parameters: t.function.parameters || { type: "object", properties: {} },
		}));
	}

	return ctx;
}

function convertUserContent(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return String(content);

	// Multi-part content (text + images)
	const parts = [];
	for (const part of content) {
		if (part.type === "text") {
			parts.push({ type: "text", text: part.text });
		} else if (part.type === "image_url") {
			const url = part.image_url?.url || "";
			if (url.startsWith("data:")) {
				// data:image/png;base64,...
				const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
				if (match) {
					parts.push({ type: "image", data: match[2], mimeType: match[1] });
				}
			} else {
				// URL-based image -- download and convert to base64
				parts.push({ type: "text", text: `[Image: ${url}]` });
			}
		}
	}
	return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}

function flattenContent(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((p) => p.text || "").join("");
	}
	return String(content);
}

function safeParseJson(str) {
	try { return JSON.parse(str); } catch { return {}; }
}

/**
 * Map pi-ai stop reason to OpenAI finish_reason.
 */
function mapFinishReason(reason) {
	switch (reason) {
		case "stop": return "stop";
		case "length": return "length";
		case "toolUse": return "tool_calls";
		default: return "stop";
	}
}

// ─── OpenAI response builders ─────────────────────────────────────────────────

function chunk(id, model, delta, finishReason, usage) {
	const c = {
		id,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, delta, finish_reason: finishReason || null }],
	};
	if (usage) c.usage = usage;
	return c;
}

function completionResponse(id, model, message, usage) {
	return {
		id,
		object: "chat.completion",
		created: Math.floor(Date.now() / 1000),
		model,
		choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
		usage,
	};
}

function formatUsage(u) {
	if (!u) return undefined;
	return {
		prompt_tokens: u.input || 0,
		completion_tokens: u.output || 0,
		total_tokens: u.totalTokens || 0,
	};
}

// ─── Streaming handler ────────────────────────────────────────────────────────

async function handleStreaming(res, model, context, opts, requestModelId, actualProvider) {
	const t0 = Date.now();
	res.writeHead(200, {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache",
		Connection: "keep-alive",
	});

	const id = `chatcmpl-leeloo-${Date.now()}`;
	const eventStream = stream(model, context, opts);
	let sentRole = false;
	const toolCalls = new Map(); // contentIndex -> { index, id, name, args }
	let toolCallIdx = 0;

	const write = (data) => {
		if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`);
	};

	for await (const event of eventStream) {
		if (res.destroyed) break;

		switch (event.type) {
			case "text_start": {
				if (!sentRole) {
					write(chunk(id, requestModelId, { role: "assistant", content: "" }, null));
					sentRole = true;
				}
				break;
			}

			case "text_delta": {
				if (!sentRole) {
					write(chunk(id, requestModelId, { role: "assistant", content: event.delta }, null));
					sentRole = true;
				} else {
					write(chunk(id, requestModelId, { content: event.delta }, null));
				}
				break;
			}

			case "thinking_delta": {
				// Some clients support reasoning -- send as a custom field
				// For now, skip thinking content in the stream
				break;
			}

			case "toolcall_start": {
				const idx = toolCallIdx++;
				toolCalls.set(event.contentIndex, { index: idx, id: "", name: "", args: "" });
				break;
			}

			case "toolcall_delta": {
				const tc = toolCalls.get(event.contentIndex);
				if (tc) tc.args += event.delta;
				break;
			}

			case "toolcall_end": {
				const tc = toolCalls.get(event.contentIndex);
				if (!tc) break;
				tc.id = event.toolCall.id;
				tc.name = event.toolCall.name;
				tc.args = JSON.stringify(event.toolCall.arguments);

				if (!sentRole) {
					write(chunk(id, requestModelId, {
						role: "assistant",
						content: null,
						tool_calls: [{
							index: tc.index,
							id: tc.id,
							type: "function",
							function: { name: tc.name, arguments: tc.args },
						}],
					}, null));
					sentRole = true;
				} else {
					write(chunk(id, requestModelId, {
						tool_calls: [{
							index: tc.index,
							id: tc.id,
							type: "function",
							function: { name: tc.name, arguments: tc.args },
						}],
					}, null));
				}
				break;
			}

			case "done": {
				const finish = toolCalls.size > 0 ? "tool_calls" : mapFinishReason(event.reason);
				const usage = formatUsage(event.message?.usage);
				trackRequest(actualProvider, model.id, event.message?.usage, Date.now() - t0, null);
				const finalChunk = chunk(id, requestModelId, {}, finish, usage);
				finalChunk.x_provider = actualProvider;
				finalChunk.x_model = model.id;
				finalChunk.x_label = getProviderLabel(actualProvider);
				write(finalChunk);
				res.write("data: [DONE]\n\n");
				break;
			}

			case "error": {
				const errMsg = event.error?.errorMessage || "Unknown error";
				trackRequest(actualProvider, model.id, null, Date.now() - t0, errMsg);
				if (isRateLimit(errMsg)) throw new Error(errMsg);
				if (!sentRole) {
					write(chunk(id, requestModelId, { role: "assistant", content: `[Error: ${errMsg}]` }, null));
				} else {
					write(chunk(id, requestModelId, { content: `\n[Error: ${errMsg}]` }, null));
				}
				write(chunk(id, requestModelId, {}, "stop"));
				res.write("data: [DONE]\n\n");
				break;
			}
		}
	}

	res.end();
}

// ─── Non-streaming handler ────────────────────────────────────────────────────

async function handleNonStreaming(res, model, context, opts, requestModelId, actualProvider) {
	const t0 = Date.now();
	const eventStream = stream(model, context, opts);
	let fullText = "";
	const toolCalls = [];
	let usage = null;
	let finishReason = "stop";

	for await (const event of eventStream) {
		switch (event.type) {
			case "text_delta":
				fullText += event.delta;
				break;
			case "toolcall_end":
				toolCalls.push({
					id: event.toolCall.id,
					type: "function",
					function: {
						name: event.toolCall.name,
						arguments: JSON.stringify(event.toolCall.arguments),
					},
				});
				break;
			case "done":
				usage = event.message?.usage;
				finishReason = event.reason;
				trackRequest(actualProvider, model.id, usage, Date.now() - t0, null);
				break;
			case "error": {
				const errMsg = event.error?.errorMessage || "Unknown error";
				trackRequest(actualProvider, model.id, null, Date.now() - t0, errMsg);
				if (isRateLimit(errMsg)) throw new Error(errMsg);
				throw new Error(errMsg);
			}
		}
	}

	// ── Response-side rule evaluation ──
	const respRules = loadConfig().rules || [];
	if (respRules.length > 0 && fullText) {
		const respBlock = checkResponseBlock(respRules, fullText);
		if (respBlock.blocked) {
			res.writeHead(403, json());
			res.end(JSON.stringify({ error: { message: respBlock.message } }));
			return;
		}
		fullText = redactResponse(respRules, fullText);
	}

	const message = { role: "assistant" };
	if (toolCalls.length > 0) {
		message.content = fullText || null;
		message.tool_calls = toolCalls;
	} else {
		message.content = fullText;
	}

	const id = `chatcmpl-leeloo-${Date.now()}`;
	const response = completionResponse(id, requestModelId, message, formatUsage(usage));
	response.choices[0].finish_reason = toolCalls.length > 0 ? "tool_calls" : mapFinishReason(finishReason);
	response.x_provider = actualProvider;
	response.x_model = model.id;
	response.x_label = getProviderLabel(actualProvider);

	res.writeHead(200, { "Content-Type": "application/json" });
	res.end(JSON.stringify(response));
}

// ─── Main request handler ─────────────────────────────────────────────────────

async function handleChatCompletions(req, res) {
	const body = await readBody(req);
	let parsed;
	try { parsed = JSON.parse(body); }
	catch {
		res.writeHead(400, json());
		res.end(JSON.stringify({ error: { message: "Invalid JSON body" } }));
		return;
	}

	const {
		model: requestModelId,
		messages,
		tools,
		tool_choice,
		stream: doStream,
		temperature,
		max_tokens,
		max_completion_tokens,
		top_p,
		stop,
		reasoning_effort,
	} = parsed;

	if (!requestModelId || !messages) {
		res.writeHead(400, json());
		res.end(JSON.stringify({ error: { message: "model and messages are required" } }));
		return;
	}

	// ── Rule evaluation: pre-flight ──
	const rules = loadConfig().rules || [];
	if (rules.length > 0) {
		// Rate limits
		const rateCheck = evaluateRateLimitRules(rules);
		if (!rateCheck.allowed) {
			res.writeHead(429, { ...json(), ...(rateCheck.retryAfter ? { "Retry-After": String(rateCheck.retryAfter) } : {}) });
			res.end(JSON.stringify({ error: { message: rateCheck.message } }));
			return;
		}
		// Model access
		const modelCheck = evaluateModelRules(rules, requestModelId);
		if (!modelCheck.allowed) {
			res.writeHead(403, json());
			res.end(JSON.stringify({ error: { message: modelCheck.message } }));
			return;
		}
		// Content: block/redact/warn on request
		const contentCheck = evaluateContentRules(rules, parsed.messages, "request");
		if (contentCheck.blocked) {
			res.writeHead(403, json());
			res.end(JSON.stringify({ error: { message: contentCheck.message } }));
			return;
		}
		parsed.messages = contentCheck.messages; // may be redacted
	}

	const candidates = await resolveCandidates(requestModelId);
	if (candidates.length === 0) {
		res.writeHead(404, json());
		res.end(JSON.stringify({ error: { message: `No provider found for model "${requestModelId}"` } }));
		return;
	}

	const context = toContext(messages, tools);
	const maxAttempts = Math.min(candidates.length, 5);
	let lastError = null;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const candidate = candidates[attempt];

		try {
			const apiKey = await authStorage.getApiKey(candidate.provider);
			if (!apiKey) {
				log(`[${candidate.provider}] no API key, skipping`);
				continue;
			}

			const opts = {
				apiKey,
				temperature,
				maxTokens: max_completion_tokens || max_tokens,
				...(top_p !== undefined && { top_p }),
				...(stop && { stop }),
			};

			log(`[${candidate.provider}] ${candidate.modelId} (attempt ${attempt + 1}/${maxAttempts})`);

			if (doStream) {
				await handleStreaming(res, candidate.model, context, opts, requestModelId, candidate.provider);
			} else {
				await handleNonStreaming(res, candidate.model, context, opts, requestModelId, candidate.provider);
			}
			return;

		} catch (err) {
			const errMsg = err?.message || String(err);
			log(`[${candidate.provider}] error: ${errMsg}`);
			lastError = errMsg;

			if (isRateLimit(errMsg)) {
				markExhausted(candidate.provider);
				log(`[${candidate.provider}] rate limited, failover -> next candidate`);
				if (res.headersSent) return;
				continue;
			}
			if (attempt < maxAttempts - 1 && !res.headersSent) continue;

			if (!res.headersSent) {
				res.writeHead(502, json());
				res.end(JSON.stringify({ error: { message: `Provider error: ${errMsg}` } }));
			}
			return;
		}
	}

	if (!res.headersSent) {
		const tried = candidates.slice(0, maxAttempts).map((c) => c.provider).join(", ");
		res.writeHead(502, json());
		res.end(JSON.stringify({ error: { message: `All providers failed for "${requestModelId}" (tried: ${tried}). Last error: ${lastError}` } }));
	}
}

// ─── /v1/models ───────────────────────────────────────────────────────────────

function handleModels(req, res) {
	const allProviders = getAllProviders();
	const unique = new Map();

	for (const prov of allProviders) {
		const base = getBaseProvider(prov);
		if (!base) continue;
		try {
			for (const m of getModels(base)) {
				if (!unique.has(m.id)) {
					unique.set(m.id, { id: m.id, object: "model", created: 0, owned_by: prov });
				}
			}
		} catch { /* skip */ }
	}

	// Add preset names as virtual models
	const config = loadConfig();
	for (const preset of config.presets) {
		if (!preset.enabled) continue;
		unique.set(`preset:${preset.name}`, {
			id: preset.name,
			object: "model",
			created: 0,
			owned_by: "pi-multi-pass",
		});
	}

	res.writeHead(200, json());
	res.end(JSON.stringify({ object: "list", data: [...unique.values()] }));
}

// ─── /health ──────────────────────────────────────────────────────────────────

/** Returns only models/presets from multi-pass config -- used by the chat UI. */
function handleRouting(req, res) {
	const config = loadConfig();
	const groups = [];

	// Presets
	const presets = config.presets.filter((p) => p.enabled);
	if (presets.length > 0) {
		groups.push({
			label: "Presets",
			items: presets.map((p) => ({
				id: p.name,
				name: p.name,
				detail: p.entries.filter((e) => e.enabled).map((e) => `${e.provider}/${e.model}`).join(" -> "),
			})),
		});
	}

	// Pools -- pool-level entry (auto-picks default model) + per-model entries
	const enabledPools = config.pools.filter((p) => p.enabled);
	if (enabledPools.length > 0) {
		const poolItems = [];
		for (const pool of enabledPools) {
			try {
				const models = getModels(pool.baseProvider);
				const available = pool.members.filter((m) => authStorage.hasAuth(m));
				if (available.length === 0) continue;
				const strat = pool.strategy || "round-robin";
				const defaultModel = models[0]?.id || "?";

				// Pool-level auto entry
				poolItems.push({
					id: `pool:${pool.name}`,
					name: `${pool.name}`,
					detail: `[${strat}] ${available.length} members, default: ${defaultModel}`,
				});

				// Per-model entries
				for (const m of models) {
					poolItems.push({
						id: `pool:${pool.name}/${m.id}`,
						name: `  ${pool.name} / ${m.id}`,
						detail: `[${strat}] via ${available.join(", ")}`,
					});
				}
			} catch { /* skip */ }
		}
		if (poolItems.length > 0) {
			groups.push({ label: "Pools", items: poolItems });
		}
	}

	// Non-pool providers
	const pooled = new Set(config.pools.flatMap((p) => p.members));
	const standalone = getAllProviders().filter((p) => !pooled.has(p));
	if (standalone.length > 0) {
		const provItems = [];
		for (const prov of standalone) {
			const base = getBaseProvider(prov);
			if (!base) continue;
			try {
				const models = getModels(base);
				for (const m of models) {
					provItems.push({
						id: `provider:${prov}/${m.id}`,
						name: `${prov} / ${m.id}`,
						detail: prov,
					});
				}
			} catch { /* skip */ }
		}
		if (provItems.length > 0) {
			groups.push({ label: "Providers", items: provItems });
		}
	}

	res.writeHead(200, json());
	res.end(JSON.stringify({ groups }));
}

/** Detailed quota for all providers: windows, models, reset times. */
async function handleQuota(req, res) {
	const providers = getAllProviders();
	const results = await Promise.all(providers.map(async (prov) => {
		const detail = await checkQuotaDetailed(prov);
		return {
			provider: prov,
			label: getProviderLabel(prov),
			baseProvider: getBaseProvider(prov),
			exhausted: isExhausted(prov),
			...detail,
		};
	}));
	res.writeHead(200, json());
	res.end(JSON.stringify({
		timestamp: new Date().toISOString(),
		providers: results,
	}));
}

/** Usage stats: per-provider aggregates + recent request log. */
function handleStats(req, res) {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const limit = parseInt(url.searchParams.get("limit") || "50", 10);

	// Compute session totals
	let totalRequests = 0, totalTokensIn = 0, totalTokensOut = 0, totalErrors = 0;
	for (const s of Object.values(providerStats)) {
		totalRequests += s.requests;
		totalTokensIn += s.tokens_in;
		totalTokensOut += s.tokens_out;
		totalErrors += s.errors;
	}

	res.writeHead(200, json());
	res.end(JSON.stringify({
		timestamp: new Date().toISOString(),
		session: {
			total_requests: totalRequests,
			total_tokens_in: totalTokensIn,
			total_tokens_out: totalTokensOut,
			total_errors: totalErrors,
		},
		providers: Object.entries(providerStats).map(([prov, s]) => ({
			provider: prov,
			label: getProviderLabel(prov),
			...s,
		})),
		recent: usageLog.slice(-limit).reverse(),
	}));
}

function handleHealth(req, res) {
	const config = loadConfig();
	const providers = getAllProviders();
	const exhausted = providers.filter((p) => isExhausted(p));
	res.writeHead(200, json());
	res.end(JSON.stringify({
		status: "ok",
		providers,
		exhausted,
		pools: config.pools.filter((p) => p.enabled).map((p) => ({
			name: p.name,
			strategy: p.strategy || "round-robin",
			members: p.members,
		})),
		chains: config.chains.filter((c) => c.enabled).map((c) => c.name),
		presets: config.presets.filter((p) => p.enabled).map((p) => ({
			name: p.name,
			entries: p.entries.filter((e) => e.enabled).map((e) => `${e.provider}/${e.model}`),
		})),
	}));
}

// ─── HTTP plumbing ────────────────────────────────────────────────────────────

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString()));
		req.on("error", reject);
	});
}
function json() { return { "Content-Type": "application/json" }; }
function log(...a) { console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a); }

// ─── Chat UI ──────────────────────────────────────────────────────────────────

function handleAdmin(req, res) {
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	res.end(ADMIN_UI_HTML);
}

const ADMIN_UI_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leeloo Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0a;color:#e0e0e0;height:100vh;display:flex;flex-direction:column}
header{background:#111;border-bottom:1px solid #222;padding:12px 20px;display:flex;align-items:center;gap:16px}
header h1{font-size:15px;color:#f90;font-weight:700}
header a{color:#666;text-decoration:none;font-size:12px;padding:4px 10px;border:1px solid #333;border-radius:5px}
header a:hover{color:#aaa;border-color:#666}
.tabs{display:flex;gap:0;border-bottom:1px solid #222;background:#111}
.tab{padding:10px 20px;font-size:13px;color:#888;cursor:pointer;border-bottom:2px solid transparent}
.tab:hover{color:#ccc}
.tab.active{color:#f90;border-color:#f90}
.panel{flex:1;overflow-y:auto;padding:20px;display:none}
.panel.active{display:block}
h2{font-size:14px;color:#999;margin:0 0 12px;text-transform:uppercase;letter-spacing:1px}
.card{background:#111;border:1px solid #222;border-radius:8px;padding:14px;margin-bottom:10px}
.card .name{font-weight:600;color:#eee;font-size:14px}
.card .meta{font-size:11px;color:#666;margin-top:4px}
.card .badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600}
.badge.on{background:#1a3a1a;color:#4a4;border:1px solid #2a4a2a}
.badge.off{background:#3a1a1a;color:#a44;border:1px solid #4a2a2a}
.badge.block{background:#3a1a1a;color:#f66}
.badge.redact{background:#3a2a1a;color:#fa0}
.badge.warn{background:#1a2a3a;color:#6af}
.badge.model{background:#2a1a3a;color:#a6f}
.badge.limit{background:#1a1a2a;color:#66f}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #1a1a1a}
th{color:#888;font-weight:600;font-size:11px;text-transform:uppercase}
td{color:#ccc}
.bar{display:inline-block;width:50px;height:8px;background:#222;border-radius:4px;overflow:hidden;vertical-align:middle}
.bar-fill{height:100%;border-radius:4px}
.btn{background:#1a1a1a;color:#ccc;border:1px solid #333;border-radius:5px;padding:5px 12px;font-size:12px;cursor:pointer}
.btn:hover{border-color:#666;color:#fff}
.btn.danger{border-color:#4a2a2a;color:#f66}
.btn.danger:hover{background:#3a1a1a}
.btn.primary{background:#f90;color:#000;border-color:#f90;font-weight:600}
.form{display:flex;flex-direction:column;gap:8px;max-width:500px}
.form label{font-size:12px;color:#888}
.form input,.form select,.form textarea{background:#1a1a1a;color:#eee;border:1px solid #333;border-radius:5px;padding:6px 10px;font-size:13px;font-family:inherit}
.form input:focus,.form select:focus,.form textarea:focus{border-color:#f90;outline:none}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-bottom:20px}
.stat-card{background:#111;border:1px solid #222;border-radius:8px;padding:14px;text-align:center}
.stat-card .num{font-size:24px;font-weight:700;color:#f90}
.stat-card .label{font-size:11px;color:#666;margin-top:4px}
.empty{color:#555;font-style:italic;padding:20px;text-align:center}
</style>
</head><body>
<header>
  <h1>Leeloo Admin</h1>
  <a href="/ui">Chat UI</a>
  <a href="/health">Health API</a>
</header>
<div class="tabs">
  <div class="tab active" onclick="showTab('dashboard')">Dashboard</div>
  <div class="tab" onclick="showTab('rules')">Rules</div>
  <div class="tab" onclick="showTab('audit')">Audit Log</div>
  <div class="tab" onclick="showTab('config')">Config</div>
</div>

<div id="dashboard" class="panel active"></div>
<div id="rules" class="panel"></div>
<div id="audit" class="panel"></div>
<div id="config" class="panel"></div>

<script>
const BASE = location.origin;
function esc(s){return String(s).replace(/&/g,"&amp;").replace(/\x3c/g,"\x26lt;").replace(/>/g,"\x26gt;")}
function showTab(id){document.querySelectorAll(".tab").forEach((t,i)=>{t.classList.toggle("active",t.textContent.toLowerCase().replace(" ","")===id)});document.querySelectorAll(".panel").forEach(p=>{p.classList.toggle("active",p.id===id)});loaders[id]?.()}
function qc(pct){return pct==null?"#555":pct>50?"#4a4":pct>20?"#ca0":"#e44"}
function bar(pct){if(pct==null)return"--";return'<span class="bar"><span class="bar-fill" style="width:'+pct+"%;background:"+qc(pct)+'"></span></span> '+pct+"%"}
function ago(ts){if(!ts)return"--";const d=Date.now()-new Date(ts).getTime();if(d<60000)return Math.round(d/1000)+"s ago";if(d<3600000)return Math.round(d/60000)+"m ago";return Math.round(d/3600000)+"h ago"}

const loaders = {
  async dashboard() {
    const [stats,quota,health] = await Promise.all([
      fetch(BASE+"/v1/stats").then(r=>r.json()),
      fetch(BASE+"/v1/quota").then(r=>r.json()),
      fetch(BASE+"/health").then(r=>r.json()),
    ]);
    const s = stats.session||{};
    let h = '<h2>Session Overview</h2><div class="stat-grid">';
    h += '<div class="stat-card"><div class="num">'+s.total_requests+'</div><div class="label">Requests</div></div>';
    h += '<div class="stat-card"><div class="num">'+s.total_tokens_in+'</div><div class="label">Tokens In</div></div>';
    h += '<div class="stat-card"><div class="num">'+s.total_tokens_out+'</div><div class="label">Tokens Out</div></div>';
    h += '<div class="stat-card"><div class="num">'+s.total_errors+'</div><div class="label">Errors</div></div>';
    h += '</div>';

    h += '<h2>Provider Health</h2><table><tr><th>Provider</th><th>Quota</th><th>Status</th><th>Requests</th><th>Tokens</th><th>Last Used</th></tr>';
    for(const p of quota.providers||[]){
      const ps = (stats.providers||[]).find(x=>x.provider===p.provider)||{};
      const exh = (health.exhausted||[]).includes(p.provider);
      h+='<tr><td>'+esc(p.label||p.provider)+'</td><td>'+bar(p.score)+'</td>';
      h+='<td>'+(exh?'<span class="badge off">exhausted</span>':'<span class="badge on">'+esc(p.status)+'</span>')+'</td>';
      h+='<td>'+(ps.requests||0)+'</td><td>'+(ps.tokens_in||0)+' / '+(ps.tokens_out||0)+'</td>';
      h+='<td>'+ago(ps.last_used)+'</td></tr>';
    }
    h+='</table>';

    h+='<h2>Recent Requests</h2><table><tr><th>Time</th><th>Provider</th><th>Model</th><th>Tokens</th><th>Duration</th><th>Error</th></tr>';
    for(const r of (stats.recent||[]).slice(0,20)){
      h+='<tr><td>'+ago(r.timestamp)+'</td><td>'+esc(r.provider)+'</td><td>'+esc(r.model)+'</td>';
      h+='<td>'+r.tokens_in+' / '+r.tokens_out+'</td><td>'+r.duration_ms+'ms</td>';
      h+='<td>'+(r.error?'<span class="badge off">'+esc(r.error).slice(0,40)+'</span>':'--')+'</td></tr>';
    }
    h+='</table>';
    document.getElementById("dashboard").innerHTML = h;
  },

  async rules() {
    const data = await fetch(BASE+"/v1/rules").then(r=>r.json());
    let h = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px"><h2 style="margin:0">Policy Rules</h2><button class="btn primary" onclick="showRuleForm()">+ Add Rule</button></div>';
    h += '<div id="rule-form-area"></div>';
    if(!data.rules||data.rules.length===0){h+='<div class="empty">No rules configured. Add rules to enforce DLP policies, model restrictions, or rate limits.</div>';}
    else{for(const r of data.rules){
      h+='<div class="card"><div style="display:flex;justify-content:space-between;align-items:center"><div>';
      h+='<span class="name">'+esc(r.name)+'</span> ';
      h+='<span class="badge '+esc(r.type)+'">'+esc(r.type)+'</span> ';
      h+='<span class="badge '+(r.enabled?"on":"off")+'">'+(r.enabled?"enabled":"disabled")+'</span>';
      h+='</div><div>';
      h+='<button class="btn" data-action="toggle" data-rule="'+esc(r.name)+'" data-val="'+(!r.enabled)+'">'+(r.enabled?"Disable":"Enable")+'</button> ';
      h+='<button class="btn danger" data-action="delete" data-rule="'+esc(r.name)+'">Delete</button>';
      h+='</div></div>';
      h+='<div class="meta">';
      if(r.scope)h+='scope: '+esc(r.scope)+' | ';
      if(r.patterns?.length)h+='patterns: '+r.patterns.map(p=>esc(p)).join(", ")+' | ';
      if(r.allow?.length)h+='allow: '+r.allow.join(", ")+' | ';
      if(r.deny?.length)h+='deny: '+r.deny.join(", ")+' | ';
      if(r.maxRequests)h+=r.maxRequests+' req/'+r.windowSeconds+'s | ';
      if(r.replacement)h+='replacement: '+esc(r.replacement)+' | ';
      if(r.message)h+='message: '+esc(r.message);
      h+='</div></div>';
    }}
    document.getElementById("rules").innerHTML = h;
  },

  async audit() {
    const data = await fetch(BASE+"/v1/audit").then(r=>r.json());
    let h = '<h2>Audit Log</h2>';
    if(!data.entries?.length){h+='<div class="empty">No audit events yet. Events appear when rules match requests or responses.</div>';}
    else{h+='<table><tr><th>Time</th><th>Rule</th><th>Type</th><th>Action</th><th>Source</th><th>Detail</th><th>Matched</th><th>Full message</th></tr>';
    for(const e of data.entries){
      const fullMsg = e.full_message
        ? '<details><summary>view ('+e.full_message.length+' chars)</summary><pre style="white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto;background:#0a0a0a;border:1px solid #222;border-radius:6px;padding:8px;margin-top:6px">'+esc(e.full_message)+'</pre></details>'
        : '--';
      h+='<tr><td>'+ago(e.timestamp)+'</td><td>'+esc(e.rule)+'</td>';
      h+='<td><span class="badge '+esc(e.type)+'">'+esc(e.type)+'</span></td>';
      h+='<td>'+esc(e.action)+'</td><td>'+esc(e.source||'--')+'</td><td>'+esc(e.detail)+'</td>';
      h+='<td>'+(e.matched_text?esc(e.matched_text):'--')+'</td>';
      h+='<td>'+fullMsg+'</td></tr>';
    }h+='</table>';}
    document.getElementById("audit").innerHTML = h;
  },

  async config() {
    const [health,routing] = await Promise.all([
      fetch(BASE+"/health").then(r=>r.json()),
      fetch(BASE+"/v1/routing").then(r=>r.json()),
    ]);
    let h = '<h2>Active Configuration</h2>';
    h+='<h2 style="font-size:12px;margin-top:16px">Pools</h2>';
    for(const p of health.pools||[]){
      h+='<div class="card"><span class="name">'+esc(p.name)+'</span> <span class="badge on">'+esc(p.strategy)+'</span>';
      h+='<div class="meta">Members: '+p.members.map(m=>esc(m)).join(", ")+'</div></div>';
    }
    h+='<h2 style="font-size:12px;margin-top:16px">Chains</h2>';
    if(!health.chains?.length)h+='<div class="empty">No chains</div>';
    else for(const c of health.chains){h+='<div class="card"><span class="name">'+esc(c)+'</span></div>';}
    h+='<h2 style="font-size:12px;margin-top:16px">Presets</h2>';
    for(const p of health.presets||[]){
      h+='<div class="card"><span class="name">'+esc(p.name)+'</span>';
      h+='<div class="meta">'+p.entries.map(e=>esc(e)).join(" -> ")+'</div></div>';
    }
    h+='<h2 style="font-size:12px;margin-top:16px">Providers</h2>';
    for(const p of health.providers||[]){
      const exh=(health.exhausted||[]).includes(p);
      h+='<div class="card"><span class="name">'+esc(p)+'</span> <span class="badge '+(exh?"off":"on")+'">'+(exh?"exhausted":"ok")+'</span></div>';
    }
    document.getElementById("config").innerHTML = h;
  }
};

async function toggleRule(name,enabled){
  await fetch(BASE+"/v1/rules/"+encodeURIComponent(name),{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({enabled})});
  loaders.rules();
}
async function deleteRule(name){
  if(!confirm("Delete rule "+name+"?"))return;
  await fetch(BASE+"/v1/rules/"+encodeURIComponent(name),{method:"DELETE"});
  loaders.rules();
}
function showRuleForm(){
  const area=document.getElementById("rule-form-area");
  if(area.innerHTML){area.innerHTML="";return;}
  area.innerHTML='<div class="card"><div class="form">'
    +'<label>Name</label><input id="rf-name" placeholder="e.g. block-secrets">'
    +'<label>Type</label><select id="rf-type"><option value="block">block</option><option value="redact">redact</option><option value="warn">warn</option><option value="model">model (allow/deny)</option><option value="limit">rate limit</option></select>'
    +'<label>Scope</label><select id="rf-scope"><option value="request">request</option><option value="response">response</option><option value="both">both</option></select>'
    +'<label>Patterns (one per line, regex)</label><textarea id="rf-patterns" rows="3" placeholder="AKIA[0-9A-Z]{16}\\nsk-[a-zA-Z0-9]{48}"></textarea>'
    +'<label>Replacement (for redact)</label><input id="rf-replacement" placeholder="[REDACTED]">'
    +'<label>Message (shown when blocked)</label><input id="rf-message" placeholder="Request blocked: contains secrets">'
    +'<label>Model allow list (comma-separated, for model type)</label><input id="rf-allow" placeholder="claude-*, gpt-5*">'
    +'<label>Model deny list</label><input id="rf-deny" placeholder="gpt-4o*">'
    +'<label>Max requests (for limit type)</label><input id="rf-max" type="number" placeholder="60">'
    +'<label>Window seconds</label><input id="rf-window" type="number" placeholder="60">'
    +'<div style="display:flex;gap:8px;margin-top:8px"><button class="btn primary" data-action="create-rule">Create Rule</button><button class="btn" data-action="cancel-form">Cancel</button></div>'
    +'</div></div>';
}
async function createRule(){
  const type=document.getElementById("rf-type").value;
  const rule={
    name:document.getElementById("rf-name").value||"rule-"+Date.now(),
    type,
    enabled:true,
    scope:document.getElementById("rf-scope").value,
    patterns:document.getElementById("rf-patterns").value.split("\\n").filter(Boolean),
    replacement:document.getElementById("rf-replacement").value||undefined,
    message:document.getElementById("rf-message").value||undefined,
  };
  if(type==="model"){
    const allow=document.getElementById("rf-allow").value;
    const deny=document.getElementById("rf-deny").value;
    if(allow)rule.allow=allow.split(",").map(s=>s.trim()).filter(Boolean);
    if(deny)rule.deny=deny.split(",").map(s=>s.trim()).filter(Boolean);
  }
  if(type==="limit"){
    rule.maxRequests=parseInt(document.getElementById("rf-max").value)||60;
    rule.windowSeconds=parseInt(document.getElementById("rf-window").value)||60;
  }
  await fetch(BASE+"/v1/rules",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(rule)});
  document.getElementById("rule-form-area").innerHTML="";
  loaders.rules();
}

// Event delegation for dynamic buttons
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "toggle") { await toggleRule(btn.dataset.rule, btn.dataset.val === "true"); }
  else if (action === "delete") { await deleteRule(btn.dataset.rule); }
  else if (action === "create-rule") { await createRule(); }
  else if (action === "cancel-form") { document.getElementById("rule-form-area").innerHTML = ""; }
});

loaders.dashboard();
</script>
</body></html>`;

function handleUI(req, res) {
	res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
	res.end(CHAT_UI_HTML);
}

const CHAT_UI_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leeloo on multi-pass</title>

<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0a;color:#e0e0e0;height:100vh;display:flex;flex-direction:column}

/* ── Top bar ── */
#topbar{background:#111;border-bottom:1px solid #222;flex-shrink:0}
#bar-main{padding:10px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
#bar-main h1{font-size:14px;color:#f90;font-weight:700;letter-spacing:.5px;white-space:nowrap}
#bar-main select{background:#1a1a1a;color:#e0e0e0;border:1px solid #333;border-radius:6px;padding:6px 10px;font-size:13px;min-width:240px;cursor:pointer}
#bar-main select:focus{border-color:#f90;outline:none}
#bar-main select optgroup{color:#888;font-style:normal;font-weight:600;font-size:11px}
.bar-actions{display:flex;gap:6px;margin-left:auto;align-items:center}
.bar-btn{background:none;border:1px solid #333;color:#888;border-radius:5px;padding:3px 9px;font-size:11px;cursor:pointer}
.bar-btn:hover{border-color:#666;color:#ccc}
.dot{width:7px;height:7px;border-radius:50%;background:#444;display:inline-block}
.dot.ok{background:#4a4}.dot.busy{background:#f90;animation:blink 1s infinite}
@keyframes blink{50%{opacity:.4}}
#status-text{font-size:11px;color:#555}

/* ── Info strip ── */
#info-strip{padding:5px 20px;background:#0d0d0d;border-bottom:1px solid #1a1a1a;font-size:11px;color:#555;overflow-x:auto;white-space:nowrap;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
#info-strip .section{display:flex;gap:4px;align-items:center;margin-right:8px}
#info-strip .section-label{color:#444;font-weight:700;text-transform:uppercase;font-size:9px;letter-spacing:.5px;margin-right:2px}
#info-strip .tag{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;border:1px solid #222;background:#111}
#info-strip .tag b{color:#999;font-weight:600}
#info-strip .tag .val{color:#777}
#info-strip .tag .bar{display:inline-block;width:40px;height:6px;background:#222;border-radius:3px;overflow:hidden;vertical-align:middle}
#info-strip .tag .bar-fill{height:100%;border-radius:3px;transition:width .3s}
#info-strip .tag.pool{border-color:#2a2a3a}
#info-strip .tag.preset{border-color:#3a2a1a}
#info-strip .tag.provider{border-color:#1a2a1a}
#info-strip .tag.exhausted{border-color:#4a1a1a;opacity:.5}
#info-strip .sep{color:#222;margin:0 2px}

/* ── Chat ── */
#chat{flex:1;overflow-y:auto;padding:20px;display:flex;flex-direction:column;gap:14px}
.msg{max-width:82%;border-radius:14px;line-height:1.6;font-size:14px;word-wrap:break-word;overflow:hidden}
.msg.user{align-self:flex-end;background:#1a3a5c;color:#cde;border-bottom-right-radius:4px;padding:12px 16px;white-space:pre-wrap}
.msg.assistant{align-self:flex-start;background:#151515;border:1px solid #222;border-bottom-left-radius:4px;padding:0}
.msg .md-body{padding:12px 16px}
.msg .meta{font-size:11px;color:#555;padding:6px 16px;border-top:1px solid #222;background:#0d0d0d;display:flex;gap:12px;flex-wrap:wrap;border-radius:0 0 0 14px}
.msg .meta .provider-tag{color:#f90}
.welcome{text-align:center;color:#444;padding:60px 20px;font-size:14px;line-height:2}
.welcome h2{color:#f90;font-size:18px;margin-bottom:8px;font-weight:600}

/* ── Thinking indicator ── */
.thinking{padding:12px 16px;display:flex;align-items:center;gap:8px;color:#888;font-size:13px}
.thinking .dots{display:flex;gap:4px}
.thinking .dots span{width:6px;height:6px;border-radius:50%;background:#f90;animation:pulse 1.4s infinite}
.thinking .dots span:nth-child(2){animation-delay:.2s}
.thinking .dots span:nth-child(3){animation-delay:.4s}
@keyframes pulse{0%,80%,100%{opacity:.2;transform:scale(.8)}40%{opacity:1;transform:scale(1)}}

/* ── Markdown styles ── */
.md-body p{margin:0 0 8px}
.md-body p:last-child{margin:0}
.md-body code{background:#0d0d0d;padding:1px 5px;border-radius:3px;font-size:13px;font-family:"SF Mono",Menlo,monospace}
.md-body pre{background:#0d0d0d;padding:12px;border-radius:8px;overflow-x:auto;margin:8px 0;border:1px solid #222}
.md-body pre code{background:none;padding:0;font-size:13px}
.md-body ul,.md-body ol{margin:4px 0 4px 20px}
.md-body blockquote{border-left:3px solid #333;padding-left:12px;margin:4px 0;color:#999}
.md-body h1,.md-body h2,.md-body h3{margin:8px 0 4px;color:#ddd}
.md-body h1{font-size:18px} .md-body h2{font-size:16px} .md-body h3{font-size:14px}
.md-body table{border-collapse:collapse;margin:8px 0}
.md-body td,.md-body th{border:1px solid #333;padding:4px 8px;font-size:13px}
.md-body th{background:#1a1a1a}
.md-body a{color:#6af}
.md-body strong{color:#eee}

/* ── Input ── */
#input-area{border-top:1px solid #222;padding:10px 20px;display:flex;gap:10px;flex-shrink:0;background:#111}
#input-area textarea{flex:1;background:#1a1a1a;color:#e0e0e0;border:1px solid #333;border-radius:10px;padding:10px 14px;font-size:14px;font-family:inherit;resize:none;min-height:44px;max-height:140px;line-height:1.5}
#input-area textarea:focus{outline:none;border-color:#f90}
#input-area textarea:disabled{opacity:.5}
#input-area button{background:#f90;color:#000;border:none;border-radius:10px;padding:0 22px;font-weight:700;cursor:pointer;font-size:14px;transition:background .15s}
#input-area button:hover{background:#fa0}
#input-area button:disabled{opacity:.3;cursor:default}
</style>
</head><body>

<div id="topbar">
  <div id="bar-main">
    <h1>Leeloo on multi-pass</h1>
    <select id="model-select"><option>Loading...</option></select>
    <div class="bar-actions">
      <button class="bar-btn" onclick="clearChat()">Clear</button>
      <span class="dot" id="dot"></span>
      <span id="status-text">loading...</span>
    </div>
  </div>
  <div id="info-strip"></div>
</div>

<div id="chat">
  <div class="welcome">
    <h2>Leeloo on multi-pass</h2>
    Select a preset or model above and start chatting.<br>
    Requests route through your multi-pass pools with automatic failover.
  </div>
</div>

<div id="input-area">
  <textarea id="input" rows="1" placeholder="Type a message... (Enter to send)" autofocus></textarea>
  <button id="send" onclick="sendMessage()">Send</button>
</div>

<script type="module">
let smd = null;
try { smd = await import("https://cdn.jsdelivr.net/npm/streaming-markdown@latest/smd.min.js"); } catch {}
const BASE = location.origin;
const chat = document.getElementById("chat");
const input = document.getElementById("input");
const sel = document.getElementById("model-select");
const sendBtn = document.getElementById("send");
const statusEl = document.getElementById("status-text");
const dotEl = document.getElementById("dot");
const infoStrip = document.getElementById("info-strip");
let messages = [];
let streaming = false;

input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 140) + "px"; });
input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

function setStatus(state, text) {
  statusEl.textContent = text;
  dotEl.className = "dot " + (state === "ready" ? "ok" : state === "busy" ? "busy" : "");
}

// ── Load config + quota info strip ──
function quotaColor(pct) {
  if (pct === null || pct === undefined) return "#555";
  if (pct > 50) return "#4a4";
  if (pct > 20) return "#ca0";
  return "#e44";
}
function quotaBar(pct) {
  if (pct === null || pct === undefined) return '<span class="val">--</span>';
  return '<span class="bar"><span class="bar-fill" style="width:' + pct + '%;background:' + quotaColor(pct) + '"></span></span> <span class="val">' + pct + '%</span>';
}

async function loadInfo() {
  try {
    const [h, q] = await Promise.all([
      fetch(BASE + "/health").then(r => r.json()),
      fetch(BASE + "/v1/quota").then(r => r.json()).catch(() => ({ providers: [] })),
    ]);
    const quotaMap = {};
    for (const p of (q.providers || [])) quotaMap[p.provider] = p;

    let html = "";

    // Pools
    if (h.pools?.length) {
      html += '<span class="section"><span class="section-label">pools</span>';
      for (const p of h.pools) {
        html += '<span class="tag pool"><b>' + esc(p.name) + '</b> <span class="val">' + esc(p.strategy) + '</span></span>';
      }
      html += '</span><span class="sep">|</span>';
    }

    // Presets
    if (h.presets?.length) {
      html += '<span class="section"><span class="section-label">presets</span>';
      for (const p of h.presets) {
        html += '<span class="tag preset" title="' + esc(p.entries.join(" > ")) + '"><b>' + esc(p.name) + '</b></span>';
      }
      html += '</span><span class="sep">|</span>';
    }

    // Providers with quota bars
    html += '<span class="section"><span class="section-label">providers</span>';
    for (const prov of (h.providers || [])) {
      const qi = quotaMap[prov] || {};
      const exh = (h.exhausted || []).includes(prov) || qi.exhausted;
      const cls = "tag provider" + (exh ? " exhausted" : "");
      html += '<span class="' + cls + '"><b>' + esc(prov) + '</b> ' + quotaBar(qi.quota) + '</span>';
    }
    html += '</span>';

    infoStrip.innerHTML = html;
  } catch {}
}

// ── Load routing ──
async function loadRouting() {
  try {
    const data = await (await fetch(BASE + "/v1/routing")).json();
    sel.innerHTML = "";
    let count = 0;
    for (const group of (data.groups || [])) {
      const og = document.createElement("optgroup");
      og.label = group.label;
      for (const item of group.items) {
        const o = document.createElement("option");
        o.value = item.id;
        o.textContent = item.name;
        if (item.detail) o.title = item.detail;
        og.appendChild(o);
        count++;
      }
      sel.appendChild(og);
    }
    setStatus("ready", count + " routes");
  } catch (e) { setStatus("error", e.message); }
}

function clearChat() {
  messages = [];
  chat.innerHTML = '<div class="welcome"><h2>Leeloo on multi-pass</h2>Chat cleared.</div>';
}

function esc(s) { return String(s).replace(/&/g,"&amp;").replace(/\x3c/g,"\x26lt;").replace(/>/g,"\x26gt;"); }

async function sendMessage() {
  const text = input.value.trim();
  if (!text || streaming) return;
  input.value = ""; input.style.height = "auto";
  messages.push({ role: "user", content: text });

  // Remove welcome
  const w = chat.querySelector(".welcome"); if (w) w.remove();

  // User bubble
  const userDiv = document.createElement("div");
  userDiv.className = "msg user";
  userDiv.textContent = text;
  chat.appendChild(userDiv);

  // Assistant bubble with thinking indicator
  const msgDiv = document.createElement("div");
  msgDiv.className = "msg assistant";
  msgDiv.innerHTML = '<div class="thinking"><div class="dots"><span></span><span></span><span></span></div>Thinking...</div>';
  chat.appendChild(msgDiv);
  chat.scrollTop = chat.scrollHeight;

  streaming = true; sendBtn.disabled = true; input.disabled = true;
  setStatus("busy", "connecting...");

  let full = "";
  let gotFirstToken = false;
  let smdParser = null;
  let mdBody = null;
  const t0 = Date.now();
  const rawSelection = sel.value;
  // Clean display: "pool:codex-pool/gpt-5.1" -> "codex-pool / gpt-5.1"
  const selectedModel = rawSelection.includes("/") ? rawSelection.split("/").pop() : rawSelection;
  const selectedRoute = rawSelection.replace("pool:", "").replace("provider:", "").replace("/", " / ");

  try {
    const resp = await fetch(BASE + "/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: rawSelection, messages, stream: true }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err?.error?.message || "HTTP " + resp.status);
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "", usage = null, xProvider = "", xModel = "", xLabel = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const p = line.slice(6).trim();
        if (p === "[DONE]") continue;
        try {
          const j = JSON.parse(p);
          const d = j.choices?.[0]?.delta;

          if (d?.content) {
            if (!gotFirstToken) {
              gotFirstToken = true;
              mdBody = document.createElement("div");
              mdBody.className = "md-body";
              msgDiv.innerHTML = "";
              msgDiv.appendChild(mdBody);
              if (smd) smdParser = smd.parser(smd.default_renderer(mdBody));
              setStatus("busy", "receiving...");
            }
            full += d.content;
            if (smdParser) smd.parser_write(smdParser, d.content);
            else mdBody.textContent = full;
            chat.scrollTop = chat.scrollHeight;
          }

          if (d?.tool_calls) {
            if (!gotFirstToken) {
              gotFirstToken = true;
              mdBody = document.createElement("div");
              mdBody.className = "md-body";
              msgDiv.innerHTML = "";
              msgDiv.appendChild(mdBody);
              if (smd) smdParser = smd.parser(smd.default_renderer(mdBody));
            }
            const tc = d.tool_calls[0];
            const tcText = "\\n**Tool call:** \`" + (tc?.function?.name || "?") + "\`\\n";
            full += tcText;
            if (smdParser) smd.parser_write(smdParser, tcText);
            else mdBody.textContent = full;
          }

          if (j.usage) usage = j.usage;
          if (j.x_provider) xProvider = j.x_provider;
          if (j.x_model) xModel = j.x_model;
          if (j.x_label) xLabel = j.x_label;

          if (j.choices?.[0]?.finish_reason) {
            if (smdParser && smd) smd.parser_end(smdParser);
            const ms = Date.now() - t0;
            const meta = document.createElement("div");
            meta.className = "meta";
            const parts = [];
            parts.push('<span class="provider-tag">' + esc(selectedRoute) + '</span>');
            if (xLabel || xProvider) {
              parts.push('<span style="color:#8af">' + esc(xLabel || xProvider) + '</span> / <span style="color:#aaa">' + esc(xModel) + '</span>');
            }
            if (usage) parts.push(usage.prompt_tokens + " in / " + usage.completion_tokens + " out");
            parts.push((ms / 1000).toFixed(1) + "s");
            meta.innerHTML = parts.join(' <span style="color:#333">|</span> ');
            msgDiv.appendChild(meta);
          }
        } catch {}
      }
    }
    messages.push({ role: "assistant", content: full });
  } catch (e) {
    // If request failed (e.g. blocked by policy), remove the just-added user turn
    // from request history so future messages are not repeatedly blocked.
    const last = messages[messages.length - 1];
    if (last && last.role === "user" && last.content === text) {
      messages.pop();
    }
    msgDiv.innerHTML = '<div class="md-body" style="color:#f44;padding:12px 16px">[Error: ' + esc(e.message) + ']</div>';
  }

  streaming = false; sendBtn.disabled = false; input.disabled = false;
  input.focus();
  setStatus("ready", "done");
  loadInfo(); // refresh quota + exhausted state
}

loadRouting();
loadInfo();
</script>
</body></html>`;


// ─── Server ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
	if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

	const path = new URL(req.url, `http://localhost:${PORT}`).pathname;
	try {
		if (path === "/v1/chat/completions" && req.method === "POST") await handleChatCompletions(req, res);
		else if (path === "/v1/models" && req.method === "GET") handleModels(req, res);
		else if (path === "/v1/routing" && req.method === "GET") handleRouting(req, res);
		else if (path === "/v1/quota" && req.method === "GET") await handleQuota(req, res);
		else if (path === "/v1/stats" && req.method === "GET") handleStats(req, res);
		else if (path === "/v1/rules" && req.method === "GET") handleRulesList(req, res);
		else if (path === "/v1/rules" && req.method === "POST") await handleRulesCreate(req, res);
		else if (path.startsWith("/v1/rules/") && req.method === "PUT") await handleRulesUpdate(req, res, decodeURIComponent(path.split("/v1/rules/")[1]));
		else if (path.startsWith("/v1/rules/") && req.method === "DELETE") handleRulesDelete(req, res, decodeURIComponent(path.split("/v1/rules/")[1]));
		else if (path === "/v1/audit" && req.method === "GET") handleAuditLog(req, res);
		else if (path === "/health" && req.method === "GET") handleHealth(req, res);
		else if (path === "/admin") handleAdmin(req, res);
		else if (path === "/ui" || path === "/") handleUI(req, res);
		else { res.writeHead(404, json()); res.end(JSON.stringify({ error: { message: "Not found" } })); }
	} catch (err) {
		log("Unhandled:", err?.message || err);
		if (!res.headersSent) { res.writeHead(500, json()); res.end(JSON.stringify({ error: { message: "Internal server error" } })); }
	}
});

server.listen(PORT, () => {
	const config = loadConfig();
	const providers = getAllProviders();
	const pools = config.pools.filter((p) => p.enabled);
	const presets = config.presets.filter((p) => p.enabled);

	console.log(`
  ╔════════════════════════════════════╗
  ║       Leeloo on multi-pass       ║
  ╚════════════════════════════════════╝

  OpenAI-compatible proxy powered by pi-multi-pass

  http://localhost:${PORT}/v1

  Providers:  ${providers.join(", ") || "none (login via pi first)"}
  Pools:      ${pools.map((p) => `${p.name} [${p.strategy || "round-robin"}] (${p.members.length})`).join(", ") || "none"}
  Chains:     ${config.chains.filter((c) => c.enabled).map((c) => c.name).join(", ") || "none"}
  Presets:    ${presets.map((p) => p.name).join(", ") || "none"}

  POST /v1/chat/completions   (streaming, tools, images, failover)
  GET  /v1/models             (all models + preset names)
  GET  /v1/quota              (detailed quota per provider)
  GET  /v1/stats              (usage stats + request log)
  GET  /v1/rules              (policy rules CRUD)
  GET  /v1/audit              (rule violation audit log)
  GET  /health
  GET  /admin                 Admin dashboard + rule editor
  GET  /ui                    Chat UI

  OPENAI_BASE_URL=http://localhost:${PORT}/v1
  Chat UI: http://localhost:${PORT}/ui
`);
});
