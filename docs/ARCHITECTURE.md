# Architecture

`pi-multi-account` is currently a compatibility-stabilized fork with one runtime extension entrypoint:

- `extensions/multi-sub.ts`

The current entrypoint still contains several responsibilities that should be split as the project is rewritten.

## Stable concepts

### Provider template

A provider template describes how to clone a built-in pi provider for an additional OAuth account. It includes:

- display name
- built-in OAuth provider
- OAuth login and refresh wiring
- optional model modification hooks

### Subscription entry

A subscription entry is persisted configuration:

```ts
interface SubEntry {
  provider: string;
  index: number;
  label?: string;
}
```

The stable internal provider id is `${provider}-${index}`, for example `anthropic-2` or `openai-codex-2`.
Friendly labels are display-only and must not replace internal ids in config, auth storage, pools, or presets.

### Pool

A pool groups provider ids for failover. Pool strategies decide the candidate order:

- `round-robin`
- `quota-first`
- `scheduled`
- `custom`

### Project restrictions

Project config may restrict which provider ids are available. Restriction filtering must happen before pool, chain, and switch UI decisions.

## Target module layout

The rewrite should split the monolith into these modules:

```text
extensions/
  multi-account.ts          # pi extension entrypoint only
  lib/
    providers.ts            # provider templates and model cloning
    config.ts               # global/project/env config loading and saving
    display.ts              # friendly names and safe UI labels
    quota.ts                # quota probes and summaries
    pools.ts                # PoolManager and strategy selection
    failover.ts             # failover plan/execution helpers
    commands/
      subs.ts               # /subs handlers
      pool.ts               # /pool handlers
      preset.ts             # /mp-preset handlers
    ui.ts                   # pi/GSD compatibility-safe UI wrappers
```

## Refactor rule

Every extracted module should first get a small regression test around the behavior being moved. Internal ids and persisted config shapes are compatibility boundaries.
