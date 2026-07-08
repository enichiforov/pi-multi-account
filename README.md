# pi-multi-account

Multi-account subscription switching for [pi](https://github.com/earendil-works/pi-coding-agent) and GSD.

`pi-multi-account` lets one pi/GSD installation use multiple OAuth accounts for the same provider, switch between them, and fail over across account pools when a provider hits quota or rate limits.

This project started as a maintained fork of [`hjanuschka/pi-multi-pass`](https://github.com/hjanuschka/pi-multi-pass) and is now maintained separately for current pi/GSD runtimes.

## Extension contract

| Field | Value |
|---|---|
| Extension id | `pi-multi-account` |
| Package type | pi extension package |
| Runtime | pi / GSD |
| Install path | `git:github.com/enichiforov/pi-multi-account` |
| Commands | `/subs`, `/pool`, `/pool chain`, `/mp-preset` |
| Auth model | pi OAuth/auth storage; no raw token logging |
| Provider ids | Stable internal ids such as `anthropic-2`, `openai-codex-2` |
| Labels | Display-only labels such as `Anthropic work`, `Codex personal` |

## Status

Production baseline is working:

- GitHub Actions CI passes on Node 20 and Node 22.
- `npm test` runs the regression suite.
- `/subs` runtime compatibility fixes are shipped in `v0.1.0`.
- Friendly account labels are supported without changing existing provider ids.
- Existing upstream-style config ids, pools, chains, presets, and project restrictions remain compatible.

Still being improved:

- The inherited extension implementation is currently a monolith in `extensions/multi-sub.ts`.
- A module rewrite plan is documented in [`docs/REWRITE-PLAN.md`](docs/REWRITE-PLAN.md).
- Full interactive runtime verification is tracked in [`docs/RUNTIME-VERIFICATION.md`](docs/RUNTIME-VERIFICATION.md).

## Install

Install directly from the maintained fork:

```bash
pi install git:github.com/enichiforov/pi-multi-account
```

Restart pi/GSD after installing or reinstalling so provider registration and command handlers reload.

If you previously installed upstream `pi-multi-pass`, reinstall from this fork and keep your existing config. Internal provider ids remain compatible.

## Quick start

```bash
# Add another account for a provider
/subs add

# Authenticate the new account through pi's login flow
/login

# Switch manually between authenticated accounts
/subs switch

# Create or manage failover pools
/pool

# Inspect pool state
/pool status
```

Typical result:

```text
Anthropic work       authenticated
Anthropic personal   authenticated
Codex team           authenticated
```

Internally those accounts still use stable ids such as:

```text
anthropic-2
anthropic-3
openai-codex-2
```

Use stable ids in config. Friendly labels are only for menus, model names, and notifications.

## Features

- **Multiple accounts per provider**: Register extra OAuth accounts for Anthropic, Codex, Copilot, Gemini, Antigravity, and other supported built-in provider templates.
- **Friendly labels**: Show `Anthropic work` instead of raw ids or `#2` names.
- **Manual switching**: Use `/subs switch` to move between authenticated accounts.
- **Failover pools**: Group accounts and fail over when the active account hits quota/rate-limit/provider errors.
- **Pool strategies**: `round-robin`, `quota-first`, `scheduled`, and `custom`.
- **Project restrictions**: Restrict which account ids a project can use.
- **Fallback chains**: Define ordered cross-pool fallback paths.
- **Model presets**: Create named routing shortcuts with `/mp-preset`.

## Commands

### `/subs`

Subscription/account management.

```bash
/subs                 # open interactive menu
/subs add             # add an extra account
/subs list            # list configured accounts
/subs switch          # switch to an authenticated account
/subs login           # show login guidance for an unauthenticated account
/subs logout          # log out an account
/subs remove          # remove an account
/subs limits          # inspect quota/usage where supported
```

### `/pool`

Pool and failover management.

```bash
/pool                 # open pool menu
/pool create          # create a pool
/pool list            # list pools
/pool status          # inspect active pool state
/pool toggle          # enable or disable a pool
/pool remove          # remove a pool
/pool project         # manage project-level restrictions
```

### `/pool chain`

Ordered fallback chains across pools.

```bash
/pool chain           # open chain menu
/pool chain create    # create a fallback chain
/pool chain list      # list chains
/pool chain status    # inspect chain state
/pool chain toggle    # enable or disable a chain
/pool chain remove    # remove a chain
```

### `/mp-preset`

Named routing shortcuts.

```bash
/mp-preset            # open preset menu
/mp-preset create     # create a preset
/mp-preset list       # list presets
/mp-preset activate   # activate a preset
/mp-preset remove     # remove a preset
```

## How failover works

Pool failover is not a per-request load balancer. It is a retry/failover mechanism.

A pool can fail over only when:

1. the active model provider is a member of an enabled pool;
2. the request fails with a quota/rate-limit/provider error recognized by the extension;
3. another pool member is authenticated and not temporarily exhausted;
4. the same model id can be resolved for the next provider.

Example pool:

```json
{
  "name": "claude",
  "enabled": true,
  "strategy": "round-robin",
  "members": ["anthropic-2", "anthropic-3"]
}
```

If the active model is on `anthropic-2` and it hits a rate limit, the extension tries `anthropic-3` next.

## Pool strategies

### `round-robin`

Try the next available member after the current provider.

Best for deterministic testing and simple account rotation.

### `quota-first`

Check provider-specific quota/usage where supported and prefer the account with the most available quota. Falls back to round-robin if quota data is unavailable.

Best for high-usage workflows where quota probes work reliably.

### `scheduled`

Prefer members during configured time windows.

Example:

```json
{
  "name": "codex-pool",
  "enabled": true,
  "strategy": "scheduled",
  "members": ["openai-codex-2", "openai-codex-3"],
  "memberSchedule": {
    "openai-codex-2": {
      "role": "preferred",
      "windows": [{ "hours": [9, 17], "days": ["mon", "tue", "wed", "thu", "fri"] }]
    },
    "openai-codex-3": {
      "role": "overflow"
    }
  }
}
```

### `custom`

Delegate selection to a local JavaScript selector script. Use this only when built-in strategies are not enough.

## Configuration

Global config is stored in the pi/GSD agent config directory as `multi-pass.json` for compatibility with upstream installs.

Subscription entries look like this:

```json
{
  "subscriptions": [
    { "provider": "anthropic", "index": 2, "label": "work" },
    { "provider": "anthropic", "index": 3, "label": "personal" },
    { "provider": "openai-codex", "index": 2, "label": "team" }
  ]
}
```

The extension turns those into stable provider ids:

```text
anthropic-2
anthropic-3
openai-codex-2
```

Do not replace provider ids with friendly labels in pools, chains, presets, or project restrictions.

## Project-level restrictions

Projects can restrict which account ids are available. This is useful when work and personal accounts must not mix.

Example project config:

```json
{
  "allowedSubs": ["anthropic-2", "openai-codex-2"]
}
```

When restrictions are active, switch menus, pool candidates, and fallback chains are filtered before use.

## Verification

Run the regression suite:

```bash
npm test
```

CI runs the same suite on Node 20 and Node 22.

Manual runtime smoke-test checklist:

```bash
/subs list
/subs switch
/subs login
/pool status
/mp-preset list
```

For failover tests, start from a model whose provider is a member of the target pool, then trigger a retryable provider/rate-limit error. See [`docs/RUNTIME-VERIFICATION.md`](docs/RUNTIME-VERIFICATION.md).

## Repository docs

- [Extension contract](docs/EXTENSION-CONTRACT.md)
- [Migration guide](docs/MIGRATION.md)
- [Runtime verification matrix](docs/RUNTIME-VERIFICATION.md)
- [Architecture notes](docs/ARCHITECTURE.md)
- [Production readiness plan](docs/PRODUCTION-READINESS.md)
- [Rewrite plan](docs/REWRITE-PLAN.md)
- [Release process](RELEASE.md)
- [Security policy](SECURITY.md)
- [Maintainers](MAINTAINERS.md)

## Development

```bash
npm ci
npm test
```

Current implementation entrypoint:

```text
extensions/multi-sub.ts
```

Target architecture is documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). New work should move behavior toward smaller tested modules rather than growing the monolith.

## Security

- Never log OAuth tokens, API keys, raw auth storage, or credential payloads.
- Friendly labels are not auth boundaries.
- Stable provider ids are not secrets.
- Keep real account labels and private project names out of committed examples.

See [`SECURITY.md`](SECURITY.md).

## License and attribution

MIT. See [`LICENSE`](LICENSE).

This project began as a fork of [`hjanuschka/pi-multi-pass`](https://github.com/hjanuschka/pi-multi-pass). Attribution is preserved in [`NOTICE.md`](NOTICE.md). Future releases are maintained independently as `pi-multi-account`.
