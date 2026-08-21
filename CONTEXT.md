# Context

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

Active skills should have names that include the runtime they bind to when a skill is tied to one. A skill that detects its own runtime takes the bare verb (`pair`), as does a runtime-independent one (`orchestrate`, `ship-it`, `debug-mode`).

The caller pane proof — which pane the calling agent runs in — belongs to `pair` (`scripts/caller-proof.mjs`, `references/caller-pane-resolution.md`). It is agent-kind agnostic and is the single caller-identity contract used by `pair`'s Herdr backend and `review-it`'s visible transport.

`pair`'s Herdr backend has an external runtime dependency on the `herdr` CLI and the separate `herdr` skill; its headless backend depends only on the chosen partner CLI (`claude`, `codex`,
`cursor-agent`, `grok`, or `opencode`). `orchestrate` records the selected pair
backend for each unit: Herdr is the default inside Herdr and headless is the
default outside it. Do not copy herdr primitives into this skill unless the upstream skill becomes unavailable; document the dependency instead.

The root `deprecated/` folder holds frozen, self-contained copies of removed skills. The Skills CLI scans the repo root at depth 1 and `skills/` at depth 3, so that root location is what keeps them invisible to `--skill '*'`; existing users install them from the `hcaiano/skills/deprecated` subpath.

When adding an active skill, place it directly under `skills/` and install or update the runtime copies through the Vercel Skills CLI.
