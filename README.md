# Agent Skills

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Personal agent skills shared across Claude Code, Codex, Cursor, and Grok.

The repository contains ten active skills under `skills/` and small maintenance
scripts under `scripts/`.

## Install

```bash
npx skills@latest add hcaiano/skills --global --agent claude-code codex cursor grok --skill '*' --yes
```

This installs every active skill for all four agents. Skills keep their
plain names, without a plugin namespace such as `hcaiano:`.

Run the same command to update the installed copies after changing this repo.

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
  `codex`, `cursor`, and `grok`: a visible Herdr tab inside Herdr, persistent
  headless CLI sessions anywhere else.
- `ask-peer` — request one focused opinion, review, or bounded work pass from
  the opposite model without starting a persistent pair.

### Engineering

- `debug-mode` — diagnose unresolved, flaky, environment-specific, or
  production-only bugs through an evidence loop.
- `cyber-audit` — audit this machine read-only against a named CVE, malicious
  package, or supply-chain advisory and leave a written report.

### Creative work

- `art-director` — manually explore and choose a visual direction before
  implementation, using generated concepts and optional identity-system proof.
- `no-slop` — draft or edit writing in Henrique's voice, or identify concrete
  AI-slop patterns without rewriting.

### Delivery

- `review-it` — grade a finished change, simplify it, run one graded LLM
  review round, and batch material fixes. Ends at a clean local HEAD and a
  receipt; never pushes, opens a PR, or merges.
- `ship-it` — prove a finished change, run the graded gate above, validate
  the final HEAD deterministically, and carry the authorized PR delivery
  forward.
- `review-pr-comments` — handle feedback that actually appears on an existing
  PR, batching valid fixes and leaving the PR merge-ready.

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

`skills update` re-appends that subpath, so updates keep working.

Keeping either deprecated skill does not install its active dependencies.
`review-it`'s visible Herdr gate reads its caller-pane proof from `pair`, so
install `pair` as well.

## Dependencies

- `orchestrate` requires `pair`, `git`, `gh`, and `trash`. Its units always use
  pair's headless backend. `pair`'s Herdr backend requires the `herdr` CLI and
  separate upstream `herdr` skill; its headless backend needs only the chosen
  partner CLI (`claude`, `codex`, `cursor-agent`, or `grok`).
- `ask-peer` requires authenticated Claude and Codex CLIs. Codex consults Fable
  through Claude; Claude Code consults Codex.
- `art-director` composes the external `imagegen` skill. It uses `brandkit`
  only when a selected identity direction needs system proof, and `pair`
  only when the current runtime cannot generate images directly.
- `ship-it` requires `review-it` installed alongside it: it delegates its
  graded gate and never reimplements one.
- `review-it` reads the usage-state helper bundled with `orchestrate`
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
