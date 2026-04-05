# pi-multi-pass

Multi-subscription extension for [pi](https://github.com/badlogic/pi-mono) -- use multiple OAuth accounts per provider with automatic rate-limit rotation and project-level affinity.

## Install

```bash
pi install npm:pi-multi-pass
```

Or via git:

```bash
pi install git:github.com/hjanuschka/pi-multi-pass
```

## Features

- **Multiple subscriptions**: Add extra OAuth accounts for any provider
- **Rotation pools**: Group subscriptions and auto-rotate on rate limits
- **Smart pool strategies**: `round-robin`, `quota-first`, `scheduled` (time windows), `custom` (JS script hook)
- **Fallback chains**: Define ordered cross-pool/model failover via `/pool chain`
- **Model presets**: Named routing shortcuts across providers (`/mp-preset coding-premium`)
- **Leeloo proxy**: OpenAI-compatible local proxy with full pool/chain/preset routing, chat UI, and quota dashboard (`npx pi-multi-pass`)
- **Built-in limits checks**: Inspect subscription headroom across accounts with `/subs limits`
- **Smarter retries**: Preserve failover progress across internal replay retries
- **Project affinity**: Restrict which subs/pools/chains are used per project
- **TUI management**: `/subs`, `/pool`, and `/mp-preset` commands -- no config files needed
- **Labels**: Tag subscriptions (e.g. "work", "personal")

## Quick start

```
/subs add              Pick a provider, add a subscription
/login                 Authenticate the new subscription
/subs switch           Manually switch to another subscription/provider
/subs limits           Check built-in quota support (Codex + Google)
/pool create           Group subs into a rotation pool (with strategy selection)
/pool chain create     Build an ordered fallback chain across pools
/mp-preset create         Create a named routing preset across providers
/mp-preset coding-premium Activate a preset by name
```

When one account hits a rate limit during an assistant turn, multi-pass automatically switches to the next eligible target and retries.

## Commands

### `/subs` -- Subscription management

```
/subs              Open menu
/subs add          Add a new subscription
/subs remove       Remove a subscription
/subs login        Login to a subscription
/subs logout       Logout from a subscription
/subs switch       Manually switch to a subscription/provider now
/subs list         List subscriptions with auth status; select one for quick actions
/subs status       Detailed status (token expiry, pool membership)
/subs limits       Check built-in quota/usage support (Codex + Google)
```

### `/pool` -- Rotation pool and chain management

```
/pool              Open menu
/pool create       Create a pool (pick provider, select members)
/pool list         Show pools; select one for quick actions
/pool chain        Open chain manager
/pool toggle       Enable/disable a pool
/pool remove       Delete a pool (keeps subscriptions; prunes linked chain entries)
/pool status       Member health (logged in, rate limited, cooling down)
/pool project      Project-level config (restrict subs, override pools/chains)
```

### `/pool chain` -- Ordered fallback chain management

```
/pool chain             Open chain manager
/pool chain create      Create a chain
/pool chain list        Show all chains
/pool chain toggle      Enable/disable a chain
/pool chain remove      Delete a chain
/pool chain status      Inspect chain entries and validity
```

### `/mp-preset` -- Model presets (named routing)

```
/mp-preset                 Open menu
/mp-preset activate        Switch to a preset's best available entry
/mp-preset <name>          Activate a preset by name directly
/mp-preset create          Create a new preset
/mp-preset list            Show all presets
/mp-preset toggle          Enable/disable a preset
/mp-preset remove          Delete a preset
```

## Project-level configuration

Use `/pool project` to configure per-project subscription affinity. This creates `.pi/multi-pass.json` in your project directory.

When `allowedSubs` is set, multi-pass now treats it as an exact allow-list for this project: active routing, pool membership, and chain traversal are all constrained to those provider names.

### Use case: separate work and personal accounts

```
# Global: you have 3 Codex accounts
/subs add   -> openai-codex-2 (label: work)
/subs add   -> openai-codex-3 (label: personal)

# Corp project: restrict to team accounts only
cd ~/work/corp-project
/pool project -> restrict -> select openai-codex-2 only

# Side project: allow everything (no restriction)
cd ~/side-project
# No .pi/multi-pass.json needed -- uses all global subs
```

### What project config can do

| Feature | Description |
|---|---|
| **Restrict subs** | Only allow specific provider names in this project (for example `openai-codex-2` or `openai-codex`) |
| **Override pools** | Use different pools than global (or disable some) |
| **Override chains** | Use different fallback chains than global |
| **Clear** | Remove project config, fall back to global |
| **Info** | Show effective config (which pools/chains/subs are active) |

### Project config file

`.pi/multi-pass.json`:

```json
{
  "allowedSubs": ["openai-codex-2", "anthropic-2"],
  "pools": [
    {
      "name": "work-codex",
      "baseProvider": "openai-codex",
      "members": ["openai-codex-2"],
      "enabled": true
    }
  ],
  "chains": [
    {
      "name": "work-fallback",
      "enabled": true,
      "entries": [
        { "pool": "work-codex", "model": "gpt-5-mini", "enabled": true }
      ]
    }
  ]
}
```

- `allowedSubs`: whitelist of exact provider names. If set, only those exact providers are available in this project. Omit to allow all.
- `pools`: if set, replaces global pools for this project. Omit to inherit global pools.
- `chains`: if set, replaces global chains for this project. Omit to inherit global chains.

## How pools work

1. You're using `openai-codex` and hit a rate limit
2. Multi-pass detects the error, marks `openai-codex` as exhausted
3. Switches to `openai-codex-2` (same model ID, different account)
4. Retries your last prompt automatically
5. After a 5-minute cooldown, `openai-codex` becomes available again

### Pool selection strategy

Each pool has a `strategy` that controls how the next member is chosen on failover:

| Strategy | Behavior |
|---|---|
| `round-robin` | Rotate sequentially through members (default) |
| `quota-first` | Query built-in quota checkers and prefer the member with the most remaining quota |
| `scheduled` | Use per-member time windows and priority roles |
| `custom` | Delegate to a user-provided JS selector script |

Set the strategy during pool creation (`/pool create`) or change it later via `/pool list` -> select pool -> `strategy`.

All strategies fall back to round-robin when their specific data is unavailable.

#### `quota-first`

You have 3 Codex accounts in a pool. Account A has 80% of its 5-hour window left, account B has 20%, account C has 60%. On failover, `quota-first` picks account A first instead of just the next one in rotation order.

Uses the same built-in quota checkers as `/subs limits` (currently Codex and Google providers).

```json
{
  "name": "codex-pool",
  "baseProvider": "openai-codex",
  "members": ["openai-codex", "openai-codex-2", "openai-codex-3"],
  "enabled": true,
  "strategy": "quota-first"
}
```

#### `scheduled`

Assign each member a role and optional time windows:

- **preferred**: only used during its active windows. When multiple preferred members are active, the one whose window ends soonest goes first (burn that quota before the window closes).
- **default** (no role): always available, used after preferred members.
- **overflow**: last resort, used when preferred and default members are exhausted.

```json
{
  "name": "codex-pool",
  "baseProvider": "openai-codex",
  "members": ["openai-codex", "openai-codex-2", "openai-codex-3"],
  "enabled": true,
  "strategy": "scheduled",
  "memberSchedule": {
    "openai-codex": {
      "role": "preferred",
      "windows": [{ "hours": [9, 17], "days": ["mon", "tue", "wed", "thu", "fri"] }]
    },
    "openai-codex-2": {
      "role": "preferred",
      "windows": [{ "hours": [17, 9] }]
    },
    "openai-codex-3": {
      "role": "overflow"
    }
  }
}
```

Window format:
- `hours`: `[start, end)` in 24h local time. Wraps midnight when start > end (e.g. `[22, 6]` = 22:00-05:59).
- `days`: array of `"mon"`, `"tue"`, ..., `"sun"`. Omit for every day.
- `dateRange`: `{ "from": "2025-06-01", "to": "2025-06-30" }` for temporary windows.

During pool creation or via the `strategy` quick action, you can configure schedules interactively with human-friendly input like `9-17 mon-fri`.

#### `custom`

Point to a JS script that decides which member to try first. The script receives full context and returns the preferred provider name (or an ordered array).

```json
{
  "name": "codex-pool",
  "baseProvider": "openai-codex",
  "members": ["openai-codex", "openai-codex-2", "openai-codex-3"],
  "enabled": true,
  "strategy": "custom",
  "selectorScript": "selectors/my-codex-selector.js"
}
```

Script paths are resolved relative to `~/.pi/agent/`. Absolute paths and `~/` paths also work.

**Selector script interface:**

```js
// ~/.pi/agent/selectors/my-codex-selector.js
module.exports = async function select(ctx) {
  // ctx.members:         string[]  -- available (non-exhausted, authenticated) members
  // ctx.currentProvider: string    -- the provider that just hit a rate limit
  // ctx.modelId:         string    -- the model ID being used
  // ctx.pool:            object    -- { name, baseProvider, members }
  // ctx.timestamp:       number    -- current Unix timestamp (ms)
  // ctx.hour:            number    -- current hour (0-23, local time)
  // ctx.day:             string    -- current day of week ("mon".."sun")
  // ctx.prompt:          string?   -- last user prompt, if available
  //
  // Return: string (provider name), string[] (ordered preference), or undefined (fall back)

  // Example: prefer a specific account during business hours
  if (ctx.hour >= 9 && ctx.hour < 17) {
    return ctx.members.find(m => m === "openai-codex-2");
  }
  return ctx.members[0];
};
```

If the script throws, returns an invalid provider name, or the file is missing, the pool falls back to round-robin.

## How chains work

1. You define an ordered chain of pool/model entries (for example `primary -> backup -> solo`)
2. If the current pool has no eligible members, multi-pass continues forward in the chain
3. It skips disabled or invalid entries and reports why in warnings
4. During retry replays for the same prompt, it preserves cascade state and avoids re-trying already attempted providers
5. Session status shows the active chain start entry: `chain:<name> | starts <pool> -> <model>`

## Model presets

Presets are named routing shortcuts that map to an ordered list of provider+model entries across different providers. Think of them as intent-based routing: `coding-premium`, `coding-budget`, `fastest`, etc.

### Commands

```
/mp-preset              Open menu
/mp-preset activate     Switch to a preset's best available entry
/mp-preset <name>       Activate a preset by name directly
/mp-preset create       Create a new preset
/mp-preset list         Show all presets
/mp-preset toggle       Enable/disable a preset
/mp-preset remove       Delete a preset
```

### Example

```
/mp-preset create
  Name: coding-premium
  Entries:
    1. anthropic / claude-sonnet-4-20250514
    2. openai-codex / o3
    3. google-gemini-cli / gemini-2.5-pro

/mp-preset coding-premium
  -> Tries anthropic first. If not logged in, tries openai-codex. Then gemini.
```

### Config

Presets are stored in `~/.pi/agent/multi-pass.json`:

```json
{
  "presets": [
    {
      "name": "coding-premium",
      "enabled": true,
      "entries": [
        { "provider": "anthropic", "model": "claude-sonnet-4-20250514", "enabled": true },
        { "provider": "openai-codex", "model": "o3", "enabled": true },
        { "provider": "google-gemini-cli", "model": "gemini-2.5-pro", "enabled": true }
      ]
    },
    {
      "name": "coding-budget",
      "enabled": true,
      "entries": [
        { "provider": "openai-codex", "model": "gpt-4.1-mini", "enabled": true },
        { "provider": "google-gemini-cli", "model": "gemini-2.5-flash", "enabled": true }
      ]
    }
  ]
}
```

Presets work with pools: if an entry's provider belongs to a pool, rate-limit failover still rotates within that pool before trying the next preset entry.

## Leeloo -- OpenAI-compatible proxy

Leeloo is a standalone local proxy that exposes all of multi-pass's routing intelligence as a standard OpenAI-compatible API. Point any tool, editor, or script at it and get automatic pool rotation, chain failover, preset routing, and quota-aware selection -- no pi integration required.

### Quick start

```bash
# Run directly (installs deps automatically)
npx pi-multi-pass

# Or with a custom port
npx pi-multi-pass --port 8080

# Then point your tools at it
export OPENAI_BASE_URL=http://localhost:4000/v1
```

Open `http://localhost:4000/ui` for the built-in chat UI with streaming markdown, model/pool/preset picker, and live quota dashboard.

### Endpoints

| Endpoint | Description |
|---|---|
| `POST /v1/chat/completions` | Chat completions (streaming + non-streaming, tools, images) |
| `GET /v1/models` | List all available models + presets |
| `GET /v1/routing` | Models grouped by presets, pools, providers (used by chat UI) |
| `GET /v1/quota` | Detailed quota per provider (windows, reset times, model-level) |
| `GET /v1/stats` | Usage stats: per-provider aggregates + recent request log |
| `GET /health` | Provider status, pools, chains, presets, exhausted state |
| `GET /ui` | Chat UI |

### How routing works

The `model` field in a chat completion request can be:

| Format | Example | Behavior |
|---|---|---|
| Preset name | `coding-premium` | Tries preset entries in order. If an entry's provider is in a pool, all pool members are tried (with strategy) before moving to the next entry. |
| Pool + model | `pool:codex-pool/gpt-5.1` | Routes through the pool's members using its strategy (quota-first, scheduled, custom, round-robin). |
| Pool only | `pool:codex-pool` | Same as above, auto-picks the default model for the pool's base provider. |
| Provider + model | `provider:anthropic/claude-sonnet-4-20250514` | Routes to that specific provider. |
| Raw model ID | `claude-sonnet-4-20250514` | Finds any provider that serves this model, prefers pool members. |

### Failover

On rate limit errors, Leeloo automatically:

1. Marks the provider as exhausted (5-minute cooldown, same as the extension)
2. Tries the next candidate in the ordered list (up to 5 attempts)
3. Pool strategies (quota-first, scheduled, custom) are applied when ordering candidates
4. Chain entries are traversed in order, each chain pool's strategy is applied
5. Preset entries expand to full pool membership before trying the next preset entry

### Pool strategy support

All four strategies work in the proxy, same as the extension:

| Strategy | Proxy behavior |
|---|---|
| `round-robin` | Sequential pool member order |
| `quota-first` | Queries Codex usage API (5h/7d windows) and Google quota APIs, sorts by remaining headroom |
| `scheduled` | Evaluates time windows, roles (preferred/default/overflow), shortest-remaining-first |
| `custom` | Loads and runs JS selector scripts with same `PoolSelectorContext` interface |

### Quota endpoints

`GET /v1/quota` returns detailed per-provider quota data:

```json
{
  "providers": [
    {
      "provider": "openai-codex",
      "label": "ChatGPT Plus/Pro (Codex)",
      "score": 85,
      "status": "ready",
      "plan": "plus",
      "email": "user@example.com",
      "windows": [
        { "name": "5-hour", "used": 15, "remaining": 85, "resetAt": "2025-06-01T14:00:00Z" },
        { "name": "7-day", "used": 5, "remaining": 95, "resetAt": "2025-06-07T09:00:00Z" }
      ]
    },
    {
      "provider": "google-gemini-cli",
      "label": "Google Cloud Code Assist",
      "score": 100,
      "status": "ready",
      "models": [
        { "model": "Pro", "remaining": 100, "resetAt": "2025-06-01T12:00:00Z" },
        { "model": "Flash", "remaining": 100, "resetAt": "2025-06-01T12:00:00Z" }
      ]
    }
  ]
}
```

`GET /v1/stats` returns usage tracking:

```json
{
  "session": {
    "total_requests": 42,
    "total_tokens_in": 12500,
    "total_tokens_out": 8300,
    "total_errors": 1
  },
  "providers": [
    { "provider": "anthropic", "label": "Anthropic (Claude Pro/Max)", "requests": 30, "tokens_in": 9000, "tokens_out": 6000, "errors": 0, "last_used": "..." }
  ],
  "recent": [
    { "timestamp": "...", "provider": "anthropic", "model": "claude-sonnet-4-20250514", "tokens_in": 300, "tokens_out": 200, "duration_ms": 1200, "error": null }
  ]
}
```

### Chat UI

The built-in chat UI at `/ui` includes:

- **Model picker**: grouped by Presets, Pools (with strategy labels), and Providers
- **Streaming markdown**: live rendering via [streaming-markdown](https://github.com/thetarnav/streaming-markdown)
- **Thinking indicator**: animated spinner while waiting for first token
- **Response footer**: shows preset/pool name, actual provider label, model ID, token counts, response time
- **Config strip**: always-visible top bar showing pools (with strategy), presets, and per-provider quota bars with color coding (green >50%, yellow 20-50%, red <20%)
- **Quota auto-refresh**: bars update after each response

### Response metadata

Chat completion responses include extra fields showing the actual routing:

```json
{
  "x_provider": "openai-codex",
  "x_model": "gpt-5.1",
  "x_label": "ChatGPT Plus/Pro (Codex)"
}
```

For streaming, these fields appear in the final chunk (alongside `usage`).

## Supported providers

| Provider key | Service |
|---|---|
| `anthropic` | Claude Pro/Max |
| `openai-codex` | ChatGPT Plus/Pro (Codex) |
| `github-copilot` | GitHub Copilot |
| `google-gemini-cli` | Google Cloud Code Assist |
| `google-antigravity` | Antigravity |

## Built-in limits support

`/subs limits` uses a provider-specific checker registry.

Currently implemented:

- `openai-codex`: fetches ChatGPT/Codex usage from `https://chatgpt.com/backend-api/wham/usage` (or `CHATGPT_BASE_URL`), then summarizes the 5-hour and 7-day subscription windows for the base account and any configured extra Codex subscriptions.
- `google-gemini-cli`: refreshes the saved Google OAuth session when needed, then queries `https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` and summarizes the returned Gemini quota buckets by their bottleneck family (for example `Pro` or `Flash`).
- `google-antigravity`: refreshes the saved Antigravity OAuth session when needed, then queries `v1internal:fetchAvailableModels` on the Google Cloud Code Assist endpoints with Antigravity-style headers and summarizes the returned model-level bottleneck.

Google quota is not a single flat subscription bucket, so the details view shows one line per returned Gemini family or Antigravity model with its remaining headroom and reset time.

`/subs limits` is an on-demand snapshot. It helps you see which account looks healthiest right now. Automatic switching still happens when the active provider returns a rate-limit-style runtime error and that provider belongs to an enabled pool or chain.

When a pool uses the `quota-first` strategy, the same quota checkers are used automatically during failover to pick the healthiest member instead of just round-robin.

When a project defines `.pi/multi-pass.json` with `allowedSubs`, `/subs limits` only shows accounts allowed in that project.

Future providers can add another checker without changing the `/subs` command surface.

## Environment variable (optional)

```bash
export MULTI_SUB="openai-codex:2,anthropic:1"
```

Env entries merge with saved config.

## Config files

| File | Scope | Contains |
|---|---|---|
| `~/.pi/agent/multi-pass.json` | Global | Subscriptions + pools + chains + presets |
| `~/.pi/agent/auth.json` | Global | OAuth credentials (used by extension + Leeloo) |
| `.pi/multi-pass.json` | Project | Pool/chain overrides + sub restrictions |

## License

MIT
