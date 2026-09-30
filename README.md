# Agent Skills

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Personal agent skills shared across Claude Code, Codex, Cursor, and Grok.

The repository contains nine active skills under `skills/` and small maintenance
scripts under `scripts/`.

## Install

```bash
npx skills@latest add hcaiano/skills --global --agent claude-code codex cursor grok --skill '*' --yes
```

This installs every active skill for all four agents. Skills keep their
plain names, without a plugin namespace such as `hcaiano:`.

Run the same command to update the installed copies after changing this repo.

Stop Codex, Claude Code, Cursor, Grok, and other running skill loaders before
any global `skills add` or `skills update`. Skills CLI 1.5.23 replaces each
canonical `~/.agents/skills/<name>` directory by removing it and then copying
the new files. A live loader can read during that gap and report a missing
`SKILL.md`. Finish the CLI command before starting an agent again. After an
interrupted update, verify the affected path is readable and rerun the same CLI
command while the loaders are stopped.

Adding never removes. When a skill is renamed or dropped here, the old copy
stays installed and keeps answering under its old name, so remove it by name:

```bash
npx skills@latest remove <old-name> --global --agent universal <every agent that lists it> --yes
```

Two traps here, both measured while removing `review-gate`:

- `--agent claude-code codex` is not enough. These skills install as one
  canonical copy under `~/.agents/skills` that every agent reads, so naming
  only the two agents removes their registrations and leaves the directory,
  the lock entry, and every other agent's registration behind. The command
  still prints `Successfully removed 1 skill(s)`. Read `skills list -g --json`
  for the skill's real `agents` array, and pass `universal` plus that list.
- `--agent '*'` is rejected even though `remove --help` offers it; the
  wildcard belongs to `--skill`.

`--global` matters too: without it the command targets project scope and
leaves the globally installed copy in place.

`review-gate` was renamed to `review-it`. An install made before that rename
carries both, and the stale one still answers under the retired workflow.

## Skills

### Orchestration and collaboration

- `orchestrate` — run an explicit task list through isolated worktrees,
  headless pairs, pull requests, verified merges, and cleanup in any harness.
- `pair` — keep two agents collaborating persistently, any pair of `claude`,
  `codex`, `cursor`, `grok`, and `opencode`: persistent headless CLI sessions,
  or a visible Herdr tab on request. Its model roster
  (`references/models.md`) is the one place that names seats, efforts, and
  pool rules for every skill here.
- `ask-peer` — request one focused opinion, review, or bounded work pass from
  the opposite model without starting a persistent pair.

### Engineering

- `debug-mode` — diagnose or debug broken, failing, flaky, slow, or
  production-only bugs with a red feedback loop and runtime evidence.
- `cyber-audit` — audit this Linux or macOS machine read-only against a named CVE, malicious
  package, or supply-chain advisory and leave a written report.
- `test-audit` — gate new tests against a value bar, and prune low-value
  tests in focused audits or whole-app campaigns before legacy refactors.

### Creative work

- `art-director` — manually explore and choose a visual direction before
  implementation, using generated concepts and optional identity-system proof.

### Delivery

- `review-it` — grade a finished change, run one Standards and Spec review
  round from another model family, and batch material fixes. Ends at a clean local HEAD and a
  receipt; never pushes, opens a PR, or merges.
- `ship-it` — prove a finished change, run the graded gate above, validate
  the final HEAD deterministically, and carry the authorized PR delivery
  forward. Also the loop for feedback on an existing PR.

## Deprecated

Frozen skills live in the root `deprecated/` folder. The Skills CLI scans the
repo root at depth 1 and `skills/` at depth 3, so that location keeps them out
of `--skill '*'` by design — moving them under `skills/` would publish them
again.

- `herdr-pair` — replaced by `pair`. Existing users keep it with:

```bash
npx skills@latest add hcaiano/skills/deprecated --global --agent claude-code codex cursor grok --skill herdr-pair --yes
```

- `herdr-orchestrate` — replaced by `orchestrate`. Existing users keep it with:

```bash
npx skills@latest add hcaiano/skills/deprecated --global --agent claude-code codex cursor grok --skill herdr-orchestrate --yes
```

- `review-pr-comments` — replaced by `ship-it`'s PR-feedback step, which keeps
  the delivery receipt valid. Keep it with the same subpath command and
  `--skill review-pr-comments`.
- `no-slop` — replaced by the upstream `unslop` skill; write in your own voice
  with a voice skill such as `caianizer`. Keep it with `--skill no-slop`.

`skills update` re-appends that subpath, so updates keep working. An install
made before a skill moved here still carries it: remove it by name as described
under Install.

Keeping a deprecated skill does not install its active dependencies.
`review-it`'s visible Herdr gate reads its caller-pane proof from `pair`, so
install `pair` as well.

## Dependencies

- `orchestrate` requires `pair`, `git`, and `gh`. Units default to the
  headless backend, which needs only the chosen partner CLI (`claude`,
  `codex`, `cursor-agent`, `grok`, or `opencode`); `--backend herdr` also
  requires the `herdr` CLI and the separate upstream `herdr` skill. Optional
  machine-local pieces, each degrading gracefully when missing:
  `~/.local/bin/agent-run` (the heavy-work slot; without it validation runs
  unqueued), `~/.claude/usage-state.json` written by the statusline (without
  it the Claude pool reads `unknown`), `~/.codex-profiles/<name>` (a second
  Codex home for `--identity`), and Claude Code's `oracle` agent (the Fable
  planning seat for a Claude lead).
- `ask-peer` requires authenticated Claude and Codex CLIs, plus `jq` for the
  Codex path. Codex consults Claude (Fable only on request); Claude Code
  consults Codex. Efforts come from `pair`'s roster.
- `art-director` uses Codex's built-in `imagegen` skill: directly in Codex,
  and through a `pair` with a `codex` partner anywhere else.
- `test-audit` campaigns ship each subsystem PR through `ship-it` (and so
  `review-it`), and use `ask-peer` for the preservation review when subagents
  are unavailable.
- `ship-it` requires `review-it` installed alongside it: it delegates its
  graded gate and never reimplements one.
- `review-it` reads the usage-state helper bundled with `pair`
  to size its review pools, and reads `pair`'s caller-pane proof to run a
  gate command in a visible Herdr pane. A missing usage-state helper records an
  unread pool state and changes nothing else. A missing `pair` runs the
  gate locally outside Herdr, and stops it inside Herdr rather than hiding a
  hosted run.

These dependencies are not bundled here and must be installed separately.

## Development

List active skills:

```bash
./scripts/list-skills.sh
```

## Publishing

Active skills live under `skills/`. Publish and update them through the Vercel
Skills CLI command above; Git history preserves removed skills.

## License

[MIT](./LICENSE) © Henrique Caiano.
