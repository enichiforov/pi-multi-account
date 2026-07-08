# Production Readiness Plan

`pi-multi-account` has a working compatibility baseline, but its inherited architecture is not production-ready yet. The main risk is the 5k+ line monolithic extension file.

## Current state

Strengths:

- Public maintained repo exists.
- `main` has CI on Node 20 and 22.
- Runtime compatibility fixes are shipped in `v0.1.0`.
- Existing config ids remain stable.
- Docs now state migration, release, security, and rewrite boundaries.

Weaknesses:

- `extensions/multi-sub.ts` mixes provider templates, config I/O, quota fetching, pool state, failover, command UI, presets, and extension registration.
- Tests currently duplicate some production logic instead of importing small pure modules.
- Runtime behavior is only partially smoke-tested interactively.
- There is no typed public config schema module.
- Future API-key provider adapters do not yet have a clean extension point.

## Target architecture

```text
extensions/
  multi-account.ts          # thin pi extension entrypoint
  multi-sub.ts              # temporary compatibility entrypoint, imports multi-account.ts
  lib/
    types.ts                # public config/runtime types
    provider-ids.ts         # stable id parsing/building
    display.ts              # friendly labels
    config.ts               # global/project/env config loading and saving
    providers/
      templates.ts          # built-in OAuth account cloning templates
      api-key.ts            # future API-key provider adapters
      registry.ts           # provider registration orchestration
    models.ts               # model cloning and overrides
    quota.ts                # quota probes and summaries
    pools/
      manager.ts            # PoolManager state and candidate planning
      strategies.ts         # round-robin, quota-first, scheduled, custom
    failover.ts             # failover execution/cascade
    commands/
      subs.ts
      pool.ts
      preset.ts
    ui.ts                   # pi/GSD-compatible UI wrappers
```

## Refactor sequence

### Phase 1: Extract pure helpers

Low-risk modules with no pi runtime imports:

1. `provider-ids.ts`
2. `display.ts`
3. `pool-strategies.ts`
4. `project-restrictions.ts`
5. `preset-format.ts`

Each extraction must include tests that import the new module directly.

### Phase 2: Extract config and schemas

- Move config interfaces into `types.ts`.
- Add runtime validation for global/project config.
- Preserve existing config path and shape.
- Add fixtures for config migration and backwards compatibility.

### Phase 3: Extract PoolManager

- Move pool state and candidate planning into `lib/pools/manager.ts`.
- Keep failover execution separate from candidate planning.
- Add tests for exhausted/cooldown behavior and auth filtering.

### Phase 4: Runtime adapters

- Introduce adapters for:
  - model registry
  - auth storage
  - pi command registration
  - UI select/input/confirm
- This makes command handlers testable without an interactive pi session.

### Phase 5: Provider adapter framework

- Add a provider adapter interface for built-in OAuth cloning and API-key providers.
- Keep built-in OAuth provider cloning and future API-key provider registration separate.

## Production readiness gates

Before claiming production-ready:

- `npm test` imports production modules rather than duplicated logic.
- CI passes on Node 20 and 22.
- Manual runtime matrix in `docs/RUNTIME-VERIFICATION.md` is completed for at least two authenticated accounts.
- Any future API-key provider adapter is tested with mock key resolution and manually smoke-tested with a low-risk model.
- No command logs tokens, OAuth payloads, raw auth storage, or secret env values.
