---
name: workflow-retro
description: "Daily retro of every agent session on the PC and the MacBook: fix my skills, propose the rest."
disable-model-invocation: true
---

# Workflow retro

Run on the PC. The MacBook is reachable as `ssh mbp`. Report in Portuguese.

## 1. Collect

The window runs from the time in `~/.local/state/workflow-retro/last-run`, or
the last 24 hours on a first run. Gather, from both machines:

- T3 threads on the PC through `t3_thread_list` and `t3_thread_read`.
- Provider session logs under `~/.t3/claude-home/projects`,
  `~/.t3/codex-home/sessions`, `~/.t3/grok-home` and `~/.t3/cursor-home`.
- Every PR those sessions opened or touched: body, review threads and checks,
  through `gh`.

Skip earlier `workflow-retro` runs. Done when every other session and PR in the
window is listed with its machine.

## 2. Judge

Read `~/.agents/skills/retro/SKILL.md` and apply its categories. Measure each
session against the workflow in `~/.agents/AGENTS.md` and look for:

- PR bodies off `write-pr`'s shape, or media outside the before/after table;
- `review-it` skipped, graded too low, or missing its receipt;
- red CI, conflicts or open review threads left behind;
- questions to the user that the docs already answered;
- repeated manual work a skill or script could do;
- model or account choices against `~/.agents/pstack-models.md`.

Each finding carries its evidence: machine, session, PR and a short quote.
Drop findings already open in a PR or proposed in an earlier retro thread.

## 3. Act

A defect inside a skill in `hcaiano/skills` gets fixed: branch, edit in the
`writing-for-agents` style, run `review-it`, open the PR with `write-pr`, merge
once the review is clean and checks pass, then reinstall with
`env -u CLAUDE_CONFIG_DIR -u GROK_HOME -u CURSOR_CONFIG_DIR -u CODEX_HOME npx skills@latest add hcaiano/skills --skill <name> -g -a claude-code codex cursor grok -y`.
At most three merged fixes per run.

Everything else is a proposal for the user: `~/.agents/AGENTS.md`,
`pstack-models.md`, pstack itself, work repositories, new skills, and any
removed or weakened rule.

## 4. Report

Reply with the merged fixes and their PR links, then the proposals ranked by
severity with their evidence. With nothing material, one line. Then write the
run's start time to `~/.local/state/workflow-retro/last-run`.
