# Security Policy

## Supported versions

Security fixes target the default branch of `enichiforov/pi-multi-account`.

## Reporting a vulnerability

Please open a private GitHub security advisory or contact the maintainer through GitHub if a vulnerability could expose OAuth credentials, account metadata, or provider tokens.

Do not include secrets in public issues, pull requests, logs, screenshots, or reproduction artifacts.

## Security expectations

- OAuth tokens and auth storage contents must never be logged.
- Account labels are display metadata only; they must not be treated as credentials or authorization signals.
- Provider ids such as `anthropic-2` and `openai-codex-2` are stable internal identifiers, not secrets.
- Test fixtures should use fake provider/account data only.
