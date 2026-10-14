---
name: workflow-retro
description: "Weekly retro of every agent session on the PC and the MacBook: fix my skills, propose the rest."
disable-model-invocation: true
---

# Workflow retro

Run on the PC. The MacBook is reachable as `ssh mbp`. Report in Portuguese.

## 1. Collect

Read [the collection commands](references/collection.md) and run the maintained
scripts on the PC and Mac for the same `[last-run, now)` UTC window. On a first
run, use the last 7 days. Collect T3 activity and parent chains from read-only
SQLite, provider sessions, PR evidence through `gh`, and scheduled tasks from
both databases. Done when each source has an index with machine, counts, and gaps.

Redaction is best-effort; keep outputs local under `~/.local/state`.
Never paste raw evidence into PRs, issues, or other external services; quote only short, redacted excerpts.

Keep tool names, structured inputs, and results. Recover any invocation or read
missing from an extract before judging it. Record unrecovered evidence in
`LIMITS.md`. Cursor timelines live in the referenced T3 parts. Grok history is
context, not timestamped activity. Exclude earlier `workflow-retro` runs at the
judgment stage by explicit session IDs; retain their collection evidence.

## 2. Judge

Read `~/.agents/skills/retro/SKILL.md` and apply its categories. Measure each
session against the workflow in `~/.agents/AGENTS.md` and look for:

- PR bodies off `write-pr`'s shape;
- `review-it` skipped, graded too low, or missing its receipt;
- red CI, conflicts or open review threads left behind;
- questions to the user that the docs already answered;
- repeated manual work a skill or script could do;
- model or account choices against `~/.agents/pstack-models.md`;
- scheduled tasks without the `[A]` title prefix that belong to the user's
  automations, and agent timers whose end condition passed, whose thread is
  settled or archived, or whose recent runs changed nothing;
- time each feature spent in implementation, review, fixes, babysitting and
  merge, and defects found after merge, by the reasoning effort each phase
  ran at, so effort budgets follow measured results;
- waste: children per merged PR, two reviews of the same head, review or
  evidence children on top of `review-it`, more than one confirmation, polling
  calls (`task_status`, empty `write_stdin`, `sleep`) and their share of input
  tokens, and leads that stay open for days.

Each finding carries its evidence: machine, session, PR and a short quote.
Drop findings already open in a PR or proposed in an earlier retro thread.

## 3. Act

Change only `hcaiano/skills`; apart from the reinstall below, this run writes
nothing in any other repository.
A defect inside one of its skills gets fixed: branch, edit in the
`writing-for-agents` style, run `review-it`, open the PR with `write-pr`, merge
once the review is clean and checks pass, then reinstall on the Mac, the fleet
source: fleet push overwrites the PC's `~/.agents/skills` within minutes.

```bash
ssh mbp 'PATH=/opt/homebrew/bin:$PATH env -u CLAUDE_CONFIG_DIR -u GROK_HOME -u CURSOR_CONFIG_DIR -u CODEX_HOME npx -y skills@latest add hcaiano/skills --skill <name> -g -a claude-code codex cursor grok -y'
```

Done when the Mac's `~/.agents/skills/<name>/SKILL.md` matches the merged
file. At most two merged fixes per run, each reviewed once by `review-it`;
the rest become proposals.

Delete an agent timer (no `[A]` prefix) on the PC when its bound thread is
settled or archived, and list each one in the report. Every other timer
finding is a proposal.

Everything else is a proposal for the user: `~/.agents/AGENTS.md`,
`pstack-models.md`, pstack itself, fleet, work repositories, new skills, and any
removed or weakened rule.

## 4. Report

Write `REPORT.md` with merged fixes and PR links first, then proposals ranked
by severity with evidence. Keep coverage to one line with the window and counts
per machine. Put source gaps, failed reads, and limits in `LIMITS.md` and link it.
Reply with the fixes and proposals. With nothing material, reply in one line.

Write the run's start time as ISO 8601 UTC to
`~/.local/state/workflow-retro/last-run` only after both hosts and all required
sources have complete receipts or every gap has a documented recovery. Otherwise
keep the old time and name the failed sources in `LIMITS.md`.
