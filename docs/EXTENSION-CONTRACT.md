# Extension Contract

`pi-multi-account` is a community pi/GSD extension package.

## Manifest-style summary

```json
{
  "id": "pi-multi-account",
  "name": "Pi Multi Account",
  "version": "0.1.0",
  "description": "Multi-account subscription switching and failover for pi/GSD",
  "tier": "community",
  "provides": {
    "commands": ["subs", "pool", "pool chain", "mp-preset"],
    "dynamicProviders": true,
    "providerIds": ["anthropic-N", "openai-codex-N", "github-copilot-N", "gemini-cli-N", "antigravity-N"]
  }
}
```

The runtime package declaration lives in `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions"]
  }
}
```

## Command surface

| Command | Purpose |
|---|---|
| `/subs` | Add, list, rename, login, logout, remove, inspect, and switch subscription accounts |
| `/pool` | Create, list, toggle, remove, and inspect failover pools |
| `/pool chain` | Create and manage ordered fallback chains across pools |
| `/mp-preset` | Create and activate named provider/model routing presets |

## Runtime integration points

The extension uses pi/GSD runtime APIs for:

- command registration
- dynamic provider registration
- model registry refresh
- auth storage checks/logout
- interactive UI select/input/confirm/notify surfaces
- model switching
- agent-event failover retry handling

## Compatibility boundaries

The extension must preserve:

- stable provider ids (`anthropic-2`, `openai-codex-2`)
- existing config file shape
- existing pool member id shape
- existing project restriction id shape
- no-secret logging behavior

The extension may change:

- friendly display labels
- command menu layout
- docs/examples
- internal module layout
- tests and CI

## Verification contract

Automated:

```bash
npm test
```

Manual runtime smoke tests:

- `/subs list`
- `/subs switch`
- `/subs login`
- `/pool status`
- `/mp-preset list`
- one pool failover path from an authenticated pool member to another

See `docs/RUNTIME-VERIFICATION.md` for the complete matrix.
