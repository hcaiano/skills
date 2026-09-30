---
name: debug-mode
description: "Diagnose or debug a broken, failing, flaky, slow, or production-only bug with a red feedback loop and runtime evidence. Use when the user says diagnose/debug or reports something broken."
argument-hint: "[description of the bug]"
---

# Debug Mode

Fix only a proven cause; a plausible fix that passes once proves nothing.
Already inside a debug-mode run → continue the loop.

Respect the user's verb: `diagnose` ends before **Fix** and changes no code.
`debug`, or a bug report with no verb, runs through **Fix**.

## Workflow

1. **Understand.** Done when symptoms, affected surface, expected behavior,
   actual behavior, and a reproduction path are known.
2. **Red loop.** Build one command that drives the bug's code path and asserts
   its exact symptom: a failing test, a curl script, a CLI run on a fixture, a
   headless-browser script, a replayed trace. Make it tight: deterministic,
   fast, runnable unattended, asserting the symptom rather than "didn't
   crash". For a flaky bug, raise the reproduction rate (loop the trigger, add
   stress) until it is debuggable. For slow code, the loop is a baseline
   measurement (timing harness, profiler, query plan, production traces) that
   goes red above a stated threshold. When no command is practical
   (auth-walled, user-specific, production-only), say so and rely on
   instrumentation in steps 5-6. Done when the command has run red on this
   bug, or its absence is stated.
3. **Minimize.** Shrink the repro one cut at a time (inputs, callers, config,
   data, steps), rerunning the loop after each cut. Done when every remaining
   part matters: removing any one turns the loop green.
4. **Hypothesize.** Done when 2-3 ranked hypotheses each name the observation
   that would confirm or reject it.
5. **Instrument.** For slow code, profile the minimized repro or bisect
   between known-good and known-bad states (`git bisect run` with the loop).
   Otherwise add temporary [logs](#logs). Done when the observations
   distinguish the hypotheses without leaking secrets or changing the
   behavior; if they change it, observe from a less invasive point.
6. **Reproduce.** Done when the bug has been triggered and the evidence
   collected, through the loop when one exists. If the flow is auth-walled or
   user-specific, ask the user to reproduce and wait.
7. **Analyze.** Done when evidence confirms one hypothesis or rejects every
   current one explicitly. When it rejects them all, write new hypotheses from
   the evidence and return to step 5.
8. **Fix.** When a seam exercises the real bug pattern, turn the minimized
   repro into a regression test first. Done when the smallest evidence-backed
   fix is applied, the loop (when one exists) has gone green on the original
   scenario, and every temporary log is removed.

## Logs

- Write structured events through the app's own logger or a local file:
  `hypothesis_id`, `event`, a request or session id that ties one user action
  together, the observed values, and a timestamp.
- Tag every temporary log with one unique prefix (e.g. `[DEBUG-a4f2]`), so
  removal is a single grep.

## Report Format

End with this shape:

```markdown
## Symptoms
## Hypotheses Tested
## Evidence Collected
## Confirmed Root Cause
## Fix Applied
## Instrumentation Removed
## Residual Risk
```

If no fix was applied, say that under `Fix Applied` and name the missing evidence.
