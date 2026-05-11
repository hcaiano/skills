# Context

This repository is the source of truth for Henrique's custom agent skills.

Installed third-party skills should stay managed by their upstream sources and lock files. Custom skills in this repo may be linked into:

- `~/.agents/skills`
- `~/.claude/skills`
- `~/.codex/skills`

Active skills should have names that include the runtime they bind to when ambiguity is likely. The current convention is `<runtime>-<verb>` for collaboration skills (`herdr-pair`, `cmux-pair`), and a short verb or noun otherwise (`ship-it`, `debug-mode`).

`herdr-pair` has an external runtime dependency on the `herdr` CLI and the separate `herdr` skill. Do not copy herdr primitives into this skill unless the upstream skill becomes unavailable; document the dependency instead.

Deprecated skills stay under `skills/_deprecated/` and should not be listed in plugin manifests or linked by default. Keep them in the repo for reference, migration, and recovery.

When adding an active skill, place it directly under `skills/`, update both plugin manifests, and keep the installed runtime copy as a symlink back to this repo when practical.
