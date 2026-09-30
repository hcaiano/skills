---
name: ask-peer
description: "One-shot opinion, review, or scoped pass from the opposite model family, with no persistent session. Use when stuck after a failed attempt, or before a high-stakes decision."
disable-model-invocation: true
argument-hint: "<question, review, or scoped task for the other agent>"
---

# Ask Peer

One request, one reply from the opposite model family, with no session kept.
For a multi-turn dialogue, use `pair`.

Detect the current harness, then read the matching reference in full:

| Current harness | Peer | Reference |
|---|---|---|
| Codex | Claude | [`references/ask-claude.md`](references/ask-claude.md) |
| Claude Code | Codex | [`references/ask-codex.md`](references/ask-codex.md) |

If the harness is ambiguous, inspect the environment and the available CLIs
before choosing. The peer is always the other family's CLI.

## When to ask

On your own initiative, ask only for hard analysis or a second opinion: when
stuck after a failed attempt, or before a high-stakes decision. A review goes
through `review-it`, or through this skill when the user explicitly asks for
one. Ask Fable only when the user asks for Fable.

## Shared contract

- Staff the roster seat for the ask, never a reserved family by accident: the
  peer's configured default can be Fable or Astra. Claude takes the seat's
  family as `--model opus`; Codex takes exact IDs, so leave `-m` unset only
  when the `model` in `~/.codex/config.toml` is a Sol model, and otherwise ask
  the user which model to use. A model the user names wins. Set effort on
  every request from the same seat: the
  [Analysis seat](../pair/references/models.md#analysis-seat) for hard analysis
  or a second opinion, the
  [Review seat](../pair/references/models.md#review-seat) for a review.
- Default to read-only. Grant a write pass only when the user's request
  requires edits, with an explicit lease: target files, forbidden changes,
  validation, and stop point.
- Include the workspace root, the exact ask, relevant repo instructions, and
  the desired response format. Keep secrets out of the prompt.
- Treat the reply as evidence, not authority. After a write pass, inspect
  `git diff`, the touched files, and the named validation's real output before
  relying on it.
- No commit, push, merge, deploy, or credential mutation unless the user
  explicitly authorized that action.
