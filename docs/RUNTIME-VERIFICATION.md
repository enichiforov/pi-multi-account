# Runtime Verification Matrix

This document separates what is already verified from what still needs a real pi/GSD runtime smoke test.

## Verified so far

Automated checks:

- `npm test` passes locally.
- GitHub Actions CI passed on Node 20.x and 22.x for `main`.
- Regression scripts cover:
  - pool editing
  - project-aware limits
  - project restrictions
  - runtime failover planning
  - subscription switching helpers
  - subscription limits

Manual signal:

- `/subs` no longer crashes after removing unstable pi UI helper imports.
- Friendly subscription labels render in the interactive session.

## Not fully verified yet

These require an interactive pi/GSD session with real authenticated accounts:

| Area | Required smoke test | Expected result |
|---|---|---|
| Install path | `pi install git:github.com/enichiforov/pi-multi-account` then restart pi/GSD | Commands register without extension errors |
| Subscription list | `/subs list` | Shows friendly labels and auth status without exposing tokens |
| Manual switch | `/subs switch` across each authenticated account | Active model switches to selected provider id while preserving model id when possible |
| Login hint | `/subs login` for a not-logged-in entry | Points user to the friendly OAuth provider name |
| Pool status | `/pool status` | Shows enabled pools, strategy, members, and current auth availability |
| Round-robin failover | Pool strategy `round-robin`, start on pool member, trigger retryable provider error | Next non-exhausted authenticated member is selected |
| Quota-first failover | Pool strategy `quota-first`, quota probes available | Best quota member is preferred; fallback to round-robin if quota unavailable |
| Project restriction | `.pi/multi-pass.json` or project config restricts allowed subs | Switch/pool candidates are filtered before use |
| Presets | `/mp-preset list` and activation | Presets resolve provider ids, not friendly labels |

## Important behavior notes

- Pool failover is not a per-request round-robin load balancer. It is triggered by rate-limit/error handling.
- Failover only applies when the active model provider is a member of an enabled pool.
- Friendly labels are display-only. Config, auth storage, pools, chains, presets, and project restrictions must continue to use stable ids such as `anthropic-2`.

## Recommended next automated tests

1. Extract display/id helpers and test them directly.
2. Extract pool strategy ordering and test round-robin, quota-first fallback, scheduled, and custom strategy inputs.
3. Add fake runtime adapter tests for command handlers with a mock `modelRegistry`, `authStorage`, and `setModel`.
4. Add provider registration adapter tests when new API-key providers are introduced.
