# Ask Fable from Codex

Use the logged-in Claude subscription through `claude -p`; never supply an API
key. Check `claude --help` when flags drift.

## Read-only question or review

Write the prompt to a temporary file so shell quoting cannot alter it:

```bash
P=$(mktemp -t ask-fable.XXXXXX)
F=$(mktemp -t ask-fable-result.XXXXXX)
# Write the complete prompt to "$P", then:
claude -p --model fable --permission-mode dontAsk \
  --tools Read,Grep,Glob --add-dir "$WORKSPACE_ROOT" \
  --output-format json <"$P" >"$F"
```

Read the JSON result and retain its `session_id` if the same focused exchange
needs one follow-up. Resume from the workspace root:

```bash
claude -p --resume "$SESSION_ID" --model fable \
  --permission-mode dontAsk --tools Read,Grep,Glob \
  --output-format json <"$P" >"$F"
```

## Scoped write pass

Only when the user asked for implementation, replace `dontAsk` with
`bypassPermissions` and omit the read-only tool restriction. The prompt must name
the write lease and validation. Afterwards, inspect `git diff`, touched files, and
actual validation output yourself.

Start a fresh session when the task changes or the prompt must be isolated. Do not
resume a privileged session for an unrelated request.
