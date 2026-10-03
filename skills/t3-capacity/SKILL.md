---
name: t3-capacity
description: "Check live account usage, pace, and resets for T3 Code provider instances. Use before assigning agent work or after a usage limit."
---

# T3 capacity

Read Claude, each Codex account, Cursor's two pools, and Grok. The helper
reuses Pair's usage reader and adds Grok billing and T3 account mappings.
`pair` must be installed beside this skill. `$SKILL_DIR` is this directory.

## Read

Get instance IDs and driver kinds from `orchestrator_capabilities`. Run:

```bash
node "$SKILL_DIR/scripts/t3-capacity.mjs" \
  --settings <server-settings.json> \
  --instance <providerInstanceId>:<driverKind> [--instance ...] \
  [--auth-home <providerInstanceId>=<login-home>] \
  [--declare <providerInstanceId>=<claude|cursor|grok|codex:<name>>]
```

Pass all instances you want checked. Use the settings file of the T3 server
running this shell, confirmed from its process arguments or open state
database. If that cannot be confirmed, omit `--settings`; mappings stay
`unknown`.

Follow the helper's mapping notes. For a custom launcher, inspect it and pass
its actual login home as `--auth-home`; a shared history home proves no
account. Use `--declare` only for an account mapping the user has stated.
Keychain-backed logins may need that declaration.

## Interpret

`accounts` lists every pool read. `instances` ties T3 instances to proved
billing pools. `available` ranks available mapped pools by lower pace, then
lower usage. An unmapped instance is `unknown`, even if an account has room.

- `available`: has headroom.
- `protected`: `pace > 1`, so current spending would exhaust the pool before
  reset.
- `unavailable`: at least 90% of the main or burst window is used.
- `unknown`: usage is missing, failed, or stale, or the account mapping is
  unproved.

On Cursor, Grok, Composer, and Auto bill `cursor_models`; other models bill
`other_models`. Cursor-hosted models spend Cursor's quota. Grok's pace uses
an estimated period start, reported as `estimated_start`.

Report each account's usage percentage, pace, reset, state, and mapped T3
instances, including any alerts or missing mappings. Refresh before assigning
more work and after a usage limit. An actual rate-limit error overrides a
reading that claims headroom.
