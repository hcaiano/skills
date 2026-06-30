---
name: agents-pair
description: "Pair with a peer AI agent. Use when the user asks to pair with Codex or Claude, delegate a scoped slice, request peer review, run an adversarial challenge, mirror a long goal loop, or use live herdr pairing. Routes Claude Code<->Codex through the codex plugin, Codex<->Claude through headless `claude -p`, and live panes through `herdr-pair`. For paired UI work, use `impeccable`."
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

## Live or headless

The bridges above are the **headless** surface: an ephemeral peer, scoped prompt
in, clean result out. Inside herdr there is a **live** surface: a peer already
running in a tab, warm with its own context, that the user watches. `herdr-pair`
owns that protocol: pane identity, session state, and turn transport.

Go live only when it earns it:

- In herdr (`HERDR_ENV=1`) with a real opposite-agent pane in your tab, or when the
  user asks for live pairing → hand off to `herdr-pair`.
- No live peer, or a narrow delegation/review where headless is cheaper and
  cleaner → stay headless. Don't go live just because `HERDR_ENV=1`, and don't let
  both surfaces track session state for the same collaboration.

**Write lease.** One agent holds the pen for a declared scope: owner, target
files, forbidden changes, validation, and stop point. The other agent stays
read/review-only on that scope until handoff; either renegotiates before editing
out of scope. Broad concurrent work needs disjoint leases, separate worktrees, or
headless delegation. `herdr-pair` enforces live turns; the hub sets the rule.

## When to pair

Default to pairing on non-trivial work; skip it on trivial edits. Worth a peer:

- a review of the real diff before you call something done,
- a heavy or cleanly separable slice you can hand off,
- an adversarial read on a risky or hard-to-reverse decision,
- a stall, a second implementation, or a deeper diagnosis.

Don't pair as ceremony, and don't escalate just because a feature exists.

## Rules that matter

Easy to get wrong — hold these:

- **Write lease.** Hold one lease per file set. Take turns or split scopes;
  parallel work only on disjoint leases.
- **Verify peer output.** It's a peer's patch, not ground truth. After any peer
  writing turn, read `git diff` and the touched files and run tests before you
  build on it.
- **Evidence over rank.** Push back, and let tests and conventions decide. Surface
  real disagreements instead of quietly complying or quietly overruling.
- **Stay in scope and safe.** No secrets in peer prompts. No commit, push, merge,
  deploy, or credential change unless the user asked and you confirmed the exact
  action. No broad refactors riding along. Keep the user's global rules.

## How a turn ends

Pairing is a dialogue, not a one-shot. End each handoff with a short peer message:
what you did or concluded, where you disagree, what's next and who holds the pen,
the files you changed, and any checks you want run. Next turn, answer the peer's
questions before adding new asks. The bridge says how that message is carried.

## The loop

1. Clarify and route. Done when the peer, surface, bridge, and shared goal are
   explicit.
2. Debate before big edits. Done when open objections are resolved or recorded.
3. Write under a lease. Done when each writing turn names owner, files, forbidden
   changes, validation, and stop point before edits begin.
4. Review the real diff. Done when the other peer has read touched files,
   inspected `git diff`, and run or requested the relevant checks.
5. Close with a final audit. Done when the final diff, validation, peer questions,
   and remaining disagreements are accounted for. On long goals, keep the shared
   plan below and ask the user if two cycles produce no progress.

## Shared plan (long goals)

For a goal that spans many checkpoints — a migration, multi-feature work, research
— give the pair a durable shared brain with `planning-with-files`: `task_plan.md`
(plan and decisions), `findings.md` (evidence and peer findings), `progress.md`
(what changed, what was validated, decisions, what remains). Separate contexts make
these files the common ground; they also survive `/clear` and compaction. Once it
exists, the peer message references the plan instead of restating it.

The plan files are themselves write-leased:

- the **coordinator** — the agent that took the original goal, fixed until an
  explicit handoff, *not* the rotating write lead — owns `task_plan.md` and
  `progress.md`;
- the **peer** appends to `findings.md` (nothing to append when it found nothing)
  and reports its changed files, validation, and decisions in the peer message;
- both read freely and re-read before major decisions.

`progress.md` is coordinator-only — a code write lease doesn't grant the right to
write it; the coordinator records each checkpoint from the peer message. Keep it
semantic: sid, pane ids, rounds, and turn state stay in the bridge's session state,
never copied here. At close, the coordinator drains `findings.md` into accepted /
deferred / resolved.

Skip all of this for a quick review or one-shot delegation; there the peer message
and the diff are the state.

## Domain skills still apply

Pairing doesn't replace them. For UI, use `impeccable` and have the peer critique
against it. For APIs, check current docs before reasoning from memory. Tell the
peer which skill's rules bind this turn. For advanced Codex/Claude surfaces, see
`references/features.md`.
