# Model table and staffing rules

Reference for phase 2 grading: which model(s) implement a unit, solo or
paired. Last calibrated 2026-07-23 (SWE-bench Verified/Pro, Terminal-Bench
2.1, Design Arena, LMArena, METR). Recalibrate when a model generation lands
(e.g. Opus 5).

## Models

Two independent weekly-usage pools: Claude and Codex. Ratings 1–10, higher =
better. Intelligence = how hard a problem the model takes unsupervised.
Taste = UI/UX, code quality, API design, copy.

| model | pool | `herdr agent start` args | intelligence | taste | notes |
|---|---|---|---|---|---|
| fable-5 | Claude | `--kind claude -- --model fable --effort <tier>` | 10 | 9 | Reserved. Orchestrator by default; implements only a unit that truly needs maximum intelligence (e.g. fable + sol pair on critical work). Delegates consult it as oracle instead: Claude via its `oracle` subagent, Codex via `ask-peer`. |
| gpt-5.6-sol | Codex | `--kind codex -- -c model="gpt-5.6-sol" -c model_reasoning_effort="<tier>"` | 9.5 | 8.5 | Primary workhorse — closer to fable than to opus. Fastest terminal/agentic work and best visual design (#1 Design Arena); highest measured reward-hacking rate of any public model — its output ships only through review (orchestrator ready-review + ship-it gate). |
| opus-4.8 | Claude | `--kind claude -- --model opus --effort <tier>` | 8.5 | 7.5 | Claude-pool workhorse; not frontier this generation (revisit at Opus 5). Best at deep multi-file repo work (SWE-bench Pro); most trustworthy on long unsupervised runs. |
| sonnet-5 | Claude | `--kind claude -- --model sonnet --effort <tier>` | 7.5 | 7 | Fast lane; unusually strong on terminal loops. |
| gpt-5.6-terra | Codex | `--kind codex -- -c model="gpt-5.6-terra" -c model_reasoning_effort="<tier>"` | 7 | 6.5 | Fast lane; best value for supervised mechanical work. |

## Selection rules

- **Workhorses.** Nearly every unit gets sol or opus. Sol is the
  intelligence pick: anything demanding — hard problems, ambiguous specs,
  UI/visual work — defaults to it. Opus carries the unit when the Claude
  pool has clearly more weekly headroom, when it is the pair's Claude half,
  or when a long unsupervised run rewards its lower reward-hacking profile
  over raw intelligence.
- **Fable, sparingly.** A unit whose failure would be very expensive and
  whose problem is genuinely at the intelligence ceiling may get fable as an
  implementer (typically paired with sol). Everything below that ceiling
  reaches fable through the oracle channel instead.
- **Fast lane (rare).** A trivial mechanical unit may go to terra or sonnet
  at `low`; sol or opus at `low`/`medium` are also fast — prefer them when in
  doubt.
- **Defaults, not limits.** Standing permission to escalate: when a cheaper
  model's output misses the bar — at ready-review or anywhere else — send
  the work back or redo it on a smarter model without asking. Judge the
  output, not the price. When axes conflict for anything that ships,
  intelligence > taste > cost — cost breaks ties only; use cheap models to
  scout and try things before the expensive model acts, never to under-staff
  shipping work.
- **Pair composition.** A pair is always cross-pool — one Claude + one Codex
  model, normally opus + sol — halving the load on each weekly pool and
  keeping two model families in play.

## Weekly usage state

Before grading, run `node scripts/usage-state.mjs` from this skill's
directory. It prints one JSON line with each pool's weekly usage; a null pool
means that source is unavailable — grade without the signal, never guess it:

```json
{"claude":{"used_percent":41,"resets_in_hours":114,"stale_minutes":3},
 "codex":{"used_percent":20,"resets_in_hours":129,"stale_minutes":12}}
```

Sources: Claude — `~/.claude/usage-state.json`, written by the user's
statusline on every active session update; Codex — the newest plan-pool
`rate_limits` snapshot in `~/.codex/sessions`. `stale_minutes` is the
snapshot's age; both windows are 7 days (168 h).

- **Balance the pools.** The target is landing each weekly reset with both
  pools similarly spent — never one exhausted while the other sits on
  headroom. Route discretionary units to the pool burning cooler: compare
  each pool's `used_percent` with how much of its window has elapsed
  (`168 - resets_in_hours` out of 168); ahead of pace = hot, behind = cool.
- A pool close to its reset with headroom left is fuel about to expire —
  drain it first.
- Both pools nearly exhausted → queue non-urgent units until the earlier
  reset (`resets_in_hours` is at most a few days away) rather than degrading
  to the fast lane while the review gate runs on the same empty pools; tell
  the user what queued and until when. Only genuinely urgent work still
  runs, on a workhorse.

## Review gate by pool state

Ship-it's full gate spends both pools — a Claude review plus simplify, and
a Codex review — so grade each unit's **review gate** from the same
usage-state reading as its models:

- `dual` (default) — both pools have headroom: dual review + simplify,
  unchanged.
- `codex-only` — the Claude pool is out of headroom: a single Codex review
  satisfies the gate; Claude simplify and review are skipped.
- `claude-only` — the Codex pool is out of headroom: run Claude simplify,
  then a single Claude code review.
- The one pool a degraded gate leans on is also out → that is the
  both-pools-exhausted case above: queue the unit.

A degraded gate is a capacity decision, not a quality discount — the
orchestrator's own ready-review and ship-delta review still run in full.
Name the graded gate in the kickoff and in the phase 4 summary, and check
the shipped receipt against it: a `codex-only` receipt with one review is
complete for that unit.
