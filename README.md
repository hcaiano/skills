# Agent Workflow Skills

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Agent skills maintained locally and shared across Claude, Codex, and other agent runtimes.

This repo keeps metadata at the root, distributable skills under `skills/`, and small local maintenance scripts under `scripts/`.

## Install

```bash
npx skills@latest add hcaiano/skills --global --agent claude-code codex --skill '*' --yes
```

This installs every active skill directly for Claude Code and Codex. Skills keep
their names, without a plugin namespace such as `hcaiano:`.

Run the same command to update the installed copies after changing this repo.

## Skills

### Collaboration

- `ask-peer` — ask the opposite primary model for one focused review, second opinion, or scoped work pass: Codex → Fable through `claude -p`, Claude → Codex through `codex exec`. In Codex it can invoke automatically to escalate to Fable; in Claude Code it stays manual (user-invoked only).
- `herdr-pair` — pair Claude and Codex as collaborating peer agents inside herdr.

`herdr-pair` depends on the `herdr` CLI and the separate `herdr` skill for pane primitives. This repo intentionally does not vendor that upstream skill; install it separately before sharing `herdr-pair` with teammates.
`ask-peer` needs both local CLIs installed and authenticated. It explicitly selects Fable through `claude -p` but leaves the Codex model unset so Codex configuration owns it.

`art-director` composes several external skills instead of vendoring them; install the ones your run needs (it degrades gracefully when an optional one is absent):

- **Required:** `herdr-pair` (and thus the `herdr` CLI) for the live generator loop, `grill-me` for brief intake, and `imagegen-frontend-web` for website generation.
- **Conditional:** `imagegen-frontend-mobile` (app-screen surfaces), `impeccable` (taste/quality bar and the build handoff), `brandkit` (identity/system-proof boards), and `image-to-code` / `web-design-guidelines` (build handoff + audit).

None are bundled in this repo — `art-director` documents the dependency rather than copying their internals.

### Engineering

- `debug-mode` — hypothesis-driven debugging with runtime evidence.

### Workflow

- `art-director` — run a long design-exploration loop: you act as art director and Codex generates many mockups per batch; you curate, wipe its context, and redirect on a fresh axis until the gallery converges on a winning direction. Works for blank-slate (new/rebrand) and established-brand (creative-within-guardrails) projects. Composes `herdr-pair` (generator transport), `grill-me` (brief intake), `imagegen-frontend-web` (generation), and `impeccable` (taste + build handoff).
- `check-logs` — read an existing herdr/turbo dev TUI's app logs without starting or stopping servers.
- `goal-loop` — name one target and what "better" means; Claude and Codex keep improving that one thing with real testing until the goal's quality bar and the peer both pass. (Formerly `test-fix-loop`.)
- `review-pr-comments` — fetch, triage, fix, reply to, and recheck PR review comments.
- `ship-it` — commit, push, open/update a PR, then invoke `review-pr-comments`.

### Deprecated

- `cmux-pair` — older cmux-based Claude/Codex pair programming bootstrap, preserved for reference but not installed by default. Superseded by `herdr-pair`.

## Development

List active skills:

```bash
./scripts/list-skills.sh
```

## Publishing

Active skills live directly under `skills/`; `_deprecated/*` is kept for history
and recovery and is not part of normal installs. Publish and update them through
the Vercel Skills CLI command above.

## License

[MIT](./LICENSE) © Henrique Caiano.
