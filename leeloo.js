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
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync, createReadStream } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { randomBytes } from "node:crypto";
import { AuthStorage, getAgentDir } from "@mariozechner/pi-coding-agent";
import { getModel, getModels, stream } from "@mariozechner/pi-ai";

// ─── .env file support ───────────────────────────────────────────────────────

function loadEnvFile() {
	const candidates = [
		join(dirname(fileURLToPath(import.meta.url)), ".env"),
		join(process.cwd(), ".env"),
	];
	for (const p of candidates) {
		if (!existsSync(p)) continue;
		const lines = readFileSync(p, "utf-8").split("\n");
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq < 0) continue;
			const key = trimmed.slice(0, eq).trim();
			let val = trimmed.slice(eq + 1).trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
			if (!process.env[key]) process.env[key] = val; // don't override existing env
		}
		return p;
	}
	return null;
}
const envFile = loadEnvFile();

// ─── CLI args ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let PORT = parseInt(process.env.LEELOO_PORT || "4000", 10);
let CLI_COMMAND = null;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--port" && args[i + 1]) PORT = parseInt(args[i + 1], 10);
	if (args[i] === "init") CLI_COMMAND = "init";
	if (args[i] === "migrate") CLI_COMMAND = "migrate";
	if (args[i] === "export-js") CLI_COMMAND = "export-js";
}

// ─── Admin token ──────────────────────────────────────────────────────────────

const ADMIN_TOKEN = process.env.LEELOO_KEY || randomBytes(24).toString("hex");

// ─── Config ───────────────────────────────────────────────────────────────────

const AGENT_DIR = getAgentDir();
const ROOT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(ROOT_DIR, "web");
const CONFIG_PATH = join(AGENT_DIR, "multi-pass.json");
const RULES_PATH = join(AGENT_DIR, "multi-pass-rules.json");
const USERS_PATH = join(AGENT_DIR, "multi-pass-users.json");
const AUDIT_PATH = join(AGENT_DIR, "leeloo-audit.jsonl");
const USAGE_LOG_PATH = join(AGENT_DIR, "leeloo-usage.jsonl");
const AUDIT_MAX_LINES = 5000;
const USAGE_LOG_MAX_LINES = 10000;

function ensureDir() {
	if (!existsSync(AGENT_DIR)) mkdirSync(AGENT_DIR, { recursive: true });
}

const JS_CONFIG_PATHS = [
	join(AGENT_DIR, "multi-pass.config.js"),
	join(AGENT_DIR, "multi-pass.config.mjs"),
];

function getJsConfigPath() {
	return JS_CONFIG_PATHS.find((p) => existsSync(p));
}

let _jsConfigCache = null;
let _jsConfigMtime = 0;

async function loadJsConfig(jsPath) {
	try {
		const stat = (await import("node:fs")).statSync(jsPath);
		const mtime = stat.mtimeMs;
		if (_jsConfigCache && _jsConfigMtime === mtime) return _jsConfigCache;
		const mod = await import(`file://${jsPath}?t=${mtime}`);
		const cfg = mod.default || mod.config;
		if (!cfg) throw new Error("config.js must export default a config object");
		_jsConfigCache = normalizeConfig(cfg);
		_jsConfigMtime = mtime;
		return _jsConfigCache;
	} catch (e) {
		log(`[config] failed to load JS config ${jsPath}: ${e.message}`);
		return null;
	}
}

function normalizeConfig(raw) {
	return {
		subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
		pools: Array.isArray(raw.pools) ? raw.pools : [],
		chains: Array.isArray(raw.chains) ? raw.chains : [],
		presets: Array.isArray(raw.presets) ? raw.presets : [],
		apiKeys: Array.isArray(raw.apiKeys) ? raw.apiKeys : [],
		accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
		modes: Array.isArray(raw.modes) ? raw.modes : [],
		routingRules: Array.isArray(raw.routingRules) ? raw.routingRules : (Array.isArray(raw.rules) ? raw.rules : []),
	};
}

const _emptyConfig = () => ({ subscriptions: [], pools: [], chains: [], presets: [], apiKeys: [], accounts: [], modes: [], routingRules: [] });

function loadConfig() {
	// JS config takes precedence (cached for hot reload via mtime)
	const jsPath = getJsConfigPath();
	if (jsPath && _jsConfigCache) return _jsConfigCache;

	if (!existsSync(CONFIG_PATH)) return _emptyConfig();
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		return normalizeConfig(raw);
	} catch {
		return _emptyConfig();
	}
}

function isReadOnlyConfig() {
	return !!getJsConfigPath();
}

function saveConfig(config) {
	if (isReadOnlyConfig()) throw new Error("Config is read-only (managed by multi-pass.config.js)");
	ensureDir();
	// Strip rules from config if they were accidentally included
	const { rules, ...clean } = config;
	writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2), "utf-8");
}

function loadRules() {
	// Migrate: if rules exist in multi-pass.json, move them to multi-pass-rules.json
	if (!existsSync(RULES_PATH)) {
		if (existsSync(CONFIG_PATH)) {
			try {
				const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
				if (Array.isArray(raw.rules) && raw.rules.length > 0) {
					ensureDir();
					writeFileSync(RULES_PATH, JSON.stringify({ rules: raw.rules }, null, 2), "utf-8");
					delete raw.rules;
					writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), "utf-8");
					log("[rules] migrated rules from multi-pass.json to multi-pass-rules.json");
					return raw.rules;
				}
			} catch {}
		}
		return [];
	}
	try {
		const raw = JSON.parse(readFileSync(RULES_PATH, "utf-8"));
		return Array.isArray(raw.rules) ? raw.rules : [];
	} catch {
		return [];
	}
}

function saveRules(rules) {
	ensureDir();
	writeFileSync(RULES_PATH, JSON.stringify({ rules }, null, 2), "utf-8");
}

// ─── User management ────────────────────────────────────────────────────────
// Users file: { users: [{ username, key, allowedPresets?, allowedPools?, enabled }] }

function loadUsers() {
	if (!existsSync(USERS_PATH)) return [];
	try {
		const raw = JSON.parse(readFileSync(USERS_PATH, "utf-8"));
		return Array.isArray(raw.users) ? raw.users : [];
	} catch { return []; }
}

function saveUsers(users) {
	ensureDir();
	writeFileSync(USERS_PATH, JSON.stringify({ users }, null, 2), "utf-8");
}

/**
 * Authenticate a request. Returns { valid, role, user } where:
 *  - role "admin" for admin token
 *  - role "user" for user token with user object
 *  - valid=false if token missing/invalid
 */
function authenticateRequest(req) {
	const authHeader = req.headers.authorization;
	const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

	if (!token) return { valid: false, role: null, user: null };

	// Admin token
	if (token === ADMIN_TOKEN) return { valid: true, role: "admin", user: { username: "admin" } };

	// User token
	const users = loadUsers();
	const user = users.find((u) => u.key === token && u.enabled !== false);
	if (user) return { valid: true, role: "user", user };

	return { valid: false, role: null, user: null };
}

/**
 * Check if a user is allowed to use a specific model/preset/pool.
 * Admin can do everything. Users with no restrictions can do everything.
 * Users with allowedPresets/allowedPools are limited to those.
 */
function isModelAllowedForUser(user, role, modelId) {
	if (role === "admin") return true;
	if (!user) return false;

	const hasRestrictions = (user.allowedPresets?.length > 0) || (user.allowedPools?.length > 0);
	if (!hasRestrictions) return true;

	const allowed = [...(user.allowedPresets || []), ...(user.allowedPools || []).map((p) => `pool:${p}`)];
	// Check exact match or prefix match for pool:name/model
	return allowed.some((a) => modelId === a || modelId.startsWith(a + "/"));
}

/**
 * Check user budget. Returns { allowed, message, usage }.
 * Budgets: { daily_tokens, monthly_tokens } on the user object.
 * Uses userStats (in-memory) for fast checks.
 */
function checkUserBudget(user, role) {
	if (role === "admin") return { allowed: true };
	if (!user?.budgets) return { allowed: true };

	const username = user.username;
	const stats = userStats[username];
	if (!stats) return { allowed: true };

	const totalTokens = (stats.tokens_in || 0) + (stats.tokens_out || 0);

	// Daily check -- uses daily_tokens_today which resets at midnight
	if (user.budgets.daily_tokens && user.budgets.daily_tokens > 0) {
		const dailyUsed = stats.daily_tokens || 0;
		if (dailyUsed >= user.budgets.daily_tokens) {
			const pct = Math.round((dailyUsed / user.budgets.daily_tokens) * 100);
			return { allowed: false, message: `Daily token budget exceeded for "${username}": ${dailyUsed.toLocaleString()} / ${user.budgets.daily_tokens.toLocaleString()} (${pct}%)` };
		}
	}

	// Monthly check
	if (user.budgets.monthly_tokens && user.budgets.monthly_tokens > 0) {
		const monthlyUsed = stats.monthly_tokens || 0;
		if (monthlyUsed >= user.budgets.monthly_tokens) {
			const pct = Math.round((monthlyUsed / user.budgets.monthly_tokens) * 100);
			return { allowed: false, message: `Monthly token budget exceeded for "${username}": ${monthlyUsed.toLocaleString()} / ${user.budgets.monthly_tokens.toLocaleString()} (${pct}%)` };
		}
	}

	return { allowed: true };
}

// ─── Persistent usage log (JSONL, per-user) ─────────────────────────────────

function appendUsageLine(entry) {
	try {
		ensureDir();
		appendFileSync(USAGE_LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
	} catch {}
}

function rotateUsageLog() {
	if (!existsSync(USAGE_LOG_PATH)) return;
	try {
		const content = readFileSync(USAGE_LOG_PATH, "utf-8");
		const lines = content.split("\n").filter(Boolean);
		if (lines.length <= USAGE_LOG_MAX_LINES) return;
		const keep = lines.slice(-Math.floor(USAGE_LOG_MAX_LINES * 0.8));
		writeFileSync(USAGE_LOG_PATH, keep.join("\n") + "\n", "utf-8");
		log(`[usage] rotated: ${lines.length} -> ${keep.length} lines`);
	} catch {}
}

async function loadUsageFromDisk(maxLines = 500) {
	if (!existsSync(USAGE_LOG_PATH)) return [];
	const entries = [];
	try {
		const rl = createInterface({ input: createReadStream(USAGE_LOG_PATH, "utf-8"), crlfDelay: Infinity });
		for await (const line of rl) {
			if (!line.trim()) continue;
			try { entries.push(JSON.parse(line)); } catch {}
		}
	} catch {}
	return entries.slice(-maxLines);
}

// ─── Persistent audit log (JSONL) ───────────────────────────────────────────

function appendAuditLine(entry) {
	try {
		ensureDir();
		appendFileSync(AUDIT_PATH, JSON.stringify(entry) + "\n", "utf-8");
	} catch (e) {
		log("[audit] write error:", e.message);
	}
}

async function loadAuditFromDisk(maxLines = 1000) {
	if (!existsSync(AUDIT_PATH)) return [];
	const entries = [];
	try {
		const rl = createInterface({ input: createReadStream(AUDIT_PATH, "utf-8"), crlfDelay: Infinity });
		for await (const line of rl) {
			if (!line.trim()) continue;
			try { entries.push(JSON.parse(line)); } catch {}
		}
	} catch (e) {
		log("[audit] load error:", e.message);
	}
	// Keep only the most recent entries
	return entries.slice(-maxLines);
}

function rotateAuditFile() {
	if (!existsSync(AUDIT_PATH)) return;
	try {
		const content = readFileSync(AUDIT_PATH, "utf-8");
		const lines = content.split("\n").filter(Boolean);
		if (lines.length <= AUDIT_MAX_LINES) return;
		const keep = lines.slice(-Math.floor(AUDIT_MAX_LINES * 0.8));
		writeFileSync(AUDIT_PATH, keep.join("\n") + "\n", "utf-8");
		log(`[audit] rotated: ${lines.length} -> ${keep.length} lines`);
	} catch {}
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

/**
 * Get API key for a provider. For base providers, uses authStorage.getApiKey().
 * For subscriptions (e.g. openai-codex-2), AuthStorage.getApiKey() fails because
 * it doesn't know the OAuth provider. We fall back to extracting the access token
 * directly from stored credentials, same as the base provider's getApiKey would.
 */
/** Lookup an API key entry by name from config. */
function getApiKeyEntry(providerName) {
	return loadConfig().apiKeys.find((k) => k.name === providerName && k.enabled !== false);
}

async function getApiKeyForProvider(providerName) {
	// 1. Check API key entries first (raw keys in config)
	const keyEntry = getApiKeyEntry(providerName);
	if (keyEntry?.key) return keyEntry.key;

	// 2. Try the standard path (works for base OAuth providers)
	const key = await authStorage.getApiKey(providerName);
	if (key) return key;

	// 3. For subscriptions: extract directly from stored creds
	const cred = authStorage.get(providerName);
	if (!cred || cred.type !== "oauth" || !cred.access) return null;

	const base = getBaseProvider(providerName);
	if (base === "google-gemini-cli" || base === "google-antigravity") {
		return JSON.stringify({ token: cred.access, projectId: cred.projectId });
	}
	return cred.access;
}

/** Get all provider names (base OAuth + subscriptions + API keys) that are ready. */
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
	// API key entries -- always "authenticated" if they have a key
	for (const k of config.apiKeys) {
		if (k.enabled !== false && k.key) providers.push(k.name);
	}
	return providers;
}

/** Check if a provider is an API key entry (not OAuth). */
function isApiKeyProvider(providerName) {
	return !!getApiKeyEntry(providerName);
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
	if (isExhausted(provider)) return false;
	if (isApiKeyProvider(provider)) return true; // API key entries are always "authed"
	return authStorage.hasAuth(provider);
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

	const apiKey = await getApiKeyForProvider(provider);
	if (!apiKey) return { score: null, status: "no-auth" };

	const payload = decodeJwtPayload(apiKey);
	const authClaim = payload["https://api.openai.com/auth"];
	const profileClaim = payload["https://api.openai.com/profile"];
	const accountId = cred.accountId || authClaim?.chatgpt_account_id;

	const headers = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
	if (accountId) headers["chatgpt-account-id"] = accountId;

	// Check JWT expiry before making the API call
	if (payload?.exp && payload.exp < Date.now() / 1000) {
		return { score: null, status: "expired", error: "Token expired - re-login required" };
	}

	try {
		const resp = await fetch(`${CODEX_USAGE_URL.replace(/\/+$/, "")}/wham/usage`, { headers });
		if (resp.status === 401 || resp.status === 403) return { score: null, status: "expired", error: "Token rejected - re-login required" };
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
	} catch (e) {
		if (/expired|unauthorized|401/i.test(e.message)) return { score: null, status: "expired", error: e.message };
		return { score: null, status: "error", error: e.message };
	}
}

async function checkGeminiQuotaDetailed(provider) {
	const apiKey = await getApiKeyForProvider(provider);
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
	const apiKey = await getApiKeyForProvider(provider);
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

function clipText(value, maxLen = 4000) {
	if (typeof value !== "string") return null;
	const text = value.trim();
	if (!text) return null;
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen) + "\n...[truncated]";
}

const userStats = {}; // { username: { requests, tokens_in, tokens_out, errors, last_used } }

function trackRequest(provider, modelId, usage, durationMs, error, requestText, responseText, username) {
	const entry = {
		timestamp: new Date().toISOString(),
		provider,
		model: modelId,
		tokens_in: usage?.input || 0,
		tokens_out: usage?.output || 0,
		duration_ms: durationMs,
		error: error || null,
		request_text: clipText(requestText),
		response_text: clipText(responseText),
		user: username || null,
	};
	usageLog.push(entry);
	if (usageLog.length > USAGE_LOG_MAX) usageLog.shift();
	appendUsageLine(entry);

	if (!providerStats[provider]) {
		providerStats[provider] = { requests: 0, tokens_in: 0, tokens_out: 0, errors: 0, last_used: null };
	}
	const s = providerStats[provider];
	s.requests++;
	s.tokens_in += entry.tokens_in;
	s.tokens_out += entry.tokens_out;
	if (error) s.errors++;
	s.last_used = entry.timestamp;

	if (username) {
		const now = new Date();
		const today = now.toISOString().slice(0, 10); // YYYY-MM-DD
		const month = now.toISOString().slice(0, 7);  // YYYY-MM

		if (!userStats[username]) {
			userStats[username] = { requests: 0, tokens_in: 0, tokens_out: 0, errors: 0, last_used: null, daily_tokens: 0, daily_date: today, monthly_tokens: 0, monthly_date: month };
		}
		const u = userStats[username];

		// Reset daily counter if date changed
		if (u.daily_date !== today) { u.daily_tokens = 0; u.daily_date = today; }
		// Reset monthly counter if month changed
		if (u.monthly_date !== month) { u.monthly_tokens = 0; u.monthly_date = month; }

		const reqTokens = entry.tokens_in + entry.tokens_out;
		u.requests++;
		u.tokens_in += entry.tokens_in;
		u.tokens_out += entry.tokens_out;
		u.daily_tokens += reqTokens;
		u.monthly_tokens += reqTokens;
		if (error) u.errors++;
		u.last_used = entry.timestamp;
	}
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

let auditLog = [];
const AUDIT_LOG_MAX = 1000;
const rateLimitCounters = {}; // { ruleName: { count, windowStart } }

// Load persisted audit log on startup
(async () => {
	try {
		auditLog = await loadAuditFromDisk(AUDIT_LOG_MAX);
		if (auditLog.length > 0) log(`[audit] loaded ${auditLog.length} entries from disk`);
		rotateAuditFile();
	} catch {}
})();

function auditEvent(rule, action, detail, matchedText, fullMessage, source, redactedMessage) {
	const matched = typeof matchedText === "string" ? matchedText : null;
	const full = typeof fullMessage === "string" ? fullMessage : null;
	const redacted = typeof redactedMessage === "string" ? redactedMessage : null;
	const base = full || redacted || matched;
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
		redacted_message: redacted,
	};
	auditLog.push(entry);
	if (auditLog.length > AUDIT_LOG_MAX) auditLog.shift();
	appendAuditLine(entry);
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
					const beforeText = text;
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
					text = extractText(messages);
					auditEvent(rule, "redacted", `Pattern replaced: ${re.source}`, matched, beforeText, scope, text);
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
					const beforeText = text;
					re.lastIndex = 0;
					const afterText = text.replace(re, replacement);
					auditEvent(rule, "redacted-response", `Pattern replaced: ${re.source}`, matched, beforeText, "response", afterText);
					text = afterText;
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
	res.writeHead(200, json());
	res.end(JSON.stringify({ rules: loadRules() }));
}

async function handleRulesCreate(req, res) {
	const body = JSON.parse(await readBody(req));
	const rules = loadRules();
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
	rules.push(rule);
	saveRules(rules);
	res.writeHead(201, json());
	res.end(JSON.stringify({ rule }));
}

async function handleRulesUpdate(req, res, ruleName) {
	const body = JSON.parse(await readBody(req));
	const rules = loadRules();
	const idx = rules.findIndex((r) => r.name === ruleName);
	if (idx < 0) { res.writeHead(404, json()); res.end(JSON.stringify({ error: { message: "Rule not found" } })); return; }
	rules[idx] = { ...rules[idx], ...body };
	saveRules(rules);
	res.writeHead(200, json());
	res.end(JSON.stringify({ rule: rules[idx] }));
}

function handleRulesDelete(req, res, ruleName) {
	const rules = loadRules().filter((r) => r.name !== ruleName);
	saveRules(rules);
	res.writeHead(200, json());
	res.end(JSON.stringify({ deleted: ruleName }));
}

// ─── Config CRUD API ─────────────────────────────────────────────────────────

function handleConfigGet(req, res) {
	const cfg = loadConfig();
	res.writeHead(200, json());
	res.end(JSON.stringify({ ...cfg, _readOnly: isReadOnlyConfig(), _source: getJsConfigPath() || CONFIG_PATH }));
}

async function handleConfigPut(req, res) {
	const body = JSON.parse(await readBody(req));
	const config = loadConfig();
	// Merge only known keys
	if (body.subscriptions !== undefined) config.subscriptions = body.subscriptions;
	if (body.pools !== undefined) config.pools = body.pools;
	if (body.chains !== undefined) config.chains = body.chains;
	if (body.presets !== undefined) config.presets = body.presets;
	if (body.apiKeys !== undefined) config.apiKeys = body.apiKeys;
	if (body.accounts !== undefined) config.accounts = body.accounts;
	if (body.modes !== undefined) config.modes = body.modes;
	if (body.routingRules !== undefined) config.routingRules = body.routingRules;
	saveConfig(config);
	res.writeHead(200, json());
	res.end(JSON.stringify(config));
}

// Granular: pools
async function handlePoolsGet(req, res) {
	res.writeHead(200, json());
	res.end(JSON.stringify({ pools: loadConfig().pools }));
}

async function handlePoolCreate(req, res) {
	const body = JSON.parse(await readBody(req));
	const config = loadConfig();
	const pool = {
		name: body.name || `pool-${Date.now()}`,
		enabled: body.enabled !== false,
		baseProvider: body.baseProvider || "",
		members: body.members || [],
		strategy: body.strategy || "round-robin",
		memberSchedule: body.memberSchedule || undefined,
		selectorScript: body.selectorScript || undefined,
	};
	config.pools.push(pool);
	saveConfig(config);
	res.writeHead(201, json());
	res.end(JSON.stringify({ pool }));
}

async function handlePoolUpdate(req, res, poolName) {
	const body = JSON.parse(await readBody(req));
	const config = loadConfig();
	const idx = config.pools.findIndex((p) => p.name === poolName);
	if (idx < 0) { res.writeHead(404, json()); res.end(JSON.stringify({ error: { message: "Pool not found" } })); return; }
	config.pools[idx] = { ...config.pools[idx], ...body };
	saveConfig(config);
	res.writeHead(200, json());
	res.end(JSON.stringify({ pool: config.pools[idx] }));
}

function handlePoolDelete(req, res, poolName) {
	const config = loadConfig();
	config.pools = config.pools.filter((p) => p.name !== poolName);
	saveConfig(config);
	res.writeHead(200, json());
	res.end(JSON.stringify({ deleted: poolName }));
}

// Granular: chains
async function handleChainCreate(req, res) {
	const body = JSON.parse(await readBody(req));
	const config = loadConfig();
	const chain = {
		name: body.name || `chain-${Date.now()}`,
		enabled: body.enabled !== false,
		steps: body.steps || [],
	};
	config.chains.push(chain);
	saveConfig(config);
	res.writeHead(201, json());
	res.end(JSON.stringify({ chain }));
}

async function handleChainUpdate(req, res, chainName) {
	const body = JSON.parse(await readBody(req));
	const config = loadConfig();
	const idx = config.chains.findIndex((c) => c.name === chainName);
	if (idx < 0) { res.writeHead(404, json()); res.end(JSON.stringify({ error: { message: "Chain not found" } })); return; }
	config.chains[idx] = { ...config.chains[idx], ...body };
	saveConfig(config);
	res.writeHead(200, json());
	res.end(JSON.stringify({ chain: config.chains[idx] }));
}

function handleChainDelete(req, res, chainName) {
	const config = loadConfig();
	config.chains = config.chains.filter((c) => c.name !== chainName);
	saveConfig(config);
	res.writeHead(200, json());
	res.end(JSON.stringify({ deleted: chainName }));
}

// Granular: presets
async function handlePresetCreate(req, res) {
	const body = JSON.parse(await readBody(req));
	const config = loadConfig();
	const preset = {
		name: body.name || `preset-${Date.now()}`,
		enabled: body.enabled !== false,
		entries: body.entries || [],
	};
	config.presets.push(preset);
	saveConfig(config);
	res.writeHead(201, json());
	res.end(JSON.stringify({ preset }));
}

async function handlePresetUpdate(req, res, presetName) {
	const body = JSON.parse(await readBody(req));
	const config = loadConfig();
	const idx = config.presets.findIndex((p) => p.name === presetName);
	if (idx < 0) { res.writeHead(404, json()); res.end(JSON.stringify({ error: { message: "Preset not found" } })); return; }
	config.presets[idx] = { ...config.presets[idx], ...body };
	saveConfig(config);
	res.writeHead(200, json());
	res.end(JSON.stringify({ preset: config.presets[idx] }));
}

function handlePresetDelete(req, res, presetName) {
	const config = loadConfig();
	config.presets = config.presets.filter((p) => p.name !== presetName);
	saveConfig(config);
	res.writeHead(200, json());
	res.end(JSON.stringify({ deleted: presetName }));
}

// Granular: subscriptions
async function handleSubCreate(req, res) {
	const body = JSON.parse(await readBody(req));
	const config = loadConfig();
	const provider = body.provider;
	if (!provider) {
		res.writeHead(400, json());
		res.end(JSON.stringify({ error: { message: "provider is required" } }));
		return;
	}

	// Auto-assign next available index for this provider (matches extension format)
	const existingIndices = config.subscriptions
		.filter((s) => s.provider === provider)
		.map((s) => s.index || 0);
	const nextIndex = existingIndices.length === 0 ? 2 : Math.max(...existingIndices) + 1;

	const sub = {
		provider,
		index: body.index || nextIndex,
		label: body.label || body.alias || "",
	};

	// The canonical ID is "${provider}-${index}" (e.g. "openai-codex-2")
	const subId = `${sub.provider}-${sub.index}`;

	config.subscriptions.push(sub);
	saveConfig(config);
	res.writeHead(201, json());
	res.end(JSON.stringify({ subscription: sub, subId }));
}

// subName here is the canonical ID like "openai-codex-2"
function findSubIndex(config, subId) {
	return config.subscriptions.findIndex((s) => `${s.provider}-${s.index}` === subId);
}

async function handleSubUpdate(req, res, subName) {
	const body = JSON.parse(await readBody(req));
	const config = loadConfig();
	const idx = findSubIndex(config, subName);
	if (idx < 0) { res.writeHead(404, json()); res.end(JSON.stringify({ error: { message: "Subscription not found" } })); return; }
	config.subscriptions[idx] = { ...config.subscriptions[idx], ...body };
	saveConfig(config);
	res.writeHead(200, json());
	res.end(JSON.stringify({ subscription: config.subscriptions[idx] }));
}

function handleSubDelete(req, res, subName) {
	const config = loadConfig();
	const idx = findSubIndex(config, subName);
	if (idx < 0) { res.writeHead(404, json()); res.end(JSON.stringify({ error: { message: "Subscription not found" } })); return; }
	// Also remove auth
	try { authStorage.remove(subName); } catch {}
	config.subscriptions.splice(idx, 1);
	saveConfig(config);
	res.writeHead(200, json());
	res.end(JSON.stringify({ deleted: subName }));
}

// ─── Auth / OAuth API ─────────────────────────────────────────────────────────

const pendingLogins = new Map(); // provider -> { resolve, reject, authUrl, status }

async function handleAuthProviders(req, res) {
	const provs = authStorage.getOAuthProviders();
	const config = loadConfig();
	const result = [];

	// Collect all provider IDs to check
	const allIds = [];

	// Built-in providers
	for (const p of provs) {
		allIds.push({ id: p.id, name: p.name, baseProvider: p.id, isBuiltin: true });
	}

	// Extra subscription accounts
	for (const sub of config.subscriptions) {
		const subId = `${sub.provider}-${sub.index}`;
		if (allIds.some((r) => r.id === subId)) continue;
		const baseProv = provs.find((p) => p.id === sub.provider);
		allIds.push({
			id: subId,
			name: `${baseProv?.name || sub.provider} #${sub.index}${sub.label ? " (" + sub.label + ")" : ""}`,
			baseProvider: sub.provider,
			isBuiltin: false,
			index: sub.index,
			label: sub.label,
		});
	}

	// API key entries
	for (const k of config.apiKeys) {
		if (allIds.some((r) => r.id === k.name)) continue;
		allIds.push({
			id: k.name,
			name: k.label || k.name,
			isBuiltin: false,
			isApiKey: true,
			models: k.models,
		});
	}

	// Check actual auth status for each
	for (const entry of allIds) {
		if (entry.isApiKey) {
			const ke = config.apiKeys.find((k) => k.name === entry.id);
			result.push({ ...entry, authenticated: !!(ke?.key), tokenStatus: ke?.key ? "ok" : "no-key", enabled: ke?.enabled !== false });
			continue;
		}
		const hasAuth = authStorage.hasAuth(entry.id);
		let tokenStatus = "no-auth";
		if (hasAuth) {
			const cred = authStorage.get(entry.id);
			if (cred?.type === "oauth" && cred.access) {
				try {
					const payload = decodeJwtPayload(cred.access);
					if (payload?.exp && payload.exp < Date.now() / 1000) tokenStatus = "expired";
					else tokenStatus = "ok";
				} catch { tokenStatus = "ok"; }
			}
		}
		result.push({ ...entry, authenticated: hasAuth, tokenStatus });
	}

	res.writeHead(200, json());
	res.end(JSON.stringify({ providers: result }));
}

/** Returns all known provider/subscription names for use in dropdowns. */
function handleKnownNames(req, res) {
	const config = loadConfig();
	const provs = authStorage.getOAuthProviders();

	// All provider IDs that exist (authenticated or not)
	const allNames = [];
	for (const p of provs) {
		allNames.push({ id: p.id, label: p.name, type: "provider", authenticated: authStorage.hasAuth(p.id) });
	}
	for (const sub of config.subscriptions) {
		const subId = `${sub.provider}-${sub.index}`;
		if (allNames.some((n) => n.id === subId)) continue;
		const baseProv = provs.find((p) => p.id === sub.provider);
		allNames.push({ id: subId, label: `${baseProv?.name || sub.provider} #${sub.index}${sub.label ? " (" + sub.label + ")" : ""}`, type: "subscription", authenticated: authStorage.hasAuth(subId) });
	}
	// API key entries
	for (const k of config.apiKeys) {
		if (allNames.some((n) => n.id === k.name)) continue;
		allNames.push({ id: k.name, label: k.label || k.name, type: "apikey", authenticated: !!(k.key) });
	}

	// Pool names
	const poolNames = config.pools.filter((p) => p.enabled).map((p) => ({ id: `pool:${p.name}`, label: p.name, type: "pool" }));

	// Chain names
	const chainNames = config.chains.filter((c) => c.enabled).map((c) => ({ id: `chain:${c.name}`, label: c.name, type: "chain" }));

	// Preset names
	const presetNames = config.presets.filter((p) => p.enabled).map((p) => ({ id: p.name, label: p.name, type: "preset" }));

	res.writeHead(200, json());
	res.end(JSON.stringify({ providers: allNames, pools: poolNames, chains: chainNames, presets: presetNames }));
}

function handleAuthStatus(req, res) {
	const providerList = getAllProviders();
	const result = {};
	for (const p of providerList) {
		result[p] = { hasAuth: authStorage.hasAuth(p), label: getProviderLabel(p) };
	}
	res.writeHead(200, json());
	res.end(JSON.stringify({ status: result }));
}

async function handleAuthLogin(req, res, providerId) {
	// Support ?storeAs=name to run OAuth for base provider but store under a different name
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const storeAs = url.searchParams.get("storeAs") || null;
	const trackId = storeAs || providerId; // ID used for pending tracking + final storage

	// Check if already logging in
	if (pendingLogins.has(trackId)) {
		const pending = pendingLogins.get(trackId);
		if (pending.authUrl) {
			res.writeHead(200, json());
			res.end(JSON.stringify({ status: "pending", authUrl: pending.authUrl, message: "Login already in progress. Open the URL to complete." }));
			return;
		}
	}

	log(`[auth] starting OAuth login for ${providerId}${storeAs ? ` (store as ${storeAs})` : ""}`);

	// Find the OAuth provider to use (always the base provider's flow)
	const oauthProviders = authStorage.getOAuthProviders();
	const oauthProvider = oauthProviders.find((p) => p.id === providerId);
	if (!oauthProvider) {
		res.writeHead(400, json());
		res.end(JSON.stringify({ error: { message: `Unknown OAuth provider: ${providerId}. Known: ${oauthProviders.map((p) => p.id).join(", ")}` } }));
		return;
	}

	let authUrl = null;
	let loginResolve, loginReject;
	const loginPromise = new Promise((resolve, reject) => { loginResolve = resolve; loginReject = reject; });

	pendingLogins.set(trackId, { authUrl: null, status: "starting" });

	// Run the OAuth login flow from the base provider
	oauthProvider.login({
		onAuth(info) {
			const u = typeof info === "string" ? info : info?.url || info;
			authUrl = u;
			const pending = pendingLogins.get(trackId);
			if (pending) { pending.authUrl = u; pending.status = "waiting"; }
			log(`[auth] ${trackId} auth URL ready`);
		},
		onPrompt(msg) { log(`[auth] ${trackId} prompt: ${msg}`); },
		onProgress(msg) { log(`[auth] ${trackId} progress: ${msg}`); },
		onManualCodeInput() {
			// Return a promise that never resolves -- we rely on the callback server
			return new Promise(() => {});
		},
		signal: undefined,
	}).then((credentials) => {
		// Store credentials under the target name (storeAs or providerId)
		authStorage.set(trackId, { type: "oauth", ...credentials });
		log(`[auth] ${trackId} login successful, credentials stored`);
		pendingLogins.delete(trackId);
		loginResolve({ success: true });
	}).catch((err) => {
		log(`[auth] ${trackId} login failed: ${err.message}`);
		pendingLogins.delete(trackId);
		loginReject(err);
	});

	// Wait for authUrl to be available (max 10s)
	const t0 = Date.now();
	while (!authUrl && Date.now() - t0 < 10000) {
		await new Promise((r) => setTimeout(r, 100));
	}

	if (!authUrl) {
		pendingLogins.delete(trackId);
		res.writeHead(500, json());
		res.end(JSON.stringify({ error: { message: "Timed out waiting for auth URL" } }));
		return;
	}

	res.writeHead(200, json());
	res.end(JSON.stringify({ status: "pending", authUrl, trackId, message: "Open the URL to complete OAuth login." }));
}

function handleAuthLoginStatus(req, res, providerId) {
	// Check query param for storeAs tracking
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const storeAs = url.searchParams.get("storeAs") || null;
	const trackId = storeAs || providerId;

	const pending = pendingLogins.get(trackId);
	if (pending) {
		res.writeHead(200, json());
		res.end(JSON.stringify({ status: pending.status, authUrl: pending.authUrl }));
		return;
	}
	// Check if now authenticated
	const hasAuth = authStorage.hasAuth(trackId);
	res.writeHead(200, json());
	res.end(JSON.stringify({ status: hasAuth ? "authenticated" : "not_authenticated", hasAuth }));
}

async function handleAuthLogout(req, res, providerId) {
	try {
		authStorage.remove(providerId);
		log(`[auth] ${providerId} logged out`);
		res.writeHead(200, json());
		res.end(JSON.stringify({ status: "logged_out", provider: providerId }));
	} catch (e) {
		res.writeHead(500, json());
		res.end(JSON.stringify({ error: { message: e.message } }));
	}
}

// ─── API Key CRUD ─────────────────────────────────────────────────────────────

function inferBaseUrl(key) {
	if (!key) return "https://api.openai.com/v1";
	if (key.startsWith("sk-ant-")) return "https://api.anthropic.com/v1";
	return "https://api.openai.com/v1";
}

async function handleApiKeyCreate(req, res) {
	const body = JSON.parse(await readBody(req));
	const config = loadConfig();
	const key = body.key || "";
	const entry = {
		name: body.name || `key-${Date.now()}`,
		key,
		baseUrl: body.baseUrl || inferBaseUrl(key),
		models: body.models || [],
		enabled: body.enabled !== false,
		label: body.label || "",
	};
	if (config.apiKeys.some((k) => k.name === entry.name)) {
		res.writeHead(409, json());
		res.end(JSON.stringify({ error: { message: `API key "${entry.name}" already exists` } }));
		return;
	}
	config.apiKeys.push(entry);
	saveConfig(config);
	res.writeHead(201, json());
	res.end(JSON.stringify({ apiKey: { ...entry, key: entry.key ? entry.key.slice(0, 8) + "..." : "" } }));
}

async function handleApiKeyUpdate(req, res, name) {
	const body = JSON.parse(await readBody(req));
	const config = loadConfig();
	const idx = config.apiKeys.findIndex((k) => k.name === name);
	if (idx < 0) { res.writeHead(404, json()); res.end(JSON.stringify({ error: { message: "API key not found" } })); return; }
	config.apiKeys[idx] = { ...config.apiKeys[idx], ...body };
	saveConfig(config);
	res.writeHead(200, json());
	res.end(JSON.stringify({ apiKey: { ...config.apiKeys[idx], key: config.apiKeys[idx].key?.slice(0, 8) + "..." } }));
}

function handleApiKeyDelete(req, res, name) {
	const config = loadConfig();
	config.apiKeys = config.apiKeys.filter((k) => k.name !== name);
	saveConfig(config);
	res.writeHead(200, json());
	res.end(JSON.stringify({ deleted: name }));
}

// ─── User CRUD API ────────────────────────────────────────────────────────────

function handleUsersList(req, res) {
	res.writeHead(200, json());
	res.end(JSON.stringify({ users: loadUsers().map((u) => ({ ...u, key: u.key?.slice(0, 8) + "..." })) }));
}

async function handleUserCreate(req, res) {
	const body = JSON.parse(await readBody(req));
	const users = loadUsers();
	const budgets = {};
	if (body.budgets?.daily_tokens) budgets.daily_tokens = body.budgets.daily_tokens;
	if (body.budgets?.monthly_tokens) budgets.monthly_tokens = body.budgets.monthly_tokens;

	const user = {
		username: body.username || `user-${Date.now()}`,
		key: body.key || randomBytes(24).toString("hex"),
		enabled: body.enabled !== false,
		allowedPresets: body.allowedPresets || [],
		allowedPools: body.allowedPools || [],
		...(Object.keys(budgets).length > 0 ? { budgets } : {}),
	};
	if (users.some((u) => u.username === user.username)) {
		res.writeHead(409, json());
		res.end(JSON.stringify({ error: { message: `User "${user.username}" already exists` } }));
		return;
	}
	users.push(user);
	saveUsers(users);
	res.writeHead(201, json());
	res.end(JSON.stringify({ user })); // Return full key on create
}

async function handleUserUpdate(req, res, username) {
	const body = JSON.parse(await readBody(req));
	const users = loadUsers();
	const idx = users.findIndex((u) => u.username === username);
	if (idx < 0) { res.writeHead(404, json()); res.end(JSON.stringify({ error: { message: "User not found" } })); return; }
	users[idx] = { ...users[idx], ...body };
	saveUsers(users);
	res.writeHead(200, json());
	res.end(JSON.stringify({ user: { ...users[idx], key: users[idx].key?.slice(0, 8) + "..." } }));
}

function handleUserDelete(req, res, username) {
	const users = loadUsers().filter((u) => u.username !== username);
	saveUsers(users);
	res.writeHead(200, json());
	res.end(JSON.stringify({ deleted: username }));
}

function handleUserRevealKey(req, res, username) {
	const users = loadUsers();
	const user = users.find((u) => u.username === username);
	if (!user) { res.writeHead(404, json()); res.end(JSON.stringify({ error: { message: "User not found" } })); return; }
	res.writeHead(200, json());
	res.end(JSON.stringify({ username: user.username, key: user.key }));
}

function handleAuditLog(req, res) {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const limit = parseInt(url.searchParams.get("limit") || "100", 10);
	res.writeHead(200, json());
	res.end(JSON.stringify({ entries: auditLog.slice(-limit).reverse() }));
}

const MIME_TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".ico": "image/x-icon",
};

function serveStaticFile(res, absPath) {
	if (!existsSync(absPath)) {
		res.writeHead(404, json());
		res.end(JSON.stringify({ error: { message: "Not found" } }));
		return;
	}
	const ext = extname(absPath).toLowerCase();
	const contentType = MIME_TYPES[ext] || "application/octet-stream";
	res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
	res.end(readFileSync(absPath));
}

function handleWebAsset(req, res, path) {
	const rel = path.replace(/^\/web\//, "");
	if (!rel || rel.includes("..")) {
		res.writeHead(403, json());
		res.end(JSON.stringify({ error: { message: "Forbidden" } }));
		return;
	}
	const absPath = join(WEB_DIR, rel);
	serveStaticFile(res, absPath);
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

// ═════════════════════════════════════════════════════════════════════════════
// Routing v2: accounts -> modes -> rules pipeline
// ═════════════════════════════════════════════════════════════════════════════
//
// New routing model that runs alongside the legacy pool/chain/preset path.
// A request is routed via v2 only if `model` resolves to a v2 mode or to a
// v2 preset (which references a mode). Otherwise we fall back to the legacy
// routing in resolveCandidates().
//
// Built-in rule types:
//   time-window     -- score boost during specified time windows
//   quota-burn      -- score boost for accounts whose quota expires soonest
//   cost-tier       -- score boost for cheap/free accounts
//   model-fit       -- filter out accounts that can't serve the request
//   error-blacklist -- filter out accounts that errored recently
//   cooldown        -- filter out exhausted accounts (default applied)
//   custom          -- run a JS function (file path or inline)

const ROUTING_RULE_REGISTRY = {
	"time-window": (params) => async (candidates, ctx) => {
		const targets = new Set(params.targets || []);
		const boost = params.boost ?? 50;
		const now = ctx.now || new Date();
		const dow = JS_DAY_TO_DOW[now.getDay()];
		const hour = now.getHours();
		const inWindow = (params.windows || []).some((w) => {
			if (w.days && !w.days.includes(dow) && !w.days.some((d) => expandDayRange(d).includes(dow))) return false;
			if (w.hours && !isInHourRange(hour, w.hours)) return false;
			return true;
		});
		if (!inWindow) return { candidates };
		const scores = {};
		for (const c of candidates) {
			const matches = targets.has(c.id) || (c.poolId && targets.has(c.poolId));
			if (matches || targets.size === 0) scores[c.id] = boost;
		}
		return { candidates, scores };
	},

	"quota-burn": (params) => async (candidates, ctx) => {
		const scores = {};
		await Promise.all(candidates.map(async (c) => {
			try {
				const detail = await checkQuotaDetailed(c.id);
				if (detail?.windows?.length) {
					const earliest = detail.windows
						.map((w) => w.resetAt ? new Date(w.resetAt).getTime() : Infinity)
						.reduce((a, b) => Math.min(a, b), Infinity);
					if (earliest !== Infinity) {
						const hoursUntilReset = (earliest - Date.now()) / (60 * 60 * 1000);
						// Smaller hoursUntilReset = higher boost (use it before you lose it)
						scores[c.id] = Math.max(0, 100 - hoursUntilReset);
					}
				}
			} catch {}
		}));
		return { candidates, scores };
	},

	"cost-tier": (params) => async (candidates, ctx) => {
		const targets = new Set(params.targets || []);
		const boost = params.boost ?? 30;
		const scores = {};
		for (const c of candidates) {
			if (targets.has(c.id) || (c.poolId && targets.has(c.poolId))) scores[c.id] = boost;
		}
		return { candidates, scores };
	},

	"model-fit": (params) => async (candidates, ctx) => {
		const minContext = params.minContext || 0;
		const requireTools = !!params.requireTools;
		const requireVision = !!params.requireVision;
		// Filter is best-effort -- without per-model metadata we mostly let things through.
		// Custom rules can do more sophisticated checks.
		return { candidates };
	},

	"error-blacklist": (params) => async (candidates, ctx) => {
		const windowMs = (params.windowMinutes || 5) * 60 * 1000;
		const now = Date.now();
		const recentErrored = new Set(
			(ctx.history || [])
				.filter((h) => h.error && (now - new Date(h.timestamp).getTime()) < windowMs)
				.map((h) => h.candidate)
		);
		return { candidates: candidates.filter((c) => !recentErrored.has(c.id)) };
	},

	"cooldown": (params) => async (candidates, ctx) => {
		return { candidates: candidates.filter((c) => !isExhausted(c.id)) };
	},

	"custom": (params) => {
		// Inline function or file path
		if (typeof params.fn === "function") return params.fn;
		if (params.code) {
			const path = params.code;
			return async (candidates, ctx) => {
				try {
					const fn = await loadCustomRoutingRule(path);
					if (typeof fn === "function") return await fn(candidates, ctx);
				} catch (e) { log(`[rule:custom] error in ${path}: ${e.message}`); }
				return { candidates };
			};
		}
		return async (candidates) => ({ candidates });
	},
};

const customRuleCache = new Map();
async function loadCustomRoutingRule(scriptPath) {
	let resolved = scriptPath;
	if (!scriptPath.startsWith("/") && !scriptPath.startsWith("~/")) {
		resolved = join(AGENT_DIR, scriptPath);
	} else if (scriptPath.startsWith("~/")) {
		const home = process.env.HOME || process.env.USERPROFILE || "";
		resolved = join(home, scriptPath.slice(2));
	}
	if (customRuleCache.has(resolved)) return customRuleCache.get(resolved);
	if (!existsSync(resolved)) return null;
	try {
		const mod = await import(`file://${resolved}?t=${Date.now()}`);
		const fn = mod.default || mod.rule;
		customRuleCache.set(resolved, fn);
		return fn;
	} catch (e) { log(`[rule:custom] failed to load ${resolved}: ${e.message}`); return null; }
}

function expandDayRange(spec) {
	const days = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
	const m = spec.match(/^(mon|tue|wed|thu|fri|sat|sun)-(mon|tue|wed|thu|fri|sat|sun)$/);
	if (!m) return [spec];
	const a = days.indexOf(m[1]);
	const b = days.indexOf(m[2]);
	if (a < 0 || b < 0) return [spec];
	const out = [];
	let i = a;
	while (true) { out.push(days[i]); if (i === b) break; i = (i + 1) % 7; }
	return out;
}

/** Compile a rule config entry into an apply function. */
function compileRoutingRule(ruleConfig) {
	const factory = ROUTING_RULE_REGISTRY[ruleConfig.type];
	if (!factory) { log(`[rule] unknown type: ${ruleConfig.type}`); return null; }
	return factory(ruleConfig.params || {});
}

/**
 * Resolve a list of candidate references (account IDs, pool IDs, mode IDs)
 * into a flat list of account candidates. Detects cycles and limits depth.
 */
function expandModeCandidates(refs, config, depth = 0, visited = new Set()) {
	if (depth > 5) { log("[mode] max depth exceeded"); return []; }
	const out = [];
	for (const rawRef of refs || []) {
		// Strip "pool:" / "mode:" prefixes -- both forms accepted
		const ref = rawRef.replace(/^(pool|mode):/, "");
		if (visited.has(ref)) continue;
		visited.add(ref);

		// Account?
		const account = config.accounts.find((a) => a.id === ref);
		if (account) { out.push({ id: account.id, account }); continue; }

		// API key entry (legacy v1 shape, treat as account)
		const apiKey = config.apiKeys.find((k) => k.name === ref);
		if (apiKey) { out.push({ id: apiKey.name, account: { id: apiKey.name, kind: "apiKey", ...apiKey } }); continue; }

		// OAuth subscription/provider (treat as implicit account)
		if (getBaseProvider(ref) || SUPPORTED_PROVIDERS.includes(ref)) {
			out.push({ id: ref, account: { id: ref, kind: "oauth", provider: getBaseProvider(ref) || ref } });
			continue;
		}

		// Pool?
		const pool = config.pools.find((p) => (p.name === ref || p.id === ref) && p.enabled !== false);
		if (pool) {
			for (const m of pool.members || []) {
				if (visited.has(m)) continue;
				const sub = expandModeCandidates([m], config, depth + 1, visited);
				for (const s of sub) { s.poolId = pool.name || pool.id; out.push(s); }
			}
			continue;
		}

		// Mode?
		const mode = config.modes.find((m) => m.id === ref);
		if (mode) {
			const sub = expandModeCandidates(mode.candidates, config, depth + 1, visited);
			for (const s of sub) { s.modeId = mode.id; out.push(s); }
			continue;
		}

		log(`[mode] unknown candidate ref: ${rawRef}`);
	}
	return out;
}

/** Resolve a model/preset ID to a v2 mode + preset (if applicable). */
function resolveV2Route(modelOrPresetId) {
	const config = loadConfig();
	let preset = config.presets.find((p) => p.id === modelOrPresetId || p.name === modelOrPresetId);
	let mode;
	if (preset && preset.mode) {
		mode = config.modes.find((m) => m.id === preset.mode);
	} else {
		mode = config.modes.find((m) => m.id === modelOrPresetId);
	}
	if (!mode) return null;
	return { config, preset, mode };
}

/**
 * Run the v2 routing pipeline. Returns an ordered list of { provider, modelId, model }
 * candidates compatible with the existing chat handler loop.
 */
async function routeViaV2(modelOrPresetId, ctx) {
	const route = resolveV2Route(modelOrPresetId);
	if (!route) return null;
	const { config, preset, mode } = route;

	// 1. Expand candidates (accounts/pools/nested modes)
	let candidates = expandModeCandidates(mode.candidates, config);
	if (candidates.length === 0) return [];

	// 2. Always apply cooldown filter (skip exhausted)
	candidates = candidates.filter((c) => !isExhausted(c.id));

	// 3. Build accumulated scores from rules
	const scores = {};
	for (const ruleId of (mode.rules || [])) {
		const ruleConfig = config.routingRules.find((r) => r.id === ruleId);
		if (!ruleConfig) { log(`[mode:${mode.id}] rule not found: ${ruleId}`); continue; }
		const apply = compileRoutingRule(ruleConfig);
		if (!apply) continue;
		try {
			const result = await apply(candidates, ctx);
			if (result?.candidates) candidates = result.candidates;
			if (result?.scores) {
				for (const [id, s] of Object.entries(result.scores)) {
					scores[id] = (scores[id] || 0) + s;
				}
			}
		} catch (e) { log(`[rule:${ruleId}] error: ${e.message}`); }
	}

	// 4. Sort by accumulated score (descending), tie-break by original order
	candidates.sort((a, b) => (scores[b.id] || 0) - (scores[a.id] || 0));

	// 5. Pick the model. Prefer preset.preferredModels in order, fall back to fallbackModels.
	const preferredModels = preset?.preferredModels || [];
	const fallbackModels = preset?.fallbackModels || [];
	const modelOrder = [...preferredModels, ...fallbackModels];

	const result = [];
	for (const cand of candidates) {
		const providerName = cand.account?.id || cand.id;
		// Try each model in preference order
		const tries = modelOrder.length > 0 ? modelOrder : [null];
		for (const wantedModel of tries) {
			let modelId = wantedModel;
			if (!modelId) {
				// No preference -- pick the provider's first available model
				try {
					const base = getBaseProvider(providerName) || cand.account?.provider;
					if (base) {
						const models = getModels(base);
						modelId = models[0]?.id;
					}
				} catch {}
			}
			if (!modelId) continue;
			const model = tryGetModel(providerName, modelId);
			if (model) {
				result.push({ model, provider: providerName, modelId, score: scores[cand.id] || 0 });
				break; // one model per candidate is enough; the loop tries next candidate
			}
		}
	}
	return result;
}

// ─── Model resolution ─────────────────────────────────────────────────────────

function tryGetModel(providerName, modelId) {
	// API key providers: create a virtual model object (no pi-ai needed)
	const keyEntry = getApiKeyEntry(providerName);
	if (keyEntry) {
		const models = keyEntry.models || [];
		if (models.length > 0 && !models.includes(modelId)) return null;
		return { id: modelId, provider: providerName, __apiKey: true };
	}

	const base = getBaseProvider(providerName);
	if (!base) return null;
	try {
		return getModel(base, modelId);
	} catch { return null; }
}

/**
 * Direct proxy to an OpenAI-compatible endpoint (for API key providers).
 * Bypasses pi-ai entirely -- just forwards the request and streams back.
 */
async function proxyToApiKeyProvider(res, keyEntry, apiKey, requestBody, doStream) {
	const baseUrl = (keyEntry.baseUrl || inferBaseUrl(apiKey)).replace(/\/+$/, "");
	const url = `${baseUrl}/chat/completions`;

	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
	};

	const resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(requestBody) });

	if (!resp.ok) {
		const errText = await resp.text().catch(() => "");
		const status = resp.status;
		if (status === 429 || /rate.?limit|too many/i.test(errText)) throw new Error(`Rate limited (${status})`);
		throw new Error(`API error ${status}: ${errText.slice(0, 200)}`);
	}

	if (doStream) {
		res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
		// Pipe the SSE stream directly
		const reader = resp.body.getReader();
		const dec = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				if (!res.destroyed) res.write(dec.decode(value, { stream: true }));
			}
		} finally {
			if (!res.destroyed) res.end();
		}
	} else {
		const data = await resp.json();
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data));
	}

	return resp;
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

	// ── v2 routing: check if this is a mode or v2 preset ──
	if (config.modes.length > 0 || (config.presets.some((p) => p.mode))) {
		const v2 = await routeViaV2(modelId, { now: new Date(), history: [] });
		if (v2 && v2.length > 0) {
			log(`[v2] routed ${modelId} -> ${v2.length} candidates`);
			return v2;
		}
	}

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

async function handleStreaming(res, model, context, opts, requestModelId, actualProvider, requestText, username) {
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
	let collectedResponseText = "";

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
				collectedResponseText += event.delta || "";
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
				collectedResponseText += `\n[Tool call: ${tc.name}]\n`;

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
				trackRequest(actualProvider, model.id, event.message?.usage, Date.now() - t0, null, requestText, collectedResponseText, username);
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
				trackRequest(actualProvider, model.id, null, Date.now() - t0, errMsg, requestText, collectedResponseText, username);
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

async function handleNonStreaming(res, model, context, opts, requestModelId, actualProvider, requestText, username) {
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
				break;
			case "error": {
				const errMsg = event.error?.errorMessage || "Unknown error";
				trackRequest(actualProvider, model.id, null, Date.now() - t0, errMsg, requestText, fullText, username);
				if (isRateLimit(errMsg)) throw new Error(errMsg);
				throw new Error(errMsg);
			}
		}
	}

	// ── Response-side rule evaluation ──
	const respRules = loadRules();
	if (respRules.length > 0 && fullText) {
		const respBlock = checkResponseBlock(respRules, fullText);
		if (respBlock.blocked) {
			trackRequest(actualProvider, model.id, usage, Date.now() - t0, respBlock.message, requestText, fullText, username);
			res.writeHead(403, json());
			res.end(JSON.stringify({ error: { message: respBlock.message } }));
			return;
		}
		fullText = redactResponse(respRules, fullText);
	}

	trackRequest(actualProvider, model.id, usage, Date.now() - t0, null, requestText, fullText, username);

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
	// Auth
	const auth = authenticateRequest(req);
	if (!auth.valid) {
		res.writeHead(401, json());
		res.end(JSON.stringify({ error: { message: "Unauthorized. Provide Bearer token in Authorization header." } }));
		return;
	}
	const username = auth.user?.username || null;

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
		messages: incomingMessages,
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
	let requestMessages = incomingMessages;

	if (!requestModelId || !requestMessages) {
		res.writeHead(400, json());
		res.end(JSON.stringify({ error: { message: "model and messages are required" } }));
		return;
	}

	// ── Budget check ──
	const budgetCheck = checkUserBudget(auth.user, auth.role);
	if (!budgetCheck.allowed) {
		res.writeHead(429, json());
		res.end(JSON.stringify({ error: { message: budgetCheck.message } }));
		return;
	}

	// ── User access check ──
	if (!isModelAllowedForUser(auth.user, auth.role, requestModelId)) {
		res.writeHead(403, json());
		res.end(JSON.stringify({ error: { message: `Model "${requestModelId}" is not allowed for user "${username}". Allowed: ${[...(auth.user.allowedPresets || []), ...(auth.user.allowedPools || []).map((p) => "pool:" + p)].join(", ") || "none"}` } }));
		return;
	}

	// ── Rule evaluation: pre-flight ──
	const rules = loadRules();
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
		const contentCheck = evaluateContentRules(rules, requestMessages, "request");
		if (contentCheck.blocked) {
			res.writeHead(403, json());
			res.end(JSON.stringify({ error: { message: contentCheck.message } }));
			return;
		}
		requestMessages = contentCheck.messages; // may be redacted
		parsed.messages = requestMessages;
	}

	const candidates = await resolveCandidates(requestModelId);
	if (candidates.length === 0) {
		res.writeHead(404, json());
		res.end(JSON.stringify({ error: { message: `No provider found for model "${requestModelId}"` } }));
		return;
	}

	const requestText = extractText(requestMessages);
	const context = toContext(requestMessages, tools);
	const maxAttempts = Math.min(candidates.length, 5);
	let lastError = null;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const candidate = candidates[attempt];

		try {
			const apiKey = await getApiKeyForProvider(candidate.provider);
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

			// API key providers: direct proxy (bypass pi-ai)
			const keyEntry = getApiKeyEntry(candidate.provider);
			if (keyEntry) {
				const t0p = Date.now();
				const proxyBody = { ...parsed, model: candidate.modelId, messages: requestMessages, stream: doStream };
				await proxyToApiKeyProvider(res, keyEntry, apiKey, proxyBody, doStream);
				trackRequest(candidate.provider, candidate.modelId, null, Date.now() - t0p, null, requestText, null, username);
				return;
			}

			if (doStream) {
				await handleStreaming(res, candidate.model, context, opts, requestModelId, candidate.provider, requestText, username);
			} else {
				await handleNonStreaming(res, candidate.model, context, opts, requestModelId, candidate.provider, requestText, username);
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
		users: Object.entries(userStats).map(([uname, s]) => {
			const userCfg = loadUsers().find((u) => u.username === uname);
			return { username: uname, ...s, budgets: userCfg?.budgets || null };
		}),
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
	serveStaticFile(res, join(WEB_DIR, "admin", "index.html"));
}


function handleUI(req, res) {
	serveStaticFile(res, join(WEB_DIR, "ui", "index.html"));
}


// ─── Server ───────────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
	res.setHeader("Access-Control-Allow-Origin", "*");
	res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
	if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

	const path = new URL(req.url, `http://localhost:${PORT}`).pathname;
	try {
		// ── Public routes (no auth) ──
		if (path === "/health" && req.method === "GET") { handleHealth(req, res); return; }
		if (path.startsWith("/web/") && req.method === "GET") { handleWebAsset(req, res, path); return; }
		if (path === "/admin" || path === "/ui" || path === "/") { (path === "/admin" ? handleAdmin : handleUI)(req, res); return; }

		// ── Token verify endpoint (for login screens) ──
		if (path === "/v1/auth/verify" && req.method === "POST") {
			const auth = authenticateRequest(req);
			if (!auth.valid) { res.writeHead(401, json()); res.end(JSON.stringify({ valid: false })); }
			else { res.writeHead(200, json()); res.end(JSON.stringify({ valid: true, role: auth.role, username: auth.user?.username, allowedPresets: auth.user?.allowedPresets, allowedPools: auth.user?.allowedPools })); }
			return;
		}

		// ── Auth required for all /v1/* endpoints ──
		const auth = authenticateRequest(req);
		if (!auth.valid) {
			res.writeHead(401, json());
			res.end(JSON.stringify({ error: { message: "Unauthorized. Provide Bearer token in Authorization header." } }));
			return;
		}

		// ── Admin-only routes ──
		const isAdmin = auth.role === "admin";
		const adminOnly = () => {
			if (!isAdmin) { res.writeHead(403, json()); res.end(JSON.stringify({ error: { message: "Admin access required" } })); return true; }
			return false;
		};
		// ── Block writes when JS config is in use ──
		const isWrite = req.method === "POST" || req.method === "PUT" || req.method === "DELETE";
		if (isWrite && isReadOnlyConfig() && path.startsWith("/v1/config/")) {
			res.writeHead(403, json());
			res.end(JSON.stringify({ error: { message: "Config is managed by multi-pass.config.js (read-only via admin)" } }));
			return;
		}

		// ── API routes ──
		if (path === "/v1/chat/completions" && req.method === "POST") await handleChatCompletions(req, res);
		else if (path === "/v1/models" && req.method === "GET") handleModels(req, res);
		else if (path === "/v1/routing" && req.method === "GET") handleRouting(req, res);
		// Admin-only endpoints
		else if (path === "/v1/quota" && req.method === "GET") { if (!adminOnly()) await handleQuota(req, res); }
		else if (path === "/v1/stats" && req.method === "GET") { if (!adminOnly()) handleStats(req, res); }
		else if (path === "/v1/rules" && req.method === "GET") { if (!adminOnly()) handleRulesList(req, res); }
		else if (path === "/v1/rules" && req.method === "POST") { if (!adminOnly()) await handleRulesCreate(req, res); }
		else if (path.startsWith("/v1/rules/") && req.method === "PUT") { if (!adminOnly()) await handleRulesUpdate(req, res, decodeURIComponent(path.split("/v1/rules/")[1])); }
		else if (path.startsWith("/v1/rules/") && req.method === "DELETE") { if (!adminOnly()) handleRulesDelete(req, res, decodeURIComponent(path.split("/v1/rules/")[1])); }
		else if (path === "/v1/audit" && req.method === "GET") { if (!adminOnly()) handleAuditLog(req, res); }
		else if (path === "/v1/auth/providers" && req.method === "GET") { if (!adminOnly()) await handleAuthProviders(req, res); }
		else if (path === "/v1/auth/status" && req.method === "GET") { if (!adminOnly()) handleAuthStatus(req, res); }
		else if (path === "/v1/auth/names" && req.method === "GET") { if (!adminOnly()) handleKnownNames(req, res); }
		else if (path.startsWith("/v1/auth/login/") && req.method === "POST") { if (!adminOnly()) await handleAuthLogin(req, res, decodeURIComponent(path.split("/v1/auth/login/")[1])); }
		else if (path.startsWith("/v1/auth/login/") && req.method === "GET") { if (!adminOnly()) handleAuthLoginStatus(req, res, decodeURIComponent(path.split("/v1/auth/login/")[1])); }
		else if (path.startsWith("/v1/auth/logout/") && req.method === "POST") { if (!adminOnly()) await handleAuthLogout(req, res, decodeURIComponent(path.split("/v1/auth/logout/")[1])); }
		else if (path === "/v1/config" && req.method === "GET") { if (!adminOnly()) handleConfigGet(req, res); }
		else if (path === "/v1/config" && req.method === "PUT") { if (!adminOnly()) await handleConfigPut(req, res); }
		else if (path === "/v1/config/pools" && req.method === "GET") { if (!adminOnly()) await handlePoolsGet(req, res); }
		else if (path === "/v1/config/pools" && req.method === "POST") { if (!adminOnly()) await handlePoolCreate(req, res); }
		else if (path.startsWith("/v1/config/pools/") && req.method === "PUT") { if (!adminOnly()) await handlePoolUpdate(req, res, decodeURIComponent(path.split("/v1/config/pools/")[1])); }
		else if (path.startsWith("/v1/config/pools/") && req.method === "DELETE") { if (!adminOnly()) handlePoolDelete(req, res, decodeURIComponent(path.split("/v1/config/pools/")[1])); }
		else if (path === "/v1/config/chains" && req.method === "POST") { if (!adminOnly()) await handleChainCreate(req, res); }
		else if (path.startsWith("/v1/config/chains/") && req.method === "PUT") { if (!adminOnly()) await handleChainUpdate(req, res, decodeURIComponent(path.split("/v1/config/chains/")[1])); }
		else if (path.startsWith("/v1/config/chains/") && req.method === "DELETE") { if (!adminOnly()) handleChainDelete(req, res, decodeURIComponent(path.split("/v1/config/chains/")[1])); }
		else if (path === "/v1/config/presets" && req.method === "POST") { if (!adminOnly()) await handlePresetCreate(req, res); }
		else if (path.startsWith("/v1/config/presets/") && req.method === "PUT") { if (!adminOnly()) await handlePresetUpdate(req, res, decodeURIComponent(path.split("/v1/config/presets/")[1])); }
		else if (path.startsWith("/v1/config/presets/") && req.method === "DELETE") { if (!adminOnly()) handlePresetDelete(req, res, decodeURIComponent(path.split("/v1/config/presets/")[1])); }
		else if (path === "/v1/config/subscriptions" && req.method === "POST") { if (!adminOnly()) await handleSubCreate(req, res); }
		else if (path.startsWith("/v1/config/subscriptions/") && req.method === "PUT") { if (!adminOnly()) await handleSubUpdate(req, res, decodeURIComponent(path.split("/v1/config/subscriptions/")[1])); }
		else if (path.startsWith("/v1/config/subscriptions/") && req.method === "DELETE") { if (!adminOnly()) handleSubDelete(req, res, decodeURIComponent(path.split("/v1/config/subscriptions/")[1])); }
		// API keys
		else if (path === "/v1/config/apikeys" && req.method === "POST") { if (!adminOnly()) await handleApiKeyCreate(req, res); }
		else if (path.startsWith("/v1/config/apikeys/") && req.method === "PUT") { if (!adminOnly()) await handleApiKeyUpdate(req, res, decodeURIComponent(path.split("/v1/config/apikeys/")[1])); }
		else if (path.startsWith("/v1/config/apikeys/") && req.method === "DELETE") { if (!adminOnly()) handleApiKeyDelete(req, res, decodeURIComponent(path.split("/v1/config/apikeys/")[1])); }
		// User management (admin only)
		else if (path === "/v1/users" && req.method === "GET") { if (!adminOnly()) handleUsersList(req, res); }
		else if (path === "/v1/users" && req.method === "POST") { if (!adminOnly()) await handleUserCreate(req, res); }
		else if (path.startsWith("/v1/users/") && path.endsWith("/key") && req.method === "GET") { if (!adminOnly()) handleUserRevealKey(req, res, decodeURIComponent(path.split("/v1/users/")[1].replace("/key", ""))); }
		else if (path.startsWith("/v1/users/") && req.method === "PUT") { if (!adminOnly()) await handleUserUpdate(req, res, decodeURIComponent(path.split("/v1/users/")[1])); }
		else if (path.startsWith("/v1/users/") && req.method === "DELETE") { if (!adminOnly()) handleUserDelete(req, res, decodeURIComponent(path.split("/v1/users/")[1])); }
		else { res.writeHead(404, json()); res.end(JSON.stringify({ error: { message: "Not found" } })); }
	} catch (err) {
		log("Unhandled:", err?.message || err);
		if (!res.headersSent) { res.writeHead(500, json()); res.end(JSON.stringify({ error: { message: "Internal server error" } })); }
	}
});

// ─── Init wizard ──────────────────────────────────────────────────────────────

async function runInit() {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

	console.log("\n  Leeloo init -- quick setup wizard\n");

	// Admin token
	let key = await ask("  Admin token (leave empty to generate random): ");
	key = key.trim() || randomBytes(24).toString("hex");

	// Port
	let port = await ask("  Port [4000]: ");
	port = port.trim() || "4000";

	// Write .env
	const envPath = join(dirname(fileURLToPath(import.meta.url)), ".env");
	const envContent = [
		"# Leeloo configuration",
		`LEELOO_KEY=${key}`,
		`LEELOO_PORT=${port}`,
		"",
	].join("\n");
	writeFileSync(envPath, envContent, "utf-8");
	console.log(`\n  Created ${envPath}`);

	// Create config if missing
	const agentDir = getAgentDir();
	const configPath = join(agentDir, "multi-pass.json");
	if (!existsSync(configPath)) {
		if (!existsSync(agentDir)) mkdirSync(agentDir, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ subscriptions: [], pools: [], chains: [], presets: [] }, null, 2), "utf-8");
		console.log(`  Created ${configPath}`);
	} else {
		console.log(`  Config already exists: ${configPath}`);
	}

	console.log(`
  Done! Start Leeloo:

    node leeloo.js

  Then open:
    Admin:  http://localhost:${port}/admin
    Chat:   http://localhost:${port}/ui
    API:    http://localhost:${port}/v1

  Admin token: ${key}
`);
	rl.close();
}

// ─── Migration: v1 -> v2 shape ────────────────────────────────────────────────

async function runMigrate() {
	if (!existsSync(CONFIG_PATH)) {
		console.log(`No config at ${CONFIG_PATH}. Run 'leeloo init' first.`);
		return;
	}

	const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
	const before = JSON.stringify(raw, null, 2);

	// Backup
	const backupPath = CONFIG_PATH + ".v1.bak";
	writeFileSync(backupPath, before, "utf-8");
	console.log(`\n  Backed up ${CONFIG_PATH} -> ${backupPath}`);

	// Build accounts from subscriptions + apiKeys + base providers seen in pools
	const accounts = Array.isArray(raw.accounts) ? [...raw.accounts] : [];
	const accountIds = new Set(accounts.map((a) => a.id));

	for (const sub of raw.subscriptions || []) {
		const id = `${sub.provider}-${sub.index}`;
		if (!accountIds.has(id)) {
			accounts.push({ id, provider: sub.provider, kind: "subscription", label: sub.label || "" });
			accountIds.add(id);
		}
	}
	for (const k of raw.apiKeys || []) {
		if (!accountIds.has(k.name)) {
			accounts.push({ id: k.name, provider: "openai", kind: "apiKey", key: k.key, baseUrl: k.baseUrl, label: k.label || "" });
			accountIds.add(k.name);
		}
	}

	// Convert old presets that have entries[] to new shape with mode
	const modes = Array.isArray(raw.modes) ? [...raw.modes] : [];
	const newPresets = [];
	for (const p of raw.presets || []) {
		if (p.mode) { newPresets.push(p); continue; } // already v2
		if (!p.entries || p.entries.length === 0) { newPresets.push(p); continue; }

		// Generate a mode from the entries
		const modeId = `mode-${p.name}`;
		const modeCandidates = p.entries.filter((e) => e.enabled !== false).map((e) => e.provider);
		const preferredModels = p.entries.filter((e) => e.enabled !== false && e.model).map((e) => e.model);
		modes.push({
			id: modeId,
			description: `Auto-generated from preset "${p.name}"`,
			candidates: modeCandidates,
			rules: ["builtin-cooldown"],
			onError: "next-in-order",
		});
		newPresets.push({
			...p,
			mode: modeId,
			preferredModels,
			fallbackModels: [],
		});
	}

	// Ensure builtin cooldown rule exists
	const routingRules = Array.isArray(raw.routingRules) ? [...raw.routingRules] : [];
	if (!routingRules.find((r) => r.id === "builtin-cooldown")) {
		routingRules.push({ id: "builtin-cooldown", type: "cooldown", description: "Skip exhausted candidates" });
	}

	const v2 = {
		...raw,
		accounts,
		modes,
		routingRules,
		presets: newPresets,
	};

	writeFileSync(CONFIG_PATH, JSON.stringify(v2, null, 2), "utf-8");

	console.log(`\n  Migration complete:`);
	console.log(`    accounts: ${accounts.length} (was ${(raw.accounts || []).length})`);
	console.log(`    modes:    ${modes.length} (was ${(raw.modes || []).length})`);
	console.log(`    rules:    ${routingRules.length} (was ${(raw.routingRules || []).length})`);
	console.log(`    presets:  ${newPresets.length}`);
	console.log(`\n  Restore with: cp ${backupPath} ${CONFIG_PATH}\n`);
}

// ─── Export: JSON -> JS config ────────────────────────────────────────────────

async function runExportJs() {
	if (!existsSync(CONFIG_PATH)) {
		console.log(`No config at ${CONFIG_PATH}.`);
		return;
	}
	const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));

	const accountsCode = (raw.accounts || []).map((a) => `    account("${a.id}", ${JSON.stringify({ provider: a.provider, kind: a.kind, label: a.label, key: a.key, baseUrl: a.baseUrl })})`).join(",\n");
	const poolsCode = (raw.pools || []).map((p) => `    pool("${p.name || p.id}", ${JSON.stringify({ baseProvider: p.baseProvider, members: p.members, strategy: p.strategy })})`).join(",\n");
	const rulesCode = (raw.routingRules || []).map((r) => {
		if (r.type === "time-window") return `    rule.timeWindow("${r.id}", ${JSON.stringify(r.params)})`;
		if (r.type === "quota-burn") return `    rule.quotaBurn("${r.id}", ${JSON.stringify(r.params || {})})`;
		if (r.type === "cost-tier") return `    rule.costTier("${r.id}", ${JSON.stringify(r.params)})`;
		if (r.type === "cooldown") return `    rule.cooldown("${r.id}")`;
		if (r.type === "model-fit") return `    rule.modelFit("${r.id}", ${JSON.stringify(r.params)})`;
		if (r.type === "error-blacklist") return `    rule.errorBlacklist("${r.id}", ${JSON.stringify(r.params || {})})`;
		if (r.type === "custom") return `    rule.custom("${r.id}", ${JSON.stringify(r.params?.code || "")})`;
		return `    /* unknown rule type: ${r.type} */`;
	}).join(",\n");
	const modesCode = (raw.modes || []).map((m) => `    mode("${m.id}", ${JSON.stringify({ description: m.description, candidates: m.candidates, rules: m.rules, onError: m.onError })})`).join(",\n");
	const presetsCode = (raw.presets || []).map((p) => `    preset("${p.name || p.id}", ${JSON.stringify({ mode: p.mode, preferredModels: p.preferredModels, fallbackModels: p.fallbackModels, entries: p.entries })})`).join(",\n");

	const out = `// Auto-generated from ${CONFIG_PATH}
// Edit freely -- when this file exists, JSON config is ignored.
import { defineConfig, account, pool, mode, preset, rule } from "/PATH/TO/pi-multi-pass/config.js";

export default defineConfig({
  accounts: [
${accountsCode}
  ],
  pools: [
${poolsCode}
  ],
  rules: [
${rulesCode}
  ],
  modes: [
${modesCode}
  ],
  presets: [
${presetsCode}
  ],
});
`;
	const outPath = join(AGENT_DIR, "multi-pass.config.js.exported");
	writeFileSync(outPath, out, "utf-8");
	console.log(`\n  Exported to ${outPath}`);
	console.log(`  Update the import path, then move to ${join(AGENT_DIR, "multi-pass.config.js")} to activate.\n`);
}

// Run CLI commands and exit (no server)
if (CLI_COMMAND === "init") { await runInit(); process.exit(0); }
if (CLI_COMMAND === "migrate") { await runMigrate(); process.exit(0); }
if (CLI_COMMAND === "export-js") { await runExportJs(); process.exit(0); }

// Load JS config (if any) before binding the server
const _jsPath = getJsConfigPath();
if (_jsPath) {
	await loadJsConfig(_jsPath);
}

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

  Admin token: ${ADMIN_TOKEN}
  ${process.env.LEELOO_KEY ? "(from LEELOO_KEY" + (envFile ? " via " + envFile : " env") + ")" : "(random -- run 'leeloo init' or set LEELOO_KEY to persist)"}
${_jsPath ? `\n  Config: ${_jsPath} (read-only via JS)` : ""}
`);

	rotateUsageLog();
});
