# Agent Skills

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Personal agent skills shared across Claude Code and Codex.

The repository contains ten active skills under `skills/` and small maintenance
scripts under `scripts/`.

## Install

```bash
npx skills@latest add hcaiano/skills --global --agent claude-code codex --skill '*' --yes
```

This installs every active skill for Claude Code and Codex. Skills keep their
plain names, without a plugin namespace such as `hcaiano:`.

Run the same command to update the installed copies after changing this repo.

## Skills

### Orchestration and collaboration

- `herdr-orchestrate` — manually orchestrate GitHub issues through dedicated
  Herdr work units, from triage and delegation through shipping, merging, and
  teardown.
- `herdr-pair` — keep Claude and Codex collaborating inside one Herdr tab with
  durable, workspace-scoped transport.
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

- `review-gate` — grade a finished change, simplify it, run one graded LLM
  review round, and batch material fixes. Ends at a clean local HEAD and a
  receipt; never pushes, opens a PR, or merges.
- `ship-it` — prove a finished change, run the graded gate above, validate
  the final HEAD deterministically, and carry the authorized PR delivery
  forward.
- `review-pr-comments` — handle feedback that actually appears on an existing
  PR, batching valid fixes and leaving the PR merge-ready.

## Dependencies

- `herdr-orchestrate` and `herdr-pair` require the `herdr` CLI and the separate
  upstream `herdr` skill. This repository does not vendor either one.
- `ask-peer` requires authenticated Claude and Codex CLIs. Codex consults Fable
  through Claude; Claude Code consults Codex.
- `art-director` composes the external `imagegen` skill. It uses `brandkit`
  only when a selected identity direction needs system proof, and `herdr-pair`
  only when the current runtime cannot generate images directly.
- `ship-it` requires `review-gate` installed alongside it: it delegates its
  graded gate and never reimplements one.
- `review-gate` reads the usage-state helper bundled with `herdr-orchestrate`
  to size its review pools, and reads `herdr-pair`'s caller-pane proof when
  running a gate command in a visible Herdr pane. It degrades to a recorded
  skip rather than failing when either is absent.

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
