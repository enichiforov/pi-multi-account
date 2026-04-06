/**
 * pi-multi-pass / leeloo config helpers.
 *
 * Use these in `~/.pi/agent/multi-pass.config.js` to define your routing
 * setup with full IntelliSense, env vars, imports, and inline custom rules.
 *
 * Example:
 *
 *   import { defineConfig, account, pool, rule, mode, preset } from "pi-multi-pass/config";
 *
 *   export default defineConfig({
 *     accounts: [
 *       account("openai-main", { provider: "openai-codex", kind: "subscription" }),
 *       account("openrouter", { provider: "openrouter", kind: "apiKey", key: process.env.OPENROUTER_KEY }),
 *     ],
 *     pools: [pool("openai-shared", { members: ["openai-main", "openai-alt"], strategy: "round-robin" })],
 *     rules: [
 *       rule.timeWindow("prefer-anthropic-evening", { targets: ["anthropic-shared"], windows: [{ days: ["mon-fri"], hours: [18, 23] }], boost: 100 }),
 *       rule.quotaBurn("burn-expiring-first"),
 *       rule.custom("avoid-third-party", async (candidates, ctx) => candidates.filter(c => !c.id.includes("personal"))),
 *     ],
 *     modes: [
 *       mode("coding-premium", {
 *         candidates: ["openai-shared", "anthropic-shared", "copilot-main"],
 *         rules: ["prefer-anthropic-evening", "burn-expiring-first"],
 *         onError: "re-evaluate",
 *       }),
 *     ],
 *     presets: [
 *       preset("coding-premium", {
 *         mode: "coding-premium",
 *         preferredModels: ["claude-opus", "gpt-5.4"],
 *       }),
 *     ],
 *   });
 */

export function defineConfig(config) {
	return {
		subscriptions: config.subscriptions || [],
		apiKeys: config.apiKeys || [],
		accounts: config.accounts || [],
		pools: config.pools || [],
		chains: config.chains || [],
		modes: config.modes || [],
		routingRules: config.rules || config.routingRules || [],
		presets: config.presets || [],
	};
}

export function account(id, opts = {}) {
	return {
		id,
		provider: opts.provider,
		kind: opts.kind || "subscription",
		key: opts.key,
		baseUrl: opts.baseUrl,
		label: opts.label || "",
		enabled: opts.enabled !== false,
	};
}

export function pool(id, opts = {}) {
	return {
		name: id,
		id,
		baseProvider: opts.baseProvider || opts.provider,
		members: opts.members || [],
		strategy: opts.strategy || "round-robin",
		memberSchedule: opts.memberSchedule,
		selectorScript: opts.selectorScript,
		enabled: opts.enabled !== false,
	};
}

export function mode(id, opts = {}) {
	return {
		id,
		description: opts.description || "",
		candidates: opts.candidates || [],
		rules: opts.rules || [],
		onError: opts.onError || "re-evaluate",
		enabled: opts.enabled !== false,
	};
}

export function preset(id, opts = {}) {
	return {
		id,
		name: id,
		mode: opts.mode,
		preferredModels: opts.preferredModels || [],
		fallbackModels: opts.fallbackModels || [],
		entries: opts.entries || [], // legacy v1 support
		enabled: opts.enabled !== false,
	};
}

export const rule = {
	timeWindow(id, params) {
		return { id, type: "time-window", params, description: params.description };
	},
	quotaBurn(id, params = {}) {
		return { id, type: "quota-burn", params, description: params.description };
	},
	costTier(id, params) {
		return { id, type: "cost-tier", params, description: params.description };
	},
	modelFit(id, params) {
		return { id, type: "model-fit", params, description: params.description };
	},
	errorBlacklist(id, params = {}) {
		return { id, type: "error-blacklist", params, description: params.description };
	},
	cooldown(id, params = {}) {
		return { id, type: "cooldown", params, description: params.description };
	},
	custom(id, fnOrPath, params = {}) {
		const isFn = typeof fnOrPath === "function";
		return {
			id,
			type: "custom",
			params: { ...params, ...(isFn ? { fn: fnOrPath } : { code: fnOrPath }) },
			description: params.description,
		};
	},
};
