# Contributing

Thanks for improving `pi-multi-account`.

This is a pi/GSD extension for multi-account subscription switching and failover. It started as a fork of `hjanuschka/pi-multi-pass`, but new development happens in this repository as a separately maintained project.

## Local setup

```bash
git clone https://github.com/enichiforov/pi-multi-account.git
cd pi-multi-account
npm ci
npm test
```

No build step is currently required. pi loads the extension from `extensions/multi-sub.ts`.

## Pull request checklist

Before opening a PR:

- [ ] Run `npm test`.
- [ ] Update README or docs for user-visible behavior changes.
- [ ] Update `CHANGELOG.md` for fixes/features.
- [ ] Add or update tests for pool selection, project restrictions, presets, labels, or failover behavior.
- [ ] Confirm no secrets, tokens, private account labels, or auth storage payloads are logged or committed.

## Compatibility rules

These are project contracts:

- Internal provider ids are stable: `anthropic-2`, `openai-codex-2`, etc.
- Friendly labels are display-only and must not replace provider ids in config.
- Existing global config shape remains readable.
- Existing project restrictions, pools, chains, and presets should continue to work.
- OAuth/API credentials must stay in pi auth storage, environment variables, or user-local config — never in examples or tests.

## Architecture direction

The current extension entrypoint is still a monolith. New changes should move toward the documented module split rather than adding more unrelated logic to `extensions/multi-sub.ts`.

Start with pure modules when possible:

1. provider id parsing/building
2. friendly display labels
3. pool strategy ordering
4. project restriction filtering
5. preset formatting

See:

- `docs/ARCHITECTURE.md`
- `docs/PRODUCTION-READINESS.md`
- `docs/REWRITE-PLAN.md`

## Runtime behavior changes

If a PR changes command/runtime behavior, include manual smoke-test evidence for the affected commands:

- `/subs list`
- `/subs switch`
- `/subs login`
- `/pool status`
- `/mp-preset list`

For pool/failover changes, state whether the test used `round-robin`, `quota-first`, `scheduled`, or `custom` strategy.

## Release checklist

1. Run `npm ci && npm test`.
2. Verify GitHub Actions is green on `main`.
3. Smoke-test the git install path:

   ```bash
   pi install git:github.com/enichiforov/pi-multi-account
   ```

4. Update `CHANGELOG.md`.
5. Tag with an annotated tag.
6. Publish GitHub release notes from `docs/RELEASE-NOTES-*.md`.
