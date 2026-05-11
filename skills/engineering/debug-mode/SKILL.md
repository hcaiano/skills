---
name: debug-mode
description: "Hypothesis-driven debugging with runtime evidence. Use for unresolved bugs, unexpected behavior, flaky runtime issues, production/local reproduction gaps, and vague reports like 'it's broken', 'not working', 'getting an error', or 'why is this happening'. Do not use when the root cause and fix are already obvious. Instruments code with structured logging, collects reproduction data, then confirms or rejects hypotheses before attempting any fix."
user-invocable: true
argument-hint: "[description of the bug]"
---

# Debug Mode

Debug mode is for bugs where the root cause is not yet proven. The point is to avoid plausible fixes that only happen to pass once.

## Workflow

1. **Understand** - gather symptoms, affected surface, expected behavior, actual behavior, and the smallest reproduction path.
2. **Hypothesize** - write 2-3 ranked hypotheses with a concrete observation that would confirm or reject each one.
3. **Instrument** - add temporary structured logging at the decision points that distinguish the hypotheses.
4. **Reproduce** - trigger the bug and collect logs. If the flow is auth-walled or user-specific, ask the user to reproduce and wait.
5. **Analyze** - compare the logs against the hypotheses. Reject hypotheses explicitly when evidence disproves them.
6. **Fix** - only after evidence identifies the root cause. Make the smallest fix and remove all temporary instrumentation.

## Instrumentation Contract

Prefer structured events over prose logs. Each event should include enough context to tie one request or user action together without leaking secrets:

```json
{
  "hypothesis_id": "H1",
  "event": "branch_selected",
  "request_id": "req_123",
  "session_id": "optional-session",
  "observed": { "key": "value" },
  "timestamp": "2026-05-11T15:00:00Z"
}
```

Use `scripts/debug-server.py` when a local HTTP collector is useful:

```bash
python3 <skill-dir>/scripts/debug-server.py --port 8765 --output /tmp/debug-events.jsonl
```

The server accepts `POST /log` with a JSON body and writes JSONL. Confirm it is listening before adding app-side logging. Stop it after analysis, remove all instrumentation, and keep only the evidence summary in the final report.

If the app cannot reach localhost, write structured logs to the app's normal logger or a temporary local file instead. Keep the same fields so analysis stays comparable.

## Failure Modes

- **Cannot reproduce locally:** identify the missing condition, add targeted instrumentation, and ask the user to reproduce once.
- **Auth-walled reproduction:** prepare logging first, then wait for the user instead of guessing.
- **User cannot reproduce:** report the best-tested hypotheses and what evidence is still missing; do not invent a fix.
- **Logs disprove every hypothesis:** write new hypotheses from the evidence and instrument again.
- **Instrumentation changes behavior:** remove or reduce the instrumentation, then use a less invasive observation point.

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
