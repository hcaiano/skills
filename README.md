# hcaiano skills

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Personal agent skills that are maintained locally and shared across Claude, Codex, and other agent runtimes.

This repo keeps metadata at the root, distributable skills under `skills/`, and small local maintenance scripts under `scripts/`.

## Install (recommended)

Use the [skills.sh](https://skills.sh) CLI from any directory:

```bash
npx skills@latest add hcaiano/skills
```

The CLI scans this repo, prompts which skills + which agent runtimes (Claude, Codex, etc.) to install into, and copies them into the right local skill directories. No marketplace, no global config — just an `npx` away.

## Skills

### Collaboration

- `agents-pair` — pair Codex in the Codex app with Claude through the Claude Code CLI.
- `herdr-pair` — pair Claude and Codex as collaborating peer agents inside herdr.

`herdr-pair` depends on the `herdr` CLI and the separate `herdr` skill for pane primitives. This repo intentionally does not vendor that upstream skill; install it separately before sharing `herdr-pair` with teammates.
`agents-pair` depends on the local Claude Code CLI (`claude`) being installed and authenticated.

### Engineering

- `debug-mode` — hypothesis-driven debugging with runtime evidence.

### Workflow

- `review-pr-comments` — fetch, triage, fix, reply to, and recheck PR review comments.
- `ship-it` — commit, push, open/update PRs, and keep checking CI/review feedback.

### Deprecated

- `cmux-pair` — older cmux-based Claude/Codex pair programming bootstrap, preserved for reference but not installed by default. Superseded by `herdr-pair`.

## Local linking (development)

For working on the skills themselves, link them into local agent skill directories so edits in the repo are live for installed runtimes.

List active bundled skills:

```bash
./scripts/list-skills.sh
```

Link them into `~/.agents/skills`, `~/.claude/skills`, and `~/.codex/skills`:

```bash
./scripts/link-skills.sh
```

By default, the linker skips deprecated skills and any existing non-symlink skill directory. To include deprecated skills:

```bash
./scripts/link-skills.sh --include-deprecated
```

To migrate an existing real directory to a symlink after confirming the repo copy is correct:

```bash
./scripts/link-skills.sh --replace
```

`--replace` uses `trash`, not `rm`, for existing non-symlink directories.

## Publishing

The plugin manifests (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`) intentionally list only active skills; `skills/_deprecated/*` is kept for history and recovery, not normal installs. Either install path — `npx skills@latest add hcaiano/skills` or a Claude Code plugin install from the GitHub remote — picks up the same active set.

## License

[MIT](./LICENSE) © Henrique Caiano.
