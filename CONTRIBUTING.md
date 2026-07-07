# Contributing

This repository is a maintained fork of `hjanuschka/pi-multi-pass` for multi-subscription pi/GSD workflows.

## Development setup

No build step is currently required. The extension is loaded from `extensions/multi-sub.ts` by pi.

Run the regression suite before opening a PR:

```bash
npm test
```

The test runner executes every `tests/*.mjs` file in lexical order.

## Change guidelines

- Keep internal provider ids stable (`anthropic-2`, `openai-codex-2`, etc.). Friendly labels are display-only.
- Do not log OAuth tokens, credentials, account emails, or raw auth storage contents.
- Prefer small compatibility wrappers over importing unstable pi UI helpers directly.
- Add or update a regression test for pool selection, project restrictions, presets, labels, or failover behavior when changing those areas.
- Keep README examples generic; do not include private account labels, project names, or secrets.

## Release checklist

1. Run `npm test`.
2. Verify `/subs list`, `/subs switch`, `/subs login`, `/pool status`, and at least one pool failover path in pi/GSD.
3. Update `CHANGELOG.md`.
4. Tag the release only after the git install path has been manually smoke-tested.
