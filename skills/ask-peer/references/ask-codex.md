# Ask Codex from Claude

Drive the local Codex CLI directly. Leave `-m` unset when Codex's configured
model is a Sol model (see `SKILL.md`); pass `-m <id>` for a model the user
named. Set `EFFORT` from the seat in `SKILL.md` (`high` for a review). Check
`codex exec --help` when flags drift.

## Read-only question or review

```bash
P=$(mktemp -t ask-codex.XXXXXX)
F=$(mktemp -t ask-codex-result.XXXXXX)
J=$(mktemp -t ask-codex-events.XXXXXX)
# Write the complete prompt to "$P", then:
codex exec --json -s read-only -C "$WORKSPACE_ROOT" \
  -c model_reasoning_effort="$EFFORT" -o "$F" - <"$P" >"$J"
SID=$(jq -r 'select(.type == "thread.started") | .thread_id' "$J" | head -n1)
```

Read `"$F"` for the reply; when it is empty, read the events in `"$J"` for
the reason. Keep `SID` only for a follow-up in the same exchange, and resume
by that id, never `--last`:

```bash
(cd "$WORKSPACE_ROOT" && codex exec resume "$SID" -c sandbox_mode="read-only" \
  -c model_reasoning_effort="$EFFORT" -o "$F" - <"$P" >/dev/null)
```

## Scoped write pass

Only when the user asked for implementation, replace the read-only sandbox
with `-s danger-full-access -c 'approval_policy="never"'` on the first run and
`-c sandbox_mode="danger-full-access" -c 'approval_policy="never"'` on resume.
The prompt names the write lease and validation.

Outside a Git repository, add `--skip-git-repo-check`.
