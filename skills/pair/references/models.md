# Model choices

Read this reference when choosing a partner model, effort, or pool. It is a
small decision rubric; the CLIs and their live catalogs remain the source of
truth for names and accepted values.

## Rubric

Choose in this order:

- **Risk**: use a stronger model and effort for irreversible decisions,
  cross-layer changes, unfamiliar code, or a failure whose recovery is costly.
- **Context**: use a model and context window that can hold the repository,
  protocol history, and required evidence. Split the task when the context
  would otherwise become a hidden constraint.
- **Speed**: use a faster model or lower effort for a closed, mechanical task
  with a short proof. Speed never lowers the proof required for the task.
- **Pool**: use the pool that has headroom and the CLI the user chose. Pool
  balance breaks a tie; it does not override risk or context.

`CLI default` is a valid model choice. Do not infer quality, safety, or speed
from a vendor label. Use the model's live catalog when the user wants options:

```bash
cursor-agent --list-models
grok models
```

Claude and Codex can use their CLI defaults; name a model only when the user
chooses one or the task requires a documented model setting.

## Effort

Effort describes the reasoning budget, not the model's identity:

- **Claude**: `low` for mechanical work, `medium` for normal work, `high` for
  broad or risky work, `xhigh` for very hard work, and `max` only after an
  `xhigh` attempt still meets the same very-hard criterion. Claude Code accepts
  `--effort low|medium|high|xhigh|max`.
- **Codex**: use `low` for mechanical work, `high` for thinking work, and
  `xhigh` for very hard work. Do not set `medium` in a pair spawn: the Codex
  CLI default is medium, so pair spawns set effort explicitly.
- **Cursor**: use the model's supported effort values in its
  `[effort=…]` suffix; use low for mechanical work, medium for normal work,
  high for broad or risky work, and xhigh only for very hard work.
- **Grok**: use the values shown by `grok --help` with `--reasoning-effort`;
  use low for mechanical work, medium for normal work, and high for broad or
  risky work. Raise effort only when risk or context requires it.

Leave effort unset only for a CLI whose default the user explicitly chooses.
Codex pair spawns set `low`, `high`, or `xhigh` explicitly; `medium` remains
the Codex CLI default, not a pair effort choice. The pair records the choice in
session state and passes it through the backend's per-CLI mapping.

## Optional usage evidence

When the sibling helper exists, usage evidence covers only the Claude and Codex
pools:

```bash
node "$SKILL_DIR/../orchestrate/scripts/usage-state.mjs"
```

Use its output as a tie-breaker. If the helper or either pool's source is
unavailable, omit usage evidence and continue with risk, context, and speed;
pair startup stays quiet.
