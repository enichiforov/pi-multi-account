# Changelog

All notable changes to this project are documented here.

## Unreleased

### Documentation

- Rewrote README around the pi/GSD extension contract, command surface, config contract, verification, and maintainer workflow.
- Added `docs/EXTENSION-CONTRACT.md`.
- Clarified the public extension contract and current supported command/config surface.

## 0.1.0 - 2026-07-07

First maintained `pi-multi-account` release.

### Fixed

- Removed runtime dependency on pi UI helpers that are not stable across pi/GSD builds (`keyHint`, `DynamicBorder`, `BorderedLoader`).
- Improved subscription display names so menus show friendly provider/account labels such as `Anthropic work` and `Codex personal` while preserving internal provider ids like `anthropic-3`.

### Repository

- Renamed the maintained fork to `pi-multi-account`.
- Added public-repository metadata, contribution notes, license file, gitignore, and a Node-based test runner.
- Added GitHub Actions CI for Node 20 and 22.
- Added maintainer, security, release, architecture, rewrite-plan, migration, and release-note docs.

## Unreleased

### Planned

- Split the inherited monolithic extension into provider, config, pool, failover, command, and UI modules.
- Expand pure regression tests before moving runtime code.
