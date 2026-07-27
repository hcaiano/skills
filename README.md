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

`art-director` composes external skills instead of vendoring them:

- **Required:** `imagegen` for visual concepts.
- **Conditional:** `brandkit` for identity-system proof and `herdr-pair` only
  when the current runtime needs a Codex peer to generate images.

None are bundled in this repo. The skill owns the exploration and curation
workflow while those dependencies own their specialist work.

### Engineering

- `debug-mode` — hypothesis-driven debugging with runtime evidence.

### Workflow

- `art-director` — explore distinct visual premises with `imagegen`, curate
  them with the user, refine the winner, and use `brandkit` when an identity
  direction needs system proof.
- `review-pr-comments` — fetch, triage, fix, reply to, and recheck PR review comments.
- `ship-it` — commit, push, open/update a PR, then invoke `review-pr-comments`.

## Development

List active skills:

```bash
./scripts/list-skills.sh
```

## Publishing

Active skills live directly under `skills/`. Publish and update them through
the Vercel Skills CLI command above; Git history preserves removed skills.

## License

[MIT](./LICENSE) © Henrique Caiano.
