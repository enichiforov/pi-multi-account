# pi-multi-pass: routing v2 architecture plan

Status: **draft**
Date: 2026-04-06

## Context

This plan responds to Gabriel's feedback in PR #11. Quoting the gist:

> One thing I noticed is that pools, at least in the way I understood them while testing, seem to be mostly centered around accounts of the same provider. That is definitely useful, but I am still unsure whether that is enough for the kind of routing I would want to do in practice.
>
> The simpler mental model I keep coming back to is something like this:
> - **accounts**: the real access points
> - **usage modes**: coding-premium, planning-budget, testing, ...
> - **rules**: small reusable decision pieces (time windows, quota burn, context fit, ...)
>
> Then on each request the router would: start from the mode -> gather eligible candidates -> run rules -> rank -> try the best one -> on error re-evaluate.

He's right. The current model is great at same-provider failover (10 OpenAI keys in a pool) but terrible at *cross-provider intent routing* (mix Anthropic + OpenAI + OpenRouter in one mode, prefer Anthropic during evening hours, burn expiring quotas first).

We're not doing YAML. We are going to add a `.js` config option for power users while keeping JSON + admin UI for everyone else.

## Current model vs target model

### Current (v1)

```
subscriptions (extra OAuth accounts per provider)
    │
    ├─> pools (same-provider rotation, strategy: round-robin/quota-first/scheduled/custom)
    │       │
    │       └─> chains (ordered list of pools, static failover)
    │               │
    │               └─> presets (ordered list of provider/model entries)
    │
    └─> apiKeys (raw API keys, not grouped by provider)
```

Strategies are scoped to pools. Chains are static. Presets are dumb ordered lists.

### Target (v2)

```
accounts (unified: subscriptions + apiKeys, any provider)
    │
    ├─> pools (still useful for same-provider rotation -- keep)
    │
    ├─> rules (reusable decision functions: time, quota, context, cost, custom JS)
    │
    ├─> modes (cross-provider intent routing: candidates + rules + onError)
    │       │
    │       └─> client-side virtual models
    │
    └─> presets (alias: mode + optional model preferences for clients)
```

Key shifts:
1. **`accounts` is the new primitive** -- unifies subscriptions and apiKeys into one concept. A pool is a special case of "candidates that share a provider".
2. **`rules` are first-class and reusable** -- not coupled to pools. A rule is a pure function that takes a list of candidates + context and returns a filtered/ranked list.
3. **`modes` are the routing engine** -- they declare candidates (accounts, pools, or other modes) and a rule pipeline. The router walks the pipeline per request.
4. **`presets` become client-facing aliases** -- they map a virtual model name (`coding-premium`) to a mode + optional preferred model list.

## New concepts

### Account

Unifies `subscription` and `apiKey`:

```js
{
  id: 'openai-main',          // unique ID, used everywhere
  provider: 'openai-codex',   // base provider type
  kind: 'subscription',       // 'subscription' (OAuth) or 'apiKey' (raw key)
  label: 'My Codex Pro',      // human label
  enabled: true,
  // for kind=subscription: pi-multi-pass handles OAuth via authStorage
  // for kind=apiKey:
  key: 'sk-...',
  baseUrl: 'https://api.openai.com/v1',  // optional, auto-inferred
}
```

### Pool

Same as today, but `members` reference `account.id` (not raw provider names):

```js
{
  id: 'openai-shared',
  members: ['openai-main', 'openai-alt'],
  strategy: 'round-robin' | 'quota-first' | 'scheduled' | 'custom',
  // strategy stays useful for same-provider failover
}
```

### Rule

A rule is a pure function that takes `(candidates, context)` and returns a list of candidates with optional ordering hints (priority scores). Rules can:

- **filter**: remove candidates from the list
- **rank**: assign scores to reorder candidates
- **annotate**: add metadata used by other rules

```js
{
  id: 'prefer-anthropic-evening',
  type: 'time-window',           // built-in type
  description: 'Prefer Anthropic during evening hours',
  params: {
    targets: ['anthropic-shared'],
    windows: [
      { days: ['mon','tue','wed','thu','fri'], hours: [18, 23], tz: 'Europe/Vienna' },
    ],
    boost: 100,                  // priority boost when active
  },
}
```

### Built-in rule types (proposed)

| Type | Purpose | Params |
|---|---|---|
| `time-window` | Boost certain accounts during time windows (discount hours, off-peak, etc.) | targets, windows, boost |
| `quota-burn` | Prefer accounts whose quota window expires sooner (use it before you lose it) | targets? |
| `quota-first` | Prefer accounts with the most remaining quota | targets? |
| `cost-tier` | Prefer cheap/free options for simple work | targets, costMap |
| `model-fit` | Demote candidates that can't handle the request size or capability | minContext, requireTools, requireVision |
| `context-fit` | Demote candidates whose context window is too small for the prompt | -- |
| `error-blacklist` | Skip candidates that errored in the recent history | window |
| `cooldown` | Skip exhausted candidates (current behavior) | -- |
| `custom` | Run a JS function | code (path) or fn (inline in JS config) |

### Mode

A mode declares a routing pipeline:

```js
{
  id: 'coding-premium',
  description: 'Best quality coding mode',
  candidates: ['openai-shared', 'anthropic-shared', 'copilot-main', 'openrouter-main'],
  // candidates can reference: account.id, pool.id, or other mode.id
  rules: [
    'avoid-bad-context-fit',
    'prefer-anthropic-evening',
    'burn-expiring-quotas-first',
  ],
  onError: 're-evaluate',  // 're-evaluate' | 'next-in-order' | 'fail-fast'
}
```

The router pipeline for each request:

```
1. Resolve mode.candidates -> flat list of accounts (expand pools and nested modes)
2. Filter out unavailable (no auth, exhausted, disabled)
3. For each rule in mode.rules (in order):
     candidates = rule.apply(candidates, context)
4. Sort by score (descending)
5. Try the top candidate
6. On error:
     - record error in context.history
     - if onError === 're-evaluate': go to step 3 (rules see the new error)
     - if onError === 'next-in-order': try next candidate from step 4 list
     - if onError === 'fail-fast': return error
```

### Preset

Becomes a client-facing alias:

```js
{
  id: 'coding-premium',                   // virtual model name in OpenAI API
  mode: 'coding-premium',                 // which mode to use for routing
  preferredModels: [                       // optional: ranked list of model IDs
    'gpt-5.4',
    'claude-opus',
    'gemini-3-pro',
  ],
  fallbackModels: [                        // try these if no preferred is available
    'claude-sonnet-4',
    'o3',
  ],
}
```

When a client sends `model: "coding-premium"`:
1. Resolve preset -> mode
2. Run mode pipeline to get top candidate (account)
3. Pick the highest-priority preferred model that the candidate supports
4. Send the request

This is the cross-provider intent routing Gabriel wants.

## Config formats

We support **two equivalent formats** with the same loader:

### Format 1: JSON (existing, admin UI editable)

`~/.pi/agent/multi-pass.json` -- new shape:

```json
{
  "accounts": [
    { "id": "openai-main", "provider": "openai-codex", "kind": "subscription" },
    { "id": "openrouter-main", "provider": "openrouter", "kind": "apiKey", "key": "sk-or-..." }
  ],
  "pools": [
    { "id": "openai-shared", "members": ["openai-main", "openai-alt"], "strategy": "round-robin" }
  ],
  "rules": [
    {
      "id": "prefer-anthropic-evening",
      "type": "time-window",
      "params": { "targets": ["anthropic-shared"], "windows": [{ "days": ["mon-fri"], "hours": [18, 23] }], "boost": 100 }
    }
  ],
  "modes": [
    {
      "id": "coding-premium",
      "candidates": ["openai-shared", "anthropic-shared"],
      "rules": ["prefer-anthropic-evening", "burn-expiring-quotas-first"],
      "onError": "re-evaluate"
    }
  ],
  "presets": [
    { "id": "coding-premium", "mode": "coding-premium", "preferredModels": ["claude-opus", "gpt-5.4"] }
  ]
}
```

Migration: existing `subscriptions` + `apiKeys` are auto-converted to `accounts` on first load. Existing `pools` keep working but `members` references switch to account IDs.

### Format 2: JavaScript (new, power user)

`~/.pi/agent/multi-pass.config.js` -- if present, used instead of JSON:

```js
import { defineConfig, rule, mode, preset, account, pool } from "pi-multi-pass/config";

export default defineConfig({
  accounts: [
    account("openai-main", { provider: "openai-codex", kind: "subscription" }),
    account("openrouter", {
      provider: "openrouter",
      kind: "apiKey",
      key: process.env.OPENROUTER_KEY,  // computed at startup
    }),
  ],

  pools: [
    pool("openai-shared", { members: ["openai-main", "openai-alt"], strategy: "round-robin" }),
  ],

  rules: [
    rule.timeWindow("prefer-anthropic-evening", {
      targets: ["anthropic-shared"],
      windows: [{ days: ["mon-fri"], hours: [18, 23], tz: "Europe/Vienna" }],
      boost: 100,
    }),

    rule.quotaBurn("burn-expiring-first"),

    rule.costTier("prefer-cheap", {
      targets: ["openrouter", "copilot-main"],
      costMap: { "gpt-4o": 0.005, "claude-haiku": 0.001 },
    }),

    // Inline custom rule -- no separate file needed
    rule.custom("avoid-personal-models", async (candidates, ctx) => {
      if (ctx.userTag === "team") return candidates;
      return candidates.filter((c) => !c.id.includes("personal"));
    }),
  ],

  modes: [
    mode("coding-premium", {
      candidates: ["openai-shared", "anthropic-shared", "copilot-main"],
      rules: ["avoid-bad-context-fit", "prefer-anthropic-evening", "burn-expiring-first"],
      onError: "re-evaluate",
    }),

    mode("coding-budget", {
      candidates: ["openrouter", "copilot-main", "openai-shared"],
      rules: ["prefer-cheap", "burn-expiring-first"],
      onError: "re-evaluate",
    }),
  ],

  presets: [
    preset("coding-premium", {
      mode: "coding-premium",
      preferredModels: ["claude-opus", "gpt-5.4", "gemini-3-pro"],
      fallbackModels: ["claude-sonnet-4", "o3"],
    }),
  ],
});
```

**Why JS over YAML:**
- Native types and IntelliSense (`.d.ts` for the helpers)
- Computed values (env vars, conditionals, imports)
- Custom rules can be inline functions (no separate `code: ./path` files)
- Composability via JS imports (split rules across files, share between projects)
- Validation at module load (errors caught immediately)
- No new parser dependency (Node already runs JS)

**Loader behavior:**
1. If `multi-pass.config.js` exists -> import it, use the exported config
2. Else if `multi-pass.json` exists -> load JSON
3. Resolve to a normalized in-memory shape (same internal type for both)
4. Compile rules: built-in types -> built-in implementations; `rule.custom()` -> store the function reference

**Admin UI behavior with JS config:**
- JSON config: full read/write in admin
- JS config detected: admin shows banner "JS config detected at ~/.pi/agent/multi-pass.config.js -- editing disabled". Tabs become read-only viewers.
- Power users own their config, casual users get the GUI.

## Routing pipeline implementation

Replace the current `resolveCandidates` function with a new `routeRequest`:

```js
async function routeRequest(modelOrPresetId, requestContext) {
  // requestContext: { messages, tools, user, request, history: [], lastError? }

  // 1. Resolve preset -> mode (or treat as direct mode/pool/account ref)
  const mode = resolveMode(modelOrPresetId);
  if (!mode) return resolveLegacyCandidates(modelOrPresetId);

  // 2. Gather candidates (expand pools and nested modes recursively)
  let candidates = expandCandidates(mode.candidates);

  // 3. Filter unavailable
  candidates = candidates.filter((c) => isAccountAvailable(c.id));

  // 4. Apply rule pipeline
  for (const ruleId of mode.rules) {
    const rule = getRule(ruleId);
    candidates = await rule.apply(candidates, requestContext);
  }

  // 5. Sort by score
  candidates.sort((a, b) => (b.score || 0) - (a.score || 0));

  // 6. Try in order, with error feedback
  for (const candidate of candidates) {
    try {
      return await tryCandidate(candidate, requestContext);
    } catch (err) {
      requestContext.history.push({ candidate: candidate.id, error: err.message });
      requestContext.lastError = err;

      if (mode.onError === "re-evaluate") {
        // restart from step 4 -- rules see the new error context
        return routeRequest(modelOrPresetId, requestContext);
      }
      // 'next-in-order': just continue the loop
      // 'fail-fast': throw
      if (mode.onError === "fail-fast") throw err;
    }
  }

  throw new Error(`All candidates exhausted for ${modelOrPresetId}`);
}
```

## Migration path

We don't break existing users. Phased rollout:

### Phase A: parallel models (no breaking changes)
- Add `accounts`, `rules`, `modes` to config schema
- Existing `subscriptions` and `apiKeys` auto-convert to `accounts` at load time
- New routing pipeline runs only for IDs that resolve as a `mode` or new-style `preset`
- Old `chains` and old-style `presets` keep using current code path
- New admin tab: **Routing** with rule/mode editor (separate from existing tabs)

### Phase B: bridge old to new
- Old pool strategies (`scheduled`, `quota-first`) become rule types under the hood
- Old `chains` are auto-translated to a generated mode
- Admin UI surfaces both old and new editors side by side
- Docs encourage new model

### Phase C: deprecate old shape
- Show deprecation warning when old `subscriptions`/`chains` keys are used in JSON
- Provide a `multi-pass migrate` CLI command that converts JSON to v2 shape
- Old admin tabs marked "(legacy)"
- Default new installs to v2 shape

### Phase D: remove legacy (optional, far future)
- Drop support for old `subscriptions`/`chains` keys
- Loaders error out with migration instructions

## Admin UI changes

### New tabs / sections in `/admin -> Config`

| Section | Replaces / adds |
|---|---|
| **Accounts** | Unified replacement for OAuth + API keys panels (unified list, kind dropdown) |
| **Pools** | Existing, but member dropdowns reference account IDs |
| **Rules** | NEW -- create rules from built-in types (time-window, quota-burn, cost-tier, etc.) with form per type |
| **Modes** | NEW -- candidate picker (accounts/pools/modes), rule list (drag-to-reorder), onError dropdown |
| **Presets** | Updated -- mode picker + preferredModels chip list + fallbackModels |

### Read-only mode for JS config

When `multi-pass.config.js` exists:
- Banner at top: "Config from JS file. Edits disabled."
- All edit/save/delete buttons hidden
- Tabs work as visualizers showing the resolved config

## Things I'm still unsure about

These mirror Gabriel's open questions:

1. **Mode vs preset overlap.** Should preferred/fallback models live in the mode or the preset? Right now the plan puts them in the preset (client-facing) but it's reasonable to argue they're a routing concern (mode).

2. **Rule order matters.** Should rules be a sorted list (current plan) or should each rule declare its phase (filter/rank/annotate)? The phased approach is cleaner but more verbose.

3. **Error context handover.** When `onError: re-evaluate` runs, how rich is the context the rules see? Do we expose the full error stack, the http status, the provider name, the prompt, the user history?

4. **Custom rules in JSON config.** We can express most things via built-in rule types in JSON, but custom JS rules require... a path to a file (current pool selectorScript pattern). Is that good enough or do JS-config-only features become a real divergence?

5. **Pools as a special case of modes.** Long term, do pools just become a built-in `same-provider-failover` rule? That would simplify the model.

## Phased implementation checklist

- [ ] **Phase 1 (this PR)**: design doc, no code yet. Get sign-off on shape.
- [ ] **Phase 2**: implement loader for both JSON and JS config formats. Compile to internal normalized shape. No routing changes.
- [ ] **Phase 3**: implement built-in rules (start with `time-window`, `quota-burn`, `cooldown`, `model-fit`, `cost-tier`).
- [ ] **Phase 4**: implement mode + routing pipeline. Run alongside existing routing for backward compat.
- [ ] **Phase 5**: implement custom JS rule support (in JS config: inline functions; in JSON: file path).
- [ ] **Phase 6**: admin UI: Accounts panel (replaces OAuth + API keys).
- [ ] **Phase 7**: admin UI: Rules panel with form per built-in type.
- [ ] **Phase 8**: admin UI: Modes panel (candidates + rules + onError).
- [ ] **Phase 9**: admin UI: updated Presets panel (mode picker, preferred/fallback models).
- [ ] **Phase 10**: JS config detection + read-only admin mode.
- [ ] **Phase 11**: migration helper (CLI + automatic on first load).
- [ ] **Phase 12**: docs update + examples (v2 quickstart, JS config example, rule cookbook).

## Decisions on the open questions

Both questions resolved without waiting -- the answers are clear and we can iterate later if real use shows otherwise.

### Q1: Mode composition -- YES

`mode.candidates` accepts account IDs, pool IDs, AND other mode IDs.

Rules:
- Inner mode's **candidates** flatten into the outer mode's candidate list
- Inner mode's **rules** do NOT propagate (the outer mode owns the pipeline)
- Cycles detected at config load time and rejected with a clear error
- Max nesting depth: 5

Example use case (Gabriel's pattern):
```js
mode("coding-premium", { candidates: ["openai-shared", "anthropic-shared", "coding-budget"], ... })
mode("coding-budget", { candidates: ["openrouter", "copilot-main"], ... })
```
When `coding-premium` exhausts paid options, the outer pipeline reaches the candidates pulled in from `coding-budget`. No special "fallback chain" concept needed.

### Q2: Scored rules + filtering -- BOTH

Rules return `{ candidates, scores }`:
- **Filter**: shrink the `candidates` array (binary in/out)
- **Score**: add entries to the `scores` map (additive, multiple rules can boost the same candidate)
- **Annotate**: attach metadata to a per-request context (other rules read it)

The router accumulates scores across all rules, sorts the final candidates by total score (descending), then tries them in order.

Default score for unscored candidates: 0. Negative scores allowed (deboost).

Built-in rule defaults:
- `time-window` -> scores (boosts targets)
- `quota-burn` -> scores (higher score for sooner-expiring quota)
- `cost-tier` -> scores (higher score for cheaper options)
- `cooldown` -> filters (removes exhausted)
- `model-fit` -> filters (removes too-small context)
- `error-blacklist` -> filters (removes recent errors)
- `custom` -> can do any combination

This gives us simple filters when you want strict in/out and scoring when you want soft preferences. They compose without ceremony.
