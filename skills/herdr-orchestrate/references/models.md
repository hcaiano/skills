# Model table and staffing rules

Reference for phase 2 grading: which model(s) implement a unit, solo or
paired. Last calibrated 2026-07-24, Opus 5 launch day (CursorBench 3.2,
Frontier-Bench v0.1, OSWorld 2.0, Design Arena; Opus 5 numbers are
launch-announcement claims — firm them up when independent benches land).
Recalibrate when a model generation lands.

## Models

Two independent weekly-usage pools: Claude and Codex. Ratings 1–10, higher =
better. Intelligence = how hard a problem the model takes unsupervised.
Taste = UI/UX, code quality, API design, copy.

| model | pool | `herdr agent start` args | intelligence | taste | notes |
|---|---|---|---|---|---|
| fable-5 | Claude | `--kind claude -- --model fable --effort <tier>` | 10 | 9 | Reserved. Orchestrator by default; implements only a unit that truly needs maximum intelligence (e.g. fable + sol pair on critical work). Delegates consult it as oracle instead: Claude via its `oracle` subagent, Codex via `ask-peer`. |
| gpt-5.6-sol | Codex | `--kind codex -- -c model="gpt-5.6-sol" -c model_reasoning_effort="<tier>"` | 9.5 | 8.5 | Codex-pool workhorse, opus-5's intelligence peer. Fastest terminal/agentic work and best visual design (#1 Design Arena); highest measured reward-hacking rate of any public model — its output ships only through the ship-it gate plus the orchestrator's scope checks. |
| opus-5 | Claude | `--kind claude -- --model opus --effort <tier>` | 9.5 | 8 | Claude-pool workhorse. Within 0.5% of fable's peak (CursorBench 3.2 at `max`) at half fable's price; early reports emphasize verify-and-iterate reliability on long unsupervised runs. No `medium` effort tier (low/high/xhigh/max) — run a `medium`-graded unit at `high`. Verify `--model opus` resolves to Opus 5 in the start banner; if it still points at 4.8, pin `--model claude-opus-5`. Taste provisional: no Design Arena data yet. |
| sonnet-5 | Claude | `--kind claude -- --model sonnet --effort <tier>` | 7.5 | 7 | Fast lane; unusually strong on terminal loops. |
| gpt-5.6-terra | Codex | `--kind codex -- -c model="gpt-5.6-terra" -c model_reasoning_effort="<tier>"` | 7 | 6.5 | Fast lane; best value for supervised mechanical work. |

## Selection rules

- **Workhorses.** Nearly every unit gets opus-5 or sol — intelligence
  peers, so pool balance breaks the tie. Sol keeps the edge on UI/visual
  work (#1 Design Arena) and raw terminal speed; opus-5 is the pick for
  long unsupervised runs (verify-and-iterate profile vs sol's
  reward-hacking record) and deep multi-file repo work.
- **Fable, sparingly — more than ever.** Opus-5 sits within 0.5% of
  fable's peak at half the cost, so fable as implementer is reserved for
  the rare unit where that last half-percent matters and failure is very
  expensive (typically paired with sol). Everything else reaches fable
  through the oracle channel instead.
- **Fast lane (rare).** A trivial mechanical unit may go to terra or sonnet
  at `low`; sol at `low`/`medium` or opus-5 at `low` are also fast — prefer
  them when in doubt.
- **Defaults, not limits.** Standing permission to escalate: when a cheaper
  model's output misses the bar — at any checkpoint — send
  the work back or redo it on a smarter model without asking. Judge the
  output, not the price. When axes conflict for anything that ships,
  intelligence > taste > cost — cost breaks ties only; use cheap models to
  scout and try things before the expensive model acts, never to under-staff
  shipping work.
- **Pair composition.** A pair is always cross-pool — one Claude + one Codex
  model, normally opus-5 + sol — halving the load on each weekly pool and
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
- Both pools out → the both-pools-exhausted rule above: queue the unit. A
  genuinely urgent unit that runs anyway takes a single review on
  whichever harness still responds when tried (prefer the pool its lead
  did not implement on); if neither responds, the unit's merge policy
  becomes `hold` — it stops at shipped for the user's own review.

A degraded gate is a capacity decision, not a quality discount — the
orchestrator's scope checks (ready, ship delta) still run in full.
Name the graded gate in the kickoff and in the phase 4 summary, and check
the shipped receipt against it: a `codex-only` receipt with one review is
complete for that unit.
