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

Select logs by modification time against a reference file
(`TZ=UTC touch -t <CCYYMMDDhhmm.ss> <ref>`, then `find … -newer <ref>`): macOS
`find -newermt` rejects ISO times and reads other forms as local time. Keep only
events stamped inside the window. Grok sessions live under
`sessions/<encoded cwd>/<id>/`: use the timestamped events in `updates.jsonl`
to select activity, then read `chat_history.jsonl` for context. The chat history
has no message timestamps. Cursor `chats/**/meta.json` with
`hasConversation: false` records a probe, not a conversation. For conversations,
read their timestamped transcript or T3 timeline; record missing evidence as a
source gap. Claude transcripts under `subagents/` and T3 threads with a
`parentThreadId` belong to their parent session. Judge thread activity by its
message and event timestamps: a T3 restart stamps many threads with the same
`updatedAt`.

Skip earlier `workflow-retro` runs. Done when every other session and PR in the
window is listed with its machine.

## 2. Judge

Read `~/.agents/skills/retro/SKILL.md` and apply its categories. Measure each
session against the workflow in `~/.agents/AGENTS.md` and look for:

- PR bodies off `write-pr`'s shape;
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
once the review is clean and checks pass, then reinstall on the Mac, the fleet
source: fleet push overwrites the PC's `~/.agents/skills` within minutes.

```bash
ssh mbp 'PATH=/opt/homebrew/bin:$PATH env -u CLAUDE_CONFIG_DIR -u GROK_HOME -u CURSOR_CONFIG_DIR -u CODEX_HOME npx -y skills@latest add hcaiano/skills --skill <name> -g -a claude-code codex cursor grok -y'
```

Done when the Mac's `~/.agents/skills/<name>/SKILL.md` matches the merged
file. At most three merged fixes per run; the rest become proposals.

Everything else is a proposal for the user: `~/.agents/AGENTS.md`,
`pstack-models.md`, pstack itself, work repositories, new skills, and any
removed or weakened rule.

## 4. Report

Reply with the merged fixes and their PR links, then the proposals ranked by
severity with their evidence. With nothing material, one line.

When step 1 covered both machines, write the run's start time as ISO 8601 UTC
to `~/.local/state/workflow-retro/last-run`. Otherwise keep the old time and
report which machine or source failed, so the next run covers the gap.
