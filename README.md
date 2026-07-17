# Agent Workflow Skills

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Agent skills maintained locally and shared across Claude, Codex, and other agent runtimes.

This repo keeps metadata at the root, distributable skills under `skills/`, and small local maintenance scripts under `scripts/`.

## Install

Three paths — pick by your runtime. Claude Code users should take the plugin.

### Option A — Claude Code plugin (recommended)

One install gets every active skill — no extra setup:

```text
/plugin marketplace add hcaiano/skills
/plugin install hcaiano@hcaiano
```

Restart, then verify the plugin is installed and current:

```bash
claude plugin list | grep hcaiano
```

If it's missing or behind, run `claude plugin update hcaiano` and restart the
session.

### Option B — Codex via skills CLI

```bash
npx skills@latest add hcaiano/skills --global --agent codex --copy --yes
```

This installs a stable copied snapshot rather than linking the development
checkout. Codex reads the manual-invocation policy from each skill's
`agents/openai.yaml`; model selection remains in `~/.codex/config.toml`.

### Option C — skills.sh CLI (other agent runtimes)

```bash
npx skills@latest add hcaiano/skills
```

The CLI scans this repo, prompts which skills + which agent runtimes (Claude,
Codex, etc.) to install into, and copies them into the right local skill
directories.

## Skills

### Collaboration

- `ask-peer` — manually ask the opposite primary model for one focused review, second opinion, or scoped work pass: Codex → Fable through `claude -p`, Claude → Codex through `codex exec`.
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

The Claude plugin manifest intentionally lists only active skills; `_deprecated/*`
is kept for history and recovery, not normal installs.
`.claude-plugin/marketplace.json` registers the repo as the single-plugin
`hcaiano` marketplace. Both supported install paths — the Claude
plugin and `npx skills@latest add hcaiano/skills` for Codex or other runtimes —
pick up the same active set.

Claude Code always scans the root `skills/` directory for plugin skills, so any
skill kept directly under `skills/` must be active and listed in the Claude
manifest. Move non-shipping skills under `_deprecated/` or out of the plugin
root.

## License

[MIT](./LICENSE) © Henrique Caiano.
