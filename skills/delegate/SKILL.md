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
| `fast-worker` | Sonnet | light Claude-side work: taste (user-facing copy, UI tweaks) and session-tool slices (browser QA, MCP evidence); the builder when Codex is unavailable |
| `Explore` | built-in | codebase sweeps where a summary, not the files, should enter your context |

The routing test: a slice you can write as a work order → Codex builds it. A
slice where writing the brief forces decisions → that's design; the decisions
are yours (or `deep-reasoner`'s), and only the frozen spec gets delegated.

Never leaves Claude's hands, whatever the budget:

- design, API shape, naming, UX judgment — anything where taste is the work
- destructive or outward ops (pushes, releases, GitHub mutations) — yours alone
- slices needing session tools (MCP, browser, secrets) — Claude-side, but a
  delegate's hands, not yours: brief `fast-worker` to gather the evidence
- judgment on a builder's output — never delegated, never skipped; the
  evidence-gathering behind that judgment is freely delegated

Transport:

- Codex, two ways in: the plugin (`Agent` with
  `subagent_type: "codex:codex-rescue"`, `run_in_background: true` for long
  jobs) for delegated tasks and reviews — it keeps session state, so follow-ups
  resume instead of restarting; raw `codex exec` for one-shot self-contained
  prompts. Embed routing flags in the rescue prompt: `--resume` to continue its
  last thread (this is how you answer an objection or iterate a failure),
  `--effort high|xhigh` only for a genuinely hard slice — model and effort
  otherwise stay unset. Background jobs are trackable via the companion's
  `status`/`result`/`cancel`. Mechanics for exec, reviews, and job tracking:
  `references/codex-exec.md`. No Codex at all → `fast-worker` builds, and say
  so. For a real back-and-forth collaboration, escalate to `agents-pair`.
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
   files, or give each writer its own worktree (`isolation: "worktree"`) when
   slices overlap. Done when every slice is out with its brief complete.
4. **Verify.** A delegate's report is not ground truth. Write work: read the
   diff like a contributor PR and re-run the receipts — tests and scripts are
   cheap, textual proof, and a builder's claims are advisory until you've seen
   it. Interactive QA (browser, GUI) is not lead work: brief a delegate to
   gather the observations, then judge the evidence. Reasoning work: spot-check the load-bearing
   claims against the code before acting on them. An objection from a builder
   is a result, not a failure: judge it on evidence — fix the plan and
   re-dispatch if it's right, answer it once via resume if it's not; a
   disagreement that survives a round isn't the builder's to settle — take it
   to the panel or `agents-pair`. Iterate failures back to the same delegate
   (resume beats a fresh run); after two failed rounds, stop paying the relay
   tax — take the slice over or re-route it. After you've signed a substantial
   diff, a Codex `review` — or `adversarial-review` to challenge the approach
   itself — is a cheap extra lens from the flat-rate pool; weigh its findings,
   the signature stays yours. Done when you would sign each result yourself.
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
If the spec conflicts with what you find, stop and object with evidence —
don't build around it, don't silently comply.
Return a concise conclusion I can act on — decisions and evidence, not a transcript.
```

Builders don't get a vote on the design, but any builder can stop the line —
the objection clause is load-bearing, keep it in every build brief. For a large
or risky slice, also make the work order's first step a spec check (verify the
brief's assumptions against the repo, object before writing): an objection
costs a read; a wrong build costs the slice.

A build slice's proof is its tests — they're how you sign the work without
re-deriving it. New behavior ships with tests you can run; a bug fix starts
from a failing repro test and returns it green — red → green is the receipt.
Point Claude-side builders at the `tdd` skill; Codex briefs carry red → green
in Validation, since raw exec can't read skills. Where tests don't apply
(renames, docs, config), Validation names the proof instead — a grep, a
build, a type check. Prefer scripted proof — a test, a Playwright flow, a curl
check — over manual QA: a script is a receipt anyone re-runs cheaply;
screenshots through your own context are the expensive way to know.

## The panel — high-stakes decisions

When a decision is expensive to reverse — architecture, data model, migration
strategy — convene a blind panel: the same brief to `deep-reasoner` and Codex in
parallel, neither seeing the other's answer. Blind matters: showing one the
other's take buys you an echo, not a second opinion. Two strong models from
different lineages fail differently; synthesize the best of both and report
genuine splits to the user as open questions, not averages. No Codex available →
fill the second seat with a different model than the first (two runs of the same
delegate share failure modes), and name the substitution in your report.

## Shared plan (long goals)

For a goal that spans checkpoints or sessions, track it with
`planning-with-files` — that skill owns the `task_plan.md` / `findings.md` /
`progress.md` contract and its recovery behavior. delegate adds only the
orchestration delta:

- You are the single writer of `task_plan.md` and `progress.md`; delegates
  never touch them. Record a slice's checkpoint when you've verified it, not
  when the delegate claims it.
- A slice that discovers things writes its own findings file, named in its
  brief and inside its write lease (`findings/<slice>.md`) — parallel delegates
  never contend on `findings.md`. You own `findings.md` like the other two: at
  each verified checkpoint, roll the slice's key findings (or a pointer to its
  file) into it, so the contract's three files stay the complete record a
  resumed session reads. Later briefs point at findings files instead of
  restating them.
- Skip the files for a one-sitting run — the plan text in your dispatch message
  is the record. On long runs they double as live visibility: the user watches
  `task_plan.md` tick instead of watching panes.

## Stay lean

The failure mode of a lead is drifting back into IC work.

- Don't read files to write a brief — name them and let the delegate read.
- Don't re-derive a delegate's work to feel sure — verify it (diff, tests,
  spot-checks) instead. And don't re-read what a delegate already summarized.
- Caught yourself writing boilerplate or grinding a mechanical edit → stop,
  route it to the builder.
- Caught yourself clicking through a browser or reading screenshots → that's
  evidence-gathering; brief a delegate.
- Keep conclusions; drop transcripts.

## Setup

Everything above degrades gracefully with no setup. To pin the roster —
`deep-reasoner`, `fast-worker`, the codex plugin, the companion skills (`tdd`,
`planning-with-files`), orchestrator model and effort — read
`references/setup.md` when the user asks for setup, or mention it once at the
end of a run where you had to fall back.
