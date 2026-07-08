# pi-multi-account v0.1.0

First maintained fork release.

## Highlights

- Renamed project to `pi-multi-account` to reflect the core purpose: multiple accounts/subscriptions for the same provider.
- Preserved compatibility with upstream `pi-multi-pass` config ids and pool member names.
- Fixed runtime compatibility issues with current pi/GSD builds by avoiding unstable UI helper imports.
- Improved menu/model display names for labeled subscriptions.
- Added regression test runner and GitHub Actions CI.
- Added maintainer, security, release, architecture, rewrite, and migration docs.

## Install

```bash
pi install git:github.com/enichiforov/pi-multi-account
```

Restart pi/GSD after install.

## Verification

```bash
npm ci
npm test
```

Manual smoke test checklist:

- `/subs list`
- `/subs switch`
- `/subs login`
- `/pool status`
- pool failover from one authenticated pool member to another
