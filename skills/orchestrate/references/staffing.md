# Staffing

Read this reference before each unit wave and each restaff. Pair's
[`models.md`](../../pair/references/models.md) owns the model-choice rubric and
the Roster subsections Operational preferences, Seats por papel, Pace and
fallback, and Effort. This file owns arena floors, capacity evidence, and the
orchestration decision record. Last calibrated 2026-08-23.

## Decide

Match model intelligence to task difficulty. Apply the roster before these
arena floors. When two legal choices meet the same tier and bar, use Taste;
when both tie, use lower pool pace, lower used percentage, then speed. Choose
effort on the Roster's Seats por papel and Effort subsections. The current
orchestrator CLI is not a legal partner; pair refuses same-CLI pairing.

Direct unit partners have this floor:

| arena | normal lane | hard lane | excluded direct lane |
|---|---|---|---|
| Claude | `claude-opus-5` for UI/design units; general/back-end units prefer the Codex or Grok arenas per the Roster | `claude-opus-5` for UI/design units; general/back-end units prefer the Codex or Grok arenas per the Roster | `claude-fable-5`; advisor and orchestrator only—it plans, it does not run units |
| Codex | `gpt-5.6-sol`; `gpt-5.6-luna` is the B-tier fallback when it meets the task bar | `gpt-5.6-sol` | `gpt-5.6-terra`; Luna is excluded from hard and UI lanes |
| Cursor | a current Roster seat with evidence for the task | the strongest current Roster seat justified by risk and context | undocumented names |
| Grok | a current Roster seat with evidence for the task | the strongest current Roster seat justified by risk and context | undocumented names |
| OpenCode | a current Roster seat with evidence for the task | the strongest current Roster seat justified by risk and context | undocumented names |

The floor table restricts orchestration roles; it does not create another
roster.

## Read capacity

Run:

```bash
node <orchestrate-dir>/scripts/usage-state.mjs
```

It reports Claude and Codex weekly use plus both monthly Cursor pools, with
pace, time to reset, and snapshot age. Apply the available, protected, and
unavailable classification in Pair's `models.md`. A null pool is unavailable
evidence, not a reason to degrade a choice. A stale snapshot is a floor: when it
already shows `pace > 1` or `used_percent >= 90`, act on that state. Use a
same-bar fallback before a new unit consumes a protected or unavailable pool.
Pool state never changes the required intelligence or proof; if no fallback
meets the bar, report the unit blocked to the user.

For Cursor, apply the roster's catalog refresh and map the selected model to
`cursor.cursor_models` or `cursor.other_models` before staffing. Grok outside
Cursor and OpenCode still use a successful CLI start as availability evidence.
A refusal restaffs the unit.

On a machine where a headless `cursor-agent` run proves that shell commands are
rejected, treat Cursor as a consult and read-only review arena. It cannot own a
unit that must validate or commit. This limit is machine- and backend-specific:
a Cursor pane on the Herdr backend keeps its own permission plumbing and is
eligible for implementation when its live checks succeed.

## Record and restaff

Every unit record names partner, model (or `CLI default`), effort, timestamp,
and one-line reason. The reason states:

1. task difficulty and context;
2. why the model meets that bar;
3. the compared roster tiers and Taste when either breaks the tie;
4. the pool, pace, used percentage, or speed tie-break, if one decided the arena;
5. the current-harness exclusion when it removed the preferred arena.

Restaff before a new unit or correction cycle uses a protected pool, and
immediately on refusal or rate limit. Keep feedback that is already in flight on
the existing pair; a new bounded correction is a new capacity decision. Restaff
after a proved capability miss, preserving the HEAD, diff, and receipt
checkpoint in staffing history. If no legal arena meets the bar, report the
unit blocked to the user.
