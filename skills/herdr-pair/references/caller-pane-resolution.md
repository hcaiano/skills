# Caller pane proof

Run this proof before any Herdr mutation. It is the single caller-identity
contract for `herdr-pair` and `herdr-orchestrate`.

Resolve the task repository explicitly, then run the proof:

```sh
TASK_REPO=$(git -C <task-repository> rev-parse --show-toplevel)
PAIR_PROOF=$(node "$PAIR_SCRIPT" id --as <claude|codex> --repo-root "$TASK_REPO")
```

The helper reads your own session id — `$CLAUDE_CODE_SESSION_ID` for Claude,
`$CODEX_THREAD_ID` for Codex — and matches it against the `agent_session.value`
that Herdr binds to each pane. Owning exactly one pane proves the caller
outright; the helper then confirms that pane's live foreground agent process and
repository and reports `proof: "agent-session"`. Nothing else identifies you:
`pane current --current` merely echoes `$HERDR_PANE_ID`, an environment value
captured at process start that goes stale across pane moves, and with that
variable unset it falls back to whichever pane the UI has focused.

Inspect `PAIR_PROOF`, name its `workspace_label` to the user, then pin it:

```bash
PAIR_ID=(
  --pane "$(printf '%s' "$PAIR_PROOF" | jq -r .pane)"
  --workspace "$(printf '%s' "$PAIR_PROOF" | jq -r .workspace_id)"
  --tab-id "$(printf '%s' "$PAIR_PROOF" | jq -r .tab_id)"
  --as "$(printf '%s' "$PAIR_PROOF" | jq -r .as)"
  --terminal-id "$(printf '%s' "$PAIR_PROOF" | jq -r .terminal_id)"
  --repo-root "$TASK_REPO"
)
```

Use `"${PAIR_ID[@]}"` on every helper command. The helper rechecks the pinned
workspace, tab, terminal, agent process, and repository before acting.

## When the helper asks for conversation markers

A session id can land on more than one pane (a resumed session, a stale
binding), and a pane predating session reporting has none at all. The helper
refuses to guess: it stops and asks for `--conversation-markers-file`. Only
then, write one distinctive commentary sentence about the newest user request
and build a temporary JSON file with two exact, high-entropy excerpts already
visible in this conversation:

```json
{
  "newest_user_request": "<exact excerpt from the newest user request>",
  "recent_caller_output": "<exact excerpt from that commentary>"
}
```

Both excerpts must be exact and unique to this conversation, must remain
different after trimming, and the commentary excerpt must be at least 12
characters. Re-run the proof with `--conversation-markers-file <path>`, then
trash the file. The helper matches those markers against the live transcript of
every same-repository candidate pane and reports `proof:
"conversation-markers"`.

It hard-stops when no live candidate remains, on zero or multiple transcript
matches, on unreadable or empty candidate transcripts, on a final process or
repository mismatch, or on live pane drift during the proof.

`agent_session` is reported as supporting metadata on this path, and a
duplicated binding is named in `session_binding_warning`; neither selects or
redirects the pane. Session paths, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, UI
focus, and `pane.current` are never caller proof.
