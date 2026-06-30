---
name: agents-pair
description: "Pair the agent you are running in with a peer AI agent (Codex, Claude, ...) as equal engineers to plan, implement, review, debate, or delegate. Use whenever the user wants a second agent involved: 'pair with Codex', 'have Codex review this diff', 'delegate this to Codex', 'get Codex's opinion', 'adversarial review with Codex', 'work with Claude', 'have Claude review the plan', 'mirror this goal into Claude', or run long multi-agent goal loops. Routes to the right transport for your host->peer direction (Claude Code <-> Codex via the codex plugin; Codex <-> Claude via headless `claude -p`). For paired UI/frontend work, route design decisions through the impeccable skill."
---

# Agents Pair

Bring in a second AI agent as an equal engineer — to plan, build, review, or take
a slice in parallel. This hub holds the rules that hold for any pairing; the
transport for a specific direction lives in a bridge you load below.

Stance: peers, not manager and report. Alternate who writes. Settle disagreements
with tests and repo conventions, not seniority. Whoever owns the user thread is
doing logistics, not giving orders.

## Route to your bridge

You know which agent you are. Pick the peer, read that bridge in full, then work
from it.

| You are | Peer | Bridge |
|---|---|---|
| Claude Code | Codex | `references/bridges/claude-with-codex.md` |
| Codex | Claude | `references/bridges/codex-with-claude.md` |

No bridge for the peer they asked for (Gemini, Grok, Cursor, ...)? Say so, then
offer the nearest pairing or go solo. Adding a peer later is just a new bridge
file; this hub doesn't change.

## When to pair

Default to pairing on non-trivial work; skip it on trivial edits. Worth a peer:

- a review of the real diff before you call something done,
- a heavy or cleanly separable slice you can hand off,
- an adversarial read on a risky or hard-to-reverse decision,
- a stall, a second implementation, or a deeper diagnosis.

Don't pair as ceremony, and don't escalate just because a feature exists.

## Rules that matter

A capable agent already knows how to collaborate. These are the ones easy to get
wrong, so hold them:

- **One writer per file set.** Only one agent holds the pen on a given set of
  files at a time; hand off before the peer touches them. Take turns or split
  scopes; parallel work only on disjoint files.
- **Verify peer output.** It's a peer's patch, not ground truth. After any peer
  writing turn, read `git diff` and the touched files and run tests before you
  build on it.
- **Evidence over rank.** Push back, and let tests and conventions decide. Surface
  real disagreements instead of quietly complying or quietly overruling.
- **Stay in scope and safe.** No secrets in peer prompts. No commit, push, merge,
  deploy, or credential change unless the user asked and you confirmed the exact
  action. No broad refactors riding along. Keep the user's global rules (e.g.
  `trash` not `rm -rf`, never commit to `main` unprompted).

## How a turn ends

Pairing is a dialogue, not a one-shot. End each handoff with a short peer message:
what you did or concluded, where you disagree, what's next and who holds the pen,
the files you changed, and any checks you want run. Next turn, answer the peer's
questions before adding new asks. The bridge says how that message is carried.

## The loop

Clarify the goal and mirror it to the peer → debate the plan before big edits →
take turns writing, each turn naming its files and stop point → review the real
diff after each turn → resolve what survives both reads → one fresh audit of the
final diff before you answer. On long goals, keep shared notes with
`planning-with-files`, and stop to ask the user if two cycles produce no progress.

## Domain skills still apply

Pairing doesn't replace them. For UI, use `impeccable` and have the peer critique
against it. For APIs, check current docs before reasoning from memory. For long
goals, share `planning-with-files` state. Tell the peer which skill's rules bind
this turn. For advanced Codex/Claude surfaces, see `references/features.md`.
