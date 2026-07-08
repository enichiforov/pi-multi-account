# Rewrite Plan

Goal: replace the inherited monolithic extension with a maintainable multi-account framework while preserving user configuration compatibility.

## Non-negotiable compatibility boundaries

- Existing provider ids remain stable: `anthropic-2`, `openai-codex-2`, etc.
- Existing config file shape remains readable.
- Friendly labels remain display-only.
- OAuth token storage is never logged or migrated into public artifacts.
- `pi install git:github.com/enichiforov/pi-multi-account` remains the supported install path.

## Phase 1: Public foundation

- Add CI.
- Add maintainer/security/release docs.
- Publish first `v0.1.0` tag from the stabilized fork.

## Phase 2: Test harness expansion

- Add unit tests for display names and provider id parsing.
- Add tests for pool strategy ordering.
- Add tests for project restriction filtering.
- Add tests for failover candidate classification.

## Phase 3: Extract pure modules

Extract pure helpers first, with no pi runtime dependencies:

1. `display.ts`
2. `config-shapes.ts`
3. `pool-strategy.ts`
4. `project-restrictions.ts`
5. `failover-plan.ts`

## Phase 4: Extract runtime adapters

Move pi-specific code behind adapters:

- provider registration
- model cloning
- auth storage access
- UI select/input/confirm wrappers
- command registration

## Phase 5: Rewrite command surface

Rebuild `/subs`, `/pool`, and `/mp-preset` handlers around the new modules.

## Phase 6: Release 1.0 criteria

- Module split complete.
- CI green on Node 20 and 22.
- Manual pi/GSD smoke tests documented.
- Migration guide from upstream `pi-multi-pass` included.
