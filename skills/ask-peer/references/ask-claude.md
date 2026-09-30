# Ask Claude from Codex

Use the logged-in Claude subscription through `claude -p`; never supply an API
key. Leave `--model` unset so Claude's config picks it; add `--model fable`
only when the user asks for Fable. Set `EFFORT` from the seat in `SKILL.md`.
Check `claude --help` when flags drift.

## Read-only question or review

Write the prompt to a temporary file so shell quoting cannot alter it:

```bash
P=$(mktemp -t ask-claude.XXXXXX)
F=$(mktemp -t ask-claude-result.XXXXXX)
# Write the complete prompt to "$P", then:
claude -p --effort "$EFFORT" --permission-mode dontAsk \
  --tools Read,Grep,Glob --add-dir "$WORKSPACE_ROOT" \
  --output-format json <"$P" >"$F"
```

Read the JSON `result`, and keep its `session_id` only for a follow-up in the
same exchange. Resume from the workspace root with the same `--model` and
`--effort`:

```bash
claude -p --resume "$SESSION_ID" --effort "$EFFORT" \
  --permission-mode dontAsk --tools Read,Grep,Glob \
  --output-format json <"$P" >"$F"
```

## Scoped write pass

Only when the user asked for implementation, replace `dontAsk` with
`bypassPermissions` and drop `--tools`. The prompt names the write lease and
validation. Start a fresh session when the task changes; resume a privileged
session only for the same request.
