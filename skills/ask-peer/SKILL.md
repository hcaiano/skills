---
name: ask-peer
description: "Ask the opposite model for one focused opinion, review, or scoped pass without a live Herdr pair. Codex may consult Fable autonomously; Claude Code consults Codex only when explicitly invoked."
user-invocable: true
disable-model-invocation: true
argument-hint: "<question, review, or scoped task for the other agent>"
---

# Ask Peer

One request, one opposite-model reply. This is the phone-friendly headless path:
use it for a focused second opinion, review, or bounded work pass. Use
`pair` for a persistent multi-turn dialogue.

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
