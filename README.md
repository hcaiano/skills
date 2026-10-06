# Agent Skills

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Personal agent skills shared across Claude Code, Codex, Cursor, and Grok.

The repository contains seven active skills under `skills/` and small maintenance
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

## Skills

### Orchestration

- `t3-capacity` — check account usage, pace, and resets before T3 Code delegation.

### Engineering

- `workflow-retro` — daily retro of every agent session on the PC and the
  MacBook: fixes defects in these skills and proposes everything else. Run by a
  T3 scheduled task on the PC.
- `review-it` — pre-PR review: grade a change by risk, have another model
  family review it (the full `interrogate` panel when risky), and fix the
  findings.
- `write-pr` — write a short, human-first PR description: what and why, merge
  danger, before/after screenshots, checks, and review.
- `cyber-audit` — audit this Linux or macOS machine read-only against a named CVE, malicious
  package, or supply-chain advisory and leave a written report.
- `test-audit` — gate new tests against a value bar, and prune low-value
  tests in focused audits or whole-app campaigns before legacy refactors.

### Creative work

- `art-director` — manually explore and choose a visual direction before
  implementation, using generated concepts and optional identity-system proof.

## Deprecated

Frozen skills live in the root `deprecated/` folder. The Skills CLI scans the
repo root at depth 1 and `skills/` at depth 3, so that location keeps them out
of `--skill '*'` by design — moving them under `skills/` would publish them
again.

- `herdr-pair` — replaced by `pair`, itself now deprecated. Existing users keep it with:

```bash
npx skills@latest add hcaiano/skills/deprecated --global --agent claude-code codex cursor grok --skill herdr-pair --yes
```

- `herdr-orchestrate` — replaced by `orchestrate`, itself now deprecated. Existing users keep it with:

```bash
npx skills@latest add hcaiano/skills/deprecated --global --agent claude-code codex cursor grok --skill herdr-orchestrate --yes
```

- `review-pr-comments` — replaced by `ship-it`'s PR-feedback step (`ship-it` is now deprecated), which keeps
  the delivery receipt valid. Keep it with the same subpath command and
  `--skill review-pr-comments`.
- `no-slop` — replaced by the upstream `unslop` skill; write in your own voice
  with a voice skill such as `caianizer`. Keep it with `--skill no-slop`.
- `pair`, `orchestrate`, `ship-it`, `ask-peer`, and `debug-mode` — retired
  when the workflow moved to T3 Code only, where pstack skills and T3
  delegation do this work. `orchestrate` and `ask-peer` read `pair`'s scripts
  and roster, so keep them together. `ship-it` and `orchestrate` expect the
  old Herdr `review-it`, which Git history keeps; the active `review-it` is
  its T3 rewrite:

```bash
npx skills@latest add hcaiano/skills/deprecated --global --agent claude-code codex cursor grok --skill pair orchestrate ship-it ask-peer debug-mode --yes
```

`skills update` re-appends that subpath, so updates keep working. An install
made before a skill moved here still carries it: remove it by name as described
under Install.

## Dependencies

- `t3-capacity` requires Node.js and the T3 Code orchestration MCP. It reads
  Claude, Codex and Cursor usage with its own usage reader and the grok.com
  login's billing endpoint for Grok. Account readings run on the T3 server's
  environment; unverified account mappings and missing usage remain unknown.
- `review-it` requires the T3 Code orchestration MCP, `t3-capacity`, and
  pstack's `poteto-mode` and `interrogate` (for `references/t3-execution.md`,
  the `interrogate reviewers` line in `pstack-models.md`, and the `dual`
  panel).
- `art-director` uses Codex's built-in `imagegen` skill: directly in Codex,
  and through a `delegate_task` to a Codex instance anywhere else.
- `test-audit` campaigns review each subsystem PR with `review-it` and run
  reviewers with `delegate_task`.

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
