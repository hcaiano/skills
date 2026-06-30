---
name: debug-mode
description: "Evidence debugging for unresolved bugs. Use when behavior is broken, flaky, environment-specific, or unexplained and the root cause is not proven. Build hypotheses, collect runtime evidence, and fix only after evidence identifies the cause."
user-invocable: true
argument-hint: "[description of the bug]"
---

# Debug Mode

Use the **evidence loop** when the root cause is not proven. Avoid plausible fixes
that only pass once.

## Workflow

1. **Understand.** Done when symptoms, affected surface, expected behavior,
   actual behavior, and smallest reproduction path are known.
2. **Hypothesize.** Done when 2-3 ranked hypotheses each name the observation
   that would confirm or reject it.
3. **Instrument.** Done when temporary structured logs distinguish the
   hypotheses without leaking secrets.
4. **Reproduce.** Done when the bug has been triggered and logs collected. If the
   flow is auth-walled or user-specific, ask the user to reproduce and wait.
5. **Analyze.** Done when evidence confirms one hypothesis or rejects all current
   hypotheses explicitly.
6. **Fix.** Done when the smallest evidence-backed fix is applied and all
   temporary instrumentation is removed.

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

Use `scripts/debug-server.mjs` when a local HTTP collector is useful:

```bash
node <skill-dir>/scripts/debug-server.mjs --port 8765 --output <debug-events.jsonl>
```

The server accepts `POST /log` with a JSON body and writes JSONL. Confirm it is
listening before adding app-side logging. Stop it after analysis, remove all
instrumentation, and keep only the evidence summary in the final report.

If localhost is unreachable, log to the app's normal logger or a local file with the same fields.

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
