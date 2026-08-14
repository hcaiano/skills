# Context

This repository is the source of truth for Henrique's custom agent workflow skills.

Installed third-party skills should stay managed by their upstream sources and lock files. Custom skills in this repo may be linked into:

- `~/.agents/skills`
- `~/.claude/skills`
- `~/.codex/skills`

Active skills should have names that include the runtime they bind to when a skill is tied to one (`herdr-orchestrate`). A skill that detects its own runtime takes the bare verb (`pair`), as does a runtime-independent one (`ship-it`, `debug-mode`).

`pair`'s Herdr backend has an external runtime dependency on the `herdr` CLI and the separate `herdr` skill; its headless backend depends only on the partner CLI (`codex` or `claude`). Do not copy herdr primitives into this skill unless the upstream skill becomes unavailable; document the dependency instead.

The root `deprecated/` folder holds frozen, self-contained copies of removed skills. The Skills CLI scans the repo root at depth 1 and `skills/` at depth 3, so that root location is what keeps them invisible to `--skill '*'`; existing users install them from the `hcaiano/skills/deprecated` subpath.

When adding an active skill, place it directly under `skills/` and install or update the runtime copies through the Vercel Skills CLI.
