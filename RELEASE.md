# Release Process

## Before tagging

1. Ensure `main` is clean and tracks `enichiforov/main`.
2. Run:

   ```bash
   npm ci
   npm test
   ```

3. Smoke-test the git install path in pi/GSD:

   ```bash
   pi install git:github.com/enichiforov/pi-multi-account
   ```

4. Verify these commands in an interactive pi/GSD session:
   - `/subs list`
   - `/subs switch`
   - `/subs login`
   - `/pool status`
   - at least one failover path from a pool member to another pool member

5. Update `CHANGELOG.md`.

## Tagging

Use annotated tags:

```bash
git tag -a v0.1.0 -m "Release v0.1.0"
git push enichiforov main --follow-tags
```

## GitHub release notes

Release notes should include:

- Compatibility fixes
- User-visible command/menu changes
- Migration notes for users moving from `pi-multi-pass`
- Verification commands and smoke-test results
