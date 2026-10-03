---
name: t3-capacity
description: "Check account usage and pace before assigning T3 work or after a usage limit."
---

Use `orchestrator_capabilities` for instance IDs and drivers. With `pair`
installed beside this skill, run:

```bash
node "$SKILL_DIR/scripts/t3-capacity.mjs" \
  --settings <server-settings.json> \
  --instance <id>:<driver> [--instance ...]
```

Use confirmed settings for the server running this shell, or omit
`--settings`. Follow mapping notes; `--declare` needs a user-stated mapping.

Summarize usage, pace, resets and states for all accounts. Pace above 1
risks exhaustion before reset. Unknown capacity proves no headroom.
