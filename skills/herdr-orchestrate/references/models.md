# Model table and staffing rules

Reference for phase 2 grading: which model(s) implement a unit, solo or
paired. Last calibrated 2026-07-30 (Artificial Analysis latency + Coding
Agent Index, METR reward-hacking report, Terminal-Bench 2.1, ARC-AGI-3;
most Opus 5 benches remain self-reported — ARC-AGI-3 is independently
verified). Recalibrate when a model generation lands.

## Models

Two independent weekly-usage pools: Claude and Codex. Ratings 1–10, higher =
better. Intelligence = how hard a problem the model takes unsupervised.
Taste = UI/UX, code quality, API design, copy. Speed = throughput + time to
first token (AA, at the tier named).

| model | pool | `herdr agent start` args | intelligence | taste | speed | notes |
|---|---|---|---|---|---|---|
| fable-5 | Claude | `--kind claude -- --model fable --effort <tier>` | 10 | 9 | slow | Reserved. Orchestrator by default; implements only a unit that truly needs maximum intelligence (e.g. fable + sol pair on critical work). Delegates consult it as oracle instead: Claude via its `oracle` subagent, Codex via `ask-peer`. |
| opus-5 | Claude | `--kind claude -- --model opus --effort <tier>` | 9.5 | 8 | slow (53 tok/s; TTFT 68 s at `max`) | Claude-pool workhorse for hard units: long unsupervised runs, deep multi-file repo work. #1 AA Intelligence + Agentic Index; ARC-AGI-3 30.2% (verified, ~4× sol). Latency makes it expensive in wall-clock for small units — grade those to the fast lane. No `medium` effort (low/high/xhigh/max) — run a `medium` unit at `high`. Verify `--model opus` resolves to Opus 5 in the start banner; if it still points at 4.8, pin `--model claude-opus-5`. Taste provisional (no Design Arena read yet). |
| gpt-5.6-sol | Codex | `--kind codex -- -c model="gpt-5.6-sol" -c model_reasoning_effort="<tier>"` | 9.5 | 8 | medium (61 tok/s; TTFT 4.6 s `medium`, 10.8 s `high`) | Codex-pool workhorse for genuinely hard work: big multi-file refactors, architecture. Reward-hacking confirmed worst of any public model (METR 55.4% gaming; Hugging Face incident, Jul 2026) — ships only through the ship-it gate plus scope checks, and never runs long unsupervised (that class is opus-5's). Former "#1 Design Arena" edge no longer supported by the current board — check the live board before using taste as a tie-break. |
| gpt-5.6-terra | Codex | `--kind codex -- -c model="gpt-5.6-terra" -c model_reasoning_effort="<tier>"` | 8 | 6.5 | fast (~120 tok/s; TTFT 1.3 s `medium` — ~2× sol) | Codex-pool fast lane. AA Coding Agent Index 77.4 vs sol's 80. Enough for scoped refactors, tests, simple UI, triage, first-pass review — when speed is the point (selection rules). |
| sonnet-5 | Claude | `--kind claude -- --model sonnet --effort <tier>` | 8 | 7 | fast | Claude-pool fast lane, terra's peer for pool balance. Terminal-Bench 2.1 80.4% (~Opus 4.8 level); SWE-bench Pro 63.2%; 1M context. Weak taste outside code. |

sonnet-5 and terra are the floor: weaker tiers (haiku, luna) stay out of the
roster by the user's standing decision — prefer available intelligence over
squeezing cheaper models.

## Selection rules

- **Frontier by default.** The great majority of units go to opus-5 or
  sol — autonomous work has to come out right the first time, and quality
  is what makes the autonomy safe. Pool balance breaks the tie; opus-5
  takes deep multi-file work and long unsupervised runs (sol never runs
  those), sol takes big refactors and architecture.
- **Fast lane when speed is the point.** terra or sonnet-5 at `medium` for
  the genuinely mechanical or latency-sensitive unit — a closed-spec
  trivial change where the wait would cost more than the intelligence
  buys (terra starts ~50× faster than opus-5 at `max`). The review gate
  and the escalation rule are the net.
- **Fable, sparingly.** Reserved for the rare unit where the last
  half-percent matters and failure is very expensive (typically paired
  with sol). Everything else reaches fable through the oracle channel.
- **Defaults, not limits.** Standing permission to escalate: when a cheaper
  model's output misses the bar — at any checkpoint — send
  the work back or redo it on a smarter model without asking. Judge the
  output, not the price. When axes conflict for anything that ships,
  intelligence > taste > cost — cost breaks ties only.
- **Pair composition.** A pair is always cross-pool — one Claude + one Codex
  model, normally opus-5 + sol — halving the load on each weekly pool and
  keeping two model families in play.
- **Effort follows the same ladder.** `high` is the working default for
  anything minimally difficult; `medium` when turnaround matters more than
  depth; `low` for mechanical diffs; `xhigh` only when correctness
  outranks turnaround; `max` close to never (only after an `xhigh`
  escalation failed) — TTFT scales hard with effort (terra: 1.3 s
  `medium` → 19 s `xhigh` → 155 s `max`; sol `max`: 131 s). The
  orchestrator grades each unit on its own judgment.

## Weekly usage state

Before grading, run `node scripts/usage-state.mjs` from this skill's
directory, and again before each later wave. It prints one JSON line per
pool; a null pool means that source is unavailable — grade without the
signal, never guess it:

```json
{"claude":{"used_percent":49,"elapsed_hours":31,"resets_in_hours":137,"days_left":5.72,
  "burn_per_day":38.4,"budget_per_day":8.9,"pace":4.3,"days_to_empty":1.3,
  "short_window":{"used_percent":30,"resets_in_hours":2.2},"stale_minutes":0},
 "codex":{"used_percent":7,"elapsed_hours":5,"resets_in_hours":163,"days_left":6.77,
  "burn_per_day":null,"budget_per_day":13.7,"pace":null,"days_to_empty":null,
  "short_window":null,"stale_minutes":0}}
```

Sources: Claude — `~/.claude/usage-state.json`, written by the user's
statusline on every active session update; Codex — the newest plan-pool
`rate_limits` snapshot in `~/.codex/sessions`. Both weekly windows are 168 h
but they open on different days, so the raw percentages are not comparable.

- **`pace` is the fuel gauge, not `used_percent`** — points/day spent so far
  over points/day the rest of the window can still fund. A pool at 45% at
  pace 3.8 holds ~1.5 days of fuel; a pool at 70% at pace 0.8 lasts to its
  reset. `days_to_empty` is the same reading in days: the number to quote to
  the user. The target is landing both pools near pace 1 at their resets.
- **The orchestrator spends the Claude pool too** — its own turns, its
  Claude implementers, and every Claude review — so Claude burns hotter than
  the unit split suggests.
- **Act on the pace**, in this order:
  - both pools at 1.2 or under — grade normally; usage is not a constraint.
  - one pool above 1.2 — staff this wave from the other pool, workhorse
    models unchanged; only a unit that needs the hot pool's specific model
    (sol for visual work, opus-5 for a long unsupervised run) still takes it.
  - both above 1.2 — tighten the wave before touching model quality: solo
    instead of pair (a pair spends both pools), fast lane for the units that
    qualify, workhorses for the rest.
  - both above 2 with `days_to_empty` under 2 — run only urgent units and
    queue the rest until the earlier reset.
- **An out-of-headroom pool takes nothing new**, whatever its pace says
  (defined in the gate section below). Both out of headroom queues
  non-urgent units until the earlier reset, however cool their pace reads.
- **`pace: null`** — no measurable rate: the window is under 12 h old, under
  6 h from reset, or fully spent. Apply the headroom rule first, then staff
  from the null-pace pool when the measured one is above 1.2, grade normally
  when it is not, and with both null prefer the lower `used_percent`.
- **Expiring fuel.** A pool with `days_left` at or under 1.5, pace under 1,
  and real headroom left loses what it does not spend — drain it first. This
  is the one case that outranks routing away from the hotter pool; above
  pace 1 the fuel is already spoken for, so the routing ladder holds.
- **`stale_minutes` over ~180** means that pool has not run recently and
  reads cooler than it is; treat its `used_percent` as a floor. A pool whose
  window reset since its snapshot reads `null` — the script drops it rather
  than reporting a window with no time left.
- **`short_window`** is the pool's burst limit. At 80% or higher, a new agent
  on that pool can stall or rate-limit at start — stagger the wave's kickoffs
  or start it on the other pool.

## Review gate by pool state

Ship-it's full gate spends both pools — a Claude review plus simplify, and
a Codex review — so grade each unit's **review gate** from the same
usage-state reading as its models. A pool is **out of headroom** when its
`used_percent` is 90 or higher, or its CLI is observed refusing or
rate-limiting at start; a null pool never degrades the gate by itself —
degrade on evidence, not absence of signal:

- `dual` (default) — both pools have headroom: dual review + simplify,
  unchanged.
- `codex-only` — the Claude pool is out of headroom: a single Codex review
  satisfies the gate; Claude simplify and review are skipped.
- `claude-only` — the Codex pool is out of headroom: run Claude simplify,
  then a single Claude code review.
- Both pools out → queue the unit, per the out-of-headroom rule above. A
  genuinely urgent unit that runs anyway takes a single review on
  whichever harness still responds when tried (prefer the pool its lead
  did not implement on); if neither responds, the unit's merge policy
  becomes `hold` — it stops at shipped for the user's own review.

Pace alone never drops a review: a pool burning hot but still under 90%
throttles how many units run and which pool staffs them (ship-it trims its
simplify pass on the same signal). A degraded gate is a capacity decision,
not a quality discount — the orchestrator's scope checks (ready, ship delta)
still run in full.
Name the graded gate in the kickoff and in the phase 4 summary, and check
the shipped receipt against it: a `codex-only` receipt with one review is
complete for that unit.
