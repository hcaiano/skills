# Agent Skills

This repository is the source of truth for Henrique's custom agent workflow skills.

Installed third-party skills should stay managed by their upstream sources and lock files. Custom skills in this repo may be linked into:

- `~/.agents/skills` — the one canonical copy every agent reads
- `~/.claude/skills`
- `~/.codex/skills`
- `~/.cursor/skills`
- `~/.grok/skills`

Each agent directory holds symlinks into `~/.agents/skills`, written by the
Skills CLI when the agent is named in `--agent`. Registering a new agent means
adding it to that flag, never hand-linking the directory.

A skill tied to one runtime carries that runtime in its name (`t3-capacity`); a runtime-independent skill takes a plain name (`test-audit`, `cyber-audit`).

The root `deprecated/` folder holds frozen, self-contained copies of removed skills. The Skills CLI scans the repo root at depth 1 and `skills/` at depth 3, so that root location is what keeps them invisible to `--skill '*'`; existing users install them from the `hcaiano/skills/deprecated` subpath.

When adding an active skill, place it directly under `skills/` and install or update the runtime copies through the Vercel Skills CLI.
