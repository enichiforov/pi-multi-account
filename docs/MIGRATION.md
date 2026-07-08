# Migration from pi-multi-pass

`pi-multi-account` is a maintained fork of `hjanuschka/pi-multi-pass` focused on current pi/GSD compatibility and multi-account subscription workflows.

## Install the maintained fork

```bash
pi install git:github.com/enichiforov/pi-multi-account
```

Restart pi/GSD after reinstalling so provider registration and command handlers reload.

## Config compatibility

Existing subscription entries, pools, chains, presets, and project restrictions should continue to work because internal provider ids are unchanged.

Examples of stable ids:

- `anthropic-2`
- `anthropic-3`
- `openai-codex-2`

Friendly labels changed only the menu/model display text. They do not change config ids.

## Smoke test after migration

Run these commands in pi/GSD:

- `/subs list`
- `/subs switch`
- `/pool status`
- `/mp-preset list` if presets are configured

For pool failover, start from a model whose provider is a member of the pool. Pool failover is triggered by rate-limit/error handling, not by every normal request.
