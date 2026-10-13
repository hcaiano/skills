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
candidate, so preference outranks pace. One exception: when that tier's best
candidate is protected and the next tier's best is available or burns at a
lower pace, `choice` is the next tier's, so an account above pace hands work
one tier down, never further.
A null `choice` is a capacity blocker: report it, never guess.

To resolve a configured role, save `orchestrator_capabilities` as JSON and run:

```bash
node "$SKILL_DIR/scripts/t3-capacity.mjs" \
  --role "bug-fix" --capabilities /tmp/capabilities.json \
  [--models ~/.agents/pstack-models.md]
```

The models file defaults to `~/.agents/pstack-models.md`. Role lines use
`bug-fix: capacity[a > b | c]`. `>` orders preference tiers, `|` groups equal
models, and comma-separated `capacity[...]` entries give one seat each.
Comma-separated role names before the colon share a line. Set effort with
comments such as `# effort high: feature, refactoring, bug-fix` and
`# effort medium: how explorer, why investigators`. Other roles use `xhigh`.
The script expands each model to every serving instance and applies the same
capacity rule per seat. It reads reasoning option keys and supported values
from the catalog, using the highest value at or below the role's effort.
Pass each `seats[].target` to `delegate_task` unchanged. A null target includes
a reason; `rejected` lists missing models, disabled providers, and unsupported
effort options. Role mode cannot be combined with `--candidate`.

Summarize usage, pace, resets and account states. Pace above 1 risks
exhaustion before reset. Unknown capacity proves no headroom. Each account
is read live at most once per two minutes across threads. An account `note`
marks a reading reused, up to 10 minutes old, after a skipped or failed live
read; name it in the summary.
