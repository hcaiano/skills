---
name: t3-capacity
description: "Check account usage and pace before delegating through T3 Code or after a usage limit."
---

Use `orchestrator_capabilities` for instance IDs, drivers and models. Set
`SKILL_DIR` to this skill's directory and run:

```bash
node "$SKILL_DIR/scripts/t3-capacity.mjs" \
  [--candidate <id>/<model>[,<id>/<model>...]]...
```

With no `--instance`, the script reads the recorded mapping in
`~/.agents/t3-capacity.json`. Without that file, pass `--settings` for the
server running this shell and one `--instance <id>:<driver>` per instance.
Follow mapping notes; `--declare` and a recorded declaration need a
user-stated mapping.

To pick a delegate, pass each preference tier as one `--candidate` flag,
listing every instance that serves each model in that tier. Delegate to
`choice`: it comes from the first tier with an available or protected
candidate, so preference outranks pace. A null `choice` is a capacity blocker:
report it, never guess.

Summarize usage, pace, resets and account states. Pace above 1 risks
exhaustion before reset. Unknown capacity proves no headroom. An account
`note` marks a reading reused, up to 10 minutes old, after a failed live read;
name it in the summary.
