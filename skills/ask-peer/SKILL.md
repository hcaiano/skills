---
name: ask-peer
description: "Opposite-model request for one focused pass. In Codex, reach for this autonomously to escalate to Fable (through `claude -p`) when you need stronger reasoning, a second opinion, or a scoped review; in Claude Code it stays manual — Claude asks Codex through `codex exec` only when the user invokes it. Use for a focused pass without a live Herdr pair."
user-invocable: true
disable-model-invocation: true
argument-hint: "<question, review, or scoped task for the other agent>"
---

# Ask Peer

One request, one opposite-model reply. This is the phone-friendly headless path:
use it for a focused second opinion, review, or bounded work pass. Use
`herdr-pair` for a visible multi-turn dialogue and `delegate` for Fable-led
multi-slice orchestration.

Detect the current harness, then read the matching reference in full:

| Current harness | Peer | Reference |
|---|---|---|
| Codex | Fable | `references/ask-fable.md` |
| Claude Code | Codex | `references/ask-codex.md` |

If the harness is ambiguous, inspect the environment and available CLI before
choosing. Never ask the same model through its own CLI.

## Shared contract

- Default to read-only. Grant a write pass only when the user's request requires
  edits, with an explicit lease: target files, forbidden changes, validation, and
  stop point.
- Include the workspace root, the exact ask, relevant repo instructions, and the
  desired response format. Keep secrets out of the prompt.
- Model selection belongs to each peer's own surface: call Fable explicitly;
  leave Codex's model unset so `~/.codex/config.toml` or the CLI default owns it.
- Treat the reply as evidence, not authority. Inspect any diff and rerun the named
  validation before relying on a write pass.
- No commit, push, merge, deploy, or credential mutation unless the user
  explicitly authorized that action.
