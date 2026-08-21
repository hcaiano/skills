# Staffing

Read this reference before each unit wave and each restaff. Pair's
[`models.md`](../../pair/references/models.md) owns the generic
risk/context/speed/pool rubric and CLI effort syntax. This file owns the current
orchestration roster and the decision record. Last calibrated 2026-08-19.

## Decide

Match model intelligence to task difficulty. When two legal choices meet the
same bar, use pool headroom first and speed second. Choose effort separately on
pair's per-CLI ladder. The current orchestrator CLI is not a legal partner;
pair refuses same-CLI pairing.

Direct unit partners have this floor:

| arena | normal lane | hard lane | excluded direct lane |
|---|---|---|---|
| Claude | `sonnet-5` | `opus-5` | Haiku; Fable is advisor-only |
| Codex | `gpt-5.6-terra` | `gpt-5.6-sol` | Luna |
| Cursor | a supported live-catalog model with evidence for the task | the strongest supported live-catalog model justified by risk/context | undocumented names |
| Grok | a supported live-catalog model with evidence for the task | the strongest supported live-catalog model justified by risk/context | undocumented names |
| OpenCode | a supported live-catalog model with evidence for the task | the strongest supported live-catalog model justified by risk/context | undocumented names |

Use `CLI default` when no named model has better evidence. Do not infer quality,
speed, or safety from a vendor label. Run live catalogs once per wave when
Cursor, Grok, or OpenCode is a candidate:

```bash
cursor-agent --list-models
grok models
opencode models
```

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

Cursor, Grok, and OpenCode have no usage-state source here. Their successful
live catalog and CLI start are availability evidence; a refusal restaffs the
unit.
For Cursor, choose an effort-specific name exactly as the live catalog prints
it and omit `--effort`; the name is the recorded effort control.

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
3. the pool or speed tie-break, if one decided the arena;
4. the current-harness exclusion when it removed the preferred arena.

Restaff immediately on refusal or rate limit. Keep normal scope feedback and
one bounded correction on the existing pair. Restaff after a proved capability
miss, preserving the HEAD, diff, and receipt checkpoint in staffing history.
If no legal arena meets the bar, report the unit blocked to the user.
