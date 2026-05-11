# Host-CLI placeholder strings

The visible-input guard in `herdr-pair`'s pre-send checks should ignore strings the host CLI (Claude Code, Codex CLI) renders into the input area when the buffer is empty. These look like real text but are placeholder hints. Block only on user-authored prose.

This file is the catalog. It is expected to drift as host CLIs evolve; update it here, not in the main SKILL.md.

## Claude Code (claude)

- `Try "how does <something> work?"`
- `Try "<any other suggestion>"`
- Any line that starts with `Try "` and ends with `"`
- Empty prompt with a single `›` glyph and nothing else
- Status line: `claude-opus-4-7 · ~` (or any `claude-<model>-<version> · ~`)
- Background-task status: `Working (Xs · esc to interrupt)`, `Working (Xs · esc to interrupt) · N background terminals running · /ps to view · /stop`
- The literal banner: `Press up to edit queued messages` **without** any visible queued prose underneath it. (If there's queued prose underneath, treat as real input and STOP.)

## Codex CLI (codex)

- `Summarize recent commits`
- `Suggest improvements`
- Any other single-line generic suggestion at the prompt
- Empty prompt with a single `›` glyph
- Status line: `gpt-5.5 high · ~` (or any `gpt-<model> <level> · ~`)
- Background-task status mirroring Claude Code's format

## General principle

If the visible input area contains:

- Exactly one short line that matches a known placeholder pattern → **placeholder, send anyway.**
- Multiple lines of prose, or text under a "queued messages" banner that doesn't itself match a known pattern → **real user input, STOP and surface to the user.**
- Anything in the scrollback (above the prompt area) → not in the input buffer, irrelevant to the guard.

When uncertain, prefer sending. Placeholder strings get overwritten harmlessly when `send-text` types the message; truly stomping on user input is extremely rare and shows up in scrollback for recovery.

## Updating this catalog

When you see a new placeholder string from a host-CLI update, add it here. Both `claude` and `codex` will read this file from the installed `herdr-pair` skill — the catalog is the single source of truth for both agents.
