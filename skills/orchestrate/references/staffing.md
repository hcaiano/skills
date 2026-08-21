# Staffing

Read this reference before each unit wave and each restaff. Pair's
[`models.md`](../../pair/references/models.md) owns the model-choice rubric and
the Roster subsections Seats por papel, Dimension scores, Pace and fallback,
and Effort. This file owns arena floors, capacity evidence, and the
orchestration decision record. Last calibrated 2026-08-21.

## Decide

Match model intelligence to task difficulty. Apply the roster before these
arena floors. When two legal choices meet the same bar, use its Taste score;
when scores tie, use pool headroom first and speed second. Choose effort on the
Roster's Seats por papel and Effort subsections. The current orchestrator CLI
is not a legal partner; pair refuses same-CLI pairing.

Direct unit partners have this floor:

| arena | normal lane | hard lane | excluded direct lane |
|---|---|---|---|
| Claude | `sonnet-5` | `opus-5` | Haiku; Fable is advisor-only |
| Codex | `gpt-5.6-terra` | `gpt-5.6-sol` | Luna |
| Cursor | a supported live-catalog model with evidence for the task | the strongest supported live-catalog model justified by risk/context | undocumented names |
| Grok | a supported live-catalog model with evidence for the task | the strongest supported live-catalog model justified by risk/context | undocumented names |
| OpenCode | a supported live-catalog model with evidence for the task | the strongest supported live-catalog model justified by risk/context | undocumented names |

Use the roster's current-seat rules and live-catalog commands. The floor table
restricts orchestration roles; it does not create another roster.

## Read capacity

Run:

```bash
node <orchestrate-dir>/scripts/usage-state.mjs
```

It reports Claude and Codex weekly use, pace, time to reset, burst state, and
snapshot age. A null pool is unavailable evidence, not a reason to degrade a
choice. Treat `used_percent >= 90`, a live refusal, or a rate-limit response as
out of headroom. A stale snapshot is a floor, not a current reading. Pool
headroom breaks a tie between models that both meet the task bar; it never
changes the required intelligence or proof.

Cursor, Grok, and OpenCode have no usage-state source here. Apply the roster's
catalog refresh, then use a successful CLI start as availability evidence. A
refusal restaffs the unit.

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
3. the compared roster Taste scores when a score breaks the tie;
4. the pool or speed tie-break, if one decided the arena;
5. the current-harness exclusion when it removed the preferred arena.

Restaff immediately on refusal or rate limit. Keep normal scope feedback and
one bounded correction on the existing pair. Restaff after a proved capability
miss, preserving the HEAD, diff, and receipt checkpoint in staffing history.
If no legal arena meets the bar, report the unit blocked to the user.
