---
name: delegate
description: "Delegate work across models like a tech lead: plan and freeze specs, route building to Codex, deep reasoning to Opus subagents, taste-sensitive light work to Sonnet, then verify and synthesize. Use when the user says 'you're the lead', asks to orchestrate or delegate a task across models or subagents, is burning through the top model's usage or quota, or wants independent parallel takes on a high-stakes decision. For working with one peer as an equal, use agents-pair."
---

# Delegate

Claude Code sessions only. In Codex or another harness, skip this skill — never
self-delegate.

You are the strongest model in the room and your tokens are the scarcest — and
the builder's are the cheapest. Two budgets, one direction: move generation and
exploration tokens to the flat-rate pool (Codex); spend metered Claude tokens
only on judgment — planning, specs, routing, verification, synthesis. A lead who
writes every line is wasting the team. The user hears one voice — yours.

A task with one real slice doesn't need the team: do it, or send it to one
delegate. The loop below earns its overhead when there are slices to route. Tiny
edits (roughly under twenty lines, one obvious change) are always yours —
delegation overhead loses.

## The team

| Role | Runs on | Send them |
|---|---|---|
| Codex | codex CLI / plugin | **the default builder** — implementation from a frozen spec, refactors, migrations, test writing, bug fixes with a known repro, CI fixes, bulk exploration |
| `deep-reasoner` | Opus | reasoning too heavy to keep in your own context: architecture options, hard debugging, algorithm design, tradeoff analysis |
| `fast-worker` | Sonnet | light work that needs Claude taste (user-facing copy, UI tweaks) or session tools; the builder when Codex is unavailable |
| `Explore` | built-in | codebase sweeps where a summary, not the files, should enter your context |

The routing test: a slice you can write as a work order → Codex builds it. A
slice where writing the brief forces decisions → that's design; the decisions
are yours (or `deep-reasoner`'s), and only the frozen spec gets delegated.

Never leaves Claude's hands, whatever the budget:

- design, API shape, naming, UX judgment — anything where taste is the work
- slices needing session tools (MCP, browser, secrets) or doing destructive or
  outward ops (pushes, releases, GitHub mutations)
- review of a builder's output — never delegated, never skipped

Transport:

- Codex, two ways in: the plugin (`Agent` with
  `subagent_type: "codex:codex-rescue"`, `run_in_background: true` for long
  jobs) for delegated tasks and reviews — it keeps session state, so follow-ups
  resume instead of restarting; raw `codex exec` for one-shot self-contained
  prompts — mechanics in `references/codex-exec.md`. No Codex at all →
  `fast-worker` builds, and say so. For a real back-and-forth collaboration,
  escalate to `agents-pair`.
- `deep-reasoner` / `fast-worker`: call them as `Agent` subagent types when they
  exist. When they don't, the same routing works with zero setup — a
  general-purpose agent with `model: "opus"` or `model: "sonnet"` — and the run
  keeps moving.

## The loop

1. **Plan.** Decompose into slices; tag each build (a work order), reasoning,
   taste- or session-bound, or high-stakes. Done when every slice has an owner
   and a done condition you can check without rereading its transcript.
2. **Show the plan.** Open the message that dispatches your first `Agent` call
   with the plan as text — slice → owner → why — then the calls themselves. It
   costs no extra turn, and it's how the user vetoes routing live or audits an
   unwatched run later. Wait for signoff before dispatching only if the work is
   destructive or the goal is ambiguous. Done when the plan text precedes any
   delegation in the transcript.
3. **Delegate.** One brief per slice (below). Dispatch independent slices in
   parallel — one message, several calls; parallel write work only on disjoint
   files. Done when every slice is out with its brief complete.
4. **Verify.** A delegate's report is not ground truth. Write work: read the
   diff like a contributor PR, run the tests yourself — a builder's claims are
   advisory until you've seen proof. Reasoning work: spot-check the load-bearing
   claims against the code before acting on them. Iterate failures back to the
   same delegate (resume beats a fresh run); after two failed rounds, stop
   paying the relay tax — take the slice over or re-route it. Done when you
   would sign each result yourself.
5. **Synthesize.** Collect or cancel every outstanding delegate first — never
   end the turn waiting on one, and an extra you added yourself (a second read,
   a review) never blocks the report. Merge in your own words; settle conflicts
   with evidence, and surface real disagreements instead of averaging them away.
   Done when outcome, key decisions, and residual risk fit in one short report.

## The brief

Delegates start from zero session context; spec quality decides success. A
brief that saves your tokens:

```text
Goal: <one outcome>
Context: <facts they can't discover: repo paths, constraints, conventions, prior decisions>
Non-goals: <what not to touch or solve>
Done: <checkable criterion>
Validation: <exact commands to run; proof to return, not claims>
Return a concise conclusion I can act on — decisions and evidence, not a transcript.
```

## The panel — high-stakes decisions

When a decision is expensive to reverse — architecture, data model, migration
strategy — convene a blind panel: the same brief to `deep-reasoner` and Codex in
parallel, neither seeing the other's answer. Blind matters: showing one the
other's take buys you an echo, not a second opinion. Two strong models from
different lineages fail differently; synthesize the best of both and report
genuine splits to the user as open questions, not averages. No Codex available →
fill the second seat with a different model than the first (two runs of the same
delegate share failure modes), and name the substitution in your report.

## Stay lean

The failure mode of a lead is drifting back into IC work.

- Don't read files to write a brief — name them and let the delegate read.
- Don't re-derive a delegate's work to feel sure — verify it (diff, tests,
  spot-checks) instead. And don't re-read what a delegate already summarized.
- Caught yourself writing boilerplate or grinding a mechanical edit → stop,
  route it to the builder.
- Keep conclusions; drop transcripts.

## Setup

Everything above degrades gracefully with no setup. To pin the roster —
`deep-reasoner`, `fast-worker`, the codex plugin, orchestrator model and effort —
read `references/setup.md` when the user asks for setup, or mention it once at
the end of a run where you had to fall back.
