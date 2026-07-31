# Caller pane proof

Run this proof before any Herdr mutation. It is the single caller-identity
contract for `herdr-pair` and `herdr-orchestrate`.

## Resolve and mark the conversation

Resolve the task repository explicitly:

```sh
TASK_REPO=$(git -C <task-repository> rev-parse --show-toplevel)
```

Write one distinctive commentary sentence about the newest user request. Create
a temporary JSON file with two exact, high-entropy excerpts already visible in
the caller transcript:

```json
{
  "newest_user_request": "<exact excerpt from the newest user request>",
  "recent_caller_output": "<exact excerpt from that commentary>"
}
```

Both excerpts must be exact and unique to this conversation; the commentary
excerpt must be at least 12 characters. Set `MARKERS_FILE` to that file and
trash it after resolution.

## Run the proof

```sh
PAIR_PROOF=$(node "$PAIR_SCRIPT" id \
  --as <claude|codex> \
  --repo-root "$TASK_REPO" \
  --conversation-markers-file "$MARKERS_FILE")
```

The helper executes this proof chain:

1. `herdr api snapshot`
2. candidate panes from `.result.snapshot.agents` whose agent kind matches and
   whose `cwd` or `foreground_cwd` equals `TASK_REPO`
3. live foreground-process checks for those candidates
4. `herdr agent read <pane-id> --source recent-unwrapped --lines 200` for every
   live candidate
5. one transcript containing both conversation markers
6. a fresh `herdr pane process-info --pane <pane-id>` requiring the matching
   agent process at `TASK_REPO`
7. `herdr workspace get <workspace-id>` from the proven pane

Repository and agent-kind matches create candidates; only the exact current
transcript proves the caller. The helper hard-stops on zero or multiple
transcript matches, unreadable or empty candidate transcripts, process
mismatch, repository mismatch, or live pane drift during the proof.

Inspect `PAIR_PROOF`, name its `workspace_label` to the user, then pin its exact
pane, workspace, tab, terminal, agent, and repository:

```sh
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

`agent_session` is supporting metadata in `PAIR_PROOF`. A duplicated binding is
reported in `session_binding_warning`; it never selects or redirects the pane.
`CODEX_THREAD_ID`, session paths, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, UI
focus, and `pane.current` are not caller proof.
