---
name: debug-mode
description: "Hypothesis-driven debugging with runtime evidence. Instruments code with structured HTTP logging to a local debug server, collects runtime data while the user reproduces the bug, then analyzes logs to confirm or reject hypotheses before attempting any fix."
user-invocable: true
argument-hint: "[description of the bug]"
---

# Debug Mode

Hypothesis-driven debugging with runtime evidence. No fixes without root cause.

## When to use

Trigger on: "it's broken", "not working", "getting an error", "why is this happening", "help me debug", "can't figure out why", "unexpected behavior". Do NOT use when root cause is already obvious.

## Workflow

1. **Understand** — gather symptoms, identify affected code paths
2. **Hypothesize** — form 2-3 ranked hypotheses with verification strategies
3. **Instrument** — add structured logging to suspected code paths
4. **Reproduce** — trigger the bug and collect logs. If auth-walled, ask user to reproduce and WAIT
5. **Analyze** — review logs against each hypothesis, confirm/reject with evidence
6. **Fix** — only after root cause confirmed. Minimal fix. Remove all instrumentation.

## Rules
- Iron Law: NO fixes without root cause evidence
- When you can't trigger reproduction yourself, ask the user and WAIT
- Always clean up instrumentation code after debugging
