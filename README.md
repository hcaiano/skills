# Agent Workflow Skills

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Agent skills maintained locally and shared across Claude, Codex, and other agent runtimes.

This repo keeps metadata at the root, distributable skills under `skills/`, and small local maintenance scripts under `scripts/`.

## Install

Three paths — pick by your runtime. Claude Code users should take the plugin.

### Option A — Claude Code plugin (recommended)

One install gets every active skill **plus** `delegate`'s named subagent
roster (`hcaiano:codex-worker`, `hcaiano:deep-reasoner`, `hcaiano:fast-worker`,
`hcaiano:skeptic`) loaded automatically — no extra setup:

```text
/plugin marketplace add hcaiano/skills
/plugin install hcaiano@hcaiano
```

Restart, then verify — note that plugin agents do **not** appear in the
`/agents` screen or `claude plugin details` (both under-report); the ground
truth is the session's agent registry:

```bash
echo "Reply OK" | claude -p --output-format stream-json --verbose 2>/dev/null \
  | grep -o '"hcaiano:[a-z-]*"' | sort -u
```

Four roster names back (`hcaiano:codex-worker`, `hcaiano:deep-reasoner`,
`hcaiano:fast-worker`, `hcaiano:skeptic`) means the install worked. Empty →
check `claude plugin list` shows `hcaiano` at the current version
(`claude plugin update hcaiano` if not) and that you restarted the session.

### Option B — Codex via skills CLI

```bash
npx skills@latest add hcaiano/skills --global --agent codex --copy --yes
```

This installs a stable copied snapshot rather than linking the development
checkout. Codex reads each skill's invocation policy from its
`agents/openai.yaml` — manual by default, though some skills (`ask-peer`,
`debug-mode`, `cyber-audit`) opt into implicit invocation so Codex can reach
for them autonomously; model selection remains in `~/.codex/config.toml`.

### Option C — skills.sh CLI (other agent runtimes)

```bash
npx skills@latest add hcaiano/skills
```

The CLI scans this repo, prompts which skills + which agent runtimes (Claude,
Codex, etc.) to install into, and copies them into the right local skill
directories. This path installs **skills only** — for `delegate`'s named
roster, run the bundled script once afterwards:

```bash
bash ~/.claude/skills/delegate/scripts/setup-roster.sh
```

### delegate externals (once per machine)

`delegate` routes building and analysis to Codex, so it needs the Codex side
installed and authenticated:

```bash
npm i -g @openai/codex
codex login
```

Run your session on the top model at max effort (`/model`). Optional
companion skills (`tdd`, `planning-with-files`) and the full details live in
`skills/delegate/references/setup.md`.

## Skills

### Collaboration

- `ask-peer` — ask the opposite primary model for one focused review, second opinion, or scoped work pass: Codex → Fable through `claude -p`, Claude → Codex through `codex exec`. In Codex it can invoke automatically to escalate to Fable; in Claude Code it stays manual (user-invoked only).
- `herdr-pair` — pair Claude and Codex as collaborating peer agents inside herdr.
- `delegate` — run Fable as tech lead: plan and freeze specs, route building to Codex, deep reasoning to an Opus subagent, and taste-sensitive light work to Sonnet, then verify and synthesize — with a fresh-context Fable `skeptic` at commitment boundaries. Claude Code–hosted.

`herdr-pair` depends on the `herdr` CLI and the separate `herdr` skill for pane primitives. This repo intentionally does not vendor that upstream skill; install it separately before sharing `herdr-pair` with teammates.
`ask-peer` needs both local CLIs installed and authenticated. It explicitly selects Fable through `claude -p` but leaves the Codex model unset so Codex configuration owns it. `delegate` uses raw `codex exec` for its Codex lane; without Codex it degrades to Claude-only routing. It also references two companion skills it doesn't bundle — `tdd` (build-slice test discipline) and `planning-with-files` (long-goal plan files); its `references/setup.md` covers installing them. `delegate` ships its named subagent roster (`codex-worker`, `deep-reasoner`, `fast-worker`, `skeptic`) in `skills/delegate/agents/`: Claude plugin installs load it automatically; skills.sh installs run `scripts/setup-roster.sh` once.

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
`hcaiano` marketplace, and the manifest's `agents` field ships `delegate`'s
roster from `skills/delegate/agents/`. Both supported install paths — the Claude
plugin and `npx skills@latest add hcaiano/skills` for Codex or other runtimes —
pick up the same active set.

Claude Code always scans the root `skills/` directory for plugin skills, so any
skill kept directly under `skills/` must be active and listed in the Claude
manifest. Move non-shipping skills under `_deprecated/` or out of the plugin
root.

## License

[MIT](./LICENSE) © Henrique Caiano.
