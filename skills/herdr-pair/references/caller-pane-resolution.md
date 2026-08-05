# Caller pane proof

Run this proof before any Herdr mutation. It is the single caller-identity
contract for `herdr-pair` and `herdr-orchestrate`.

## Resolve

```sh
TASK_REPO=$(git -C <task-repository> rev-parse --show-toplevel)
PAIR_PROOF=$(node "$PAIR_SCRIPT" id --as <claude|codex> --repo-root "$TASK_REPO")
```

The helper walks your own process ancestry and looks for a pane whose live
foreground processes include one of your ancestors. A parent process cannot be
wrong about which pane its own child runs in, and that fact comes from the live
process table rather than from anything Herdr injected at start — which is why
it, and not the environment, is the proof. `$HERDR_PANE_ID` and the
`agent_session` binding both derive from the same injected variable (the
integration hook reports the session *to* `$HERDR_PANE_ID`), so after a pane
move they agree on the wrong pane together and neither is evidence. `pane
current --current` merely echoes that same variable, and falls back to the
UI-focused pane when it is unset.

Matching exactly one pane reports `proof: "process-ancestry"`. Panes share
ancestors further up — every pane descends from the Herdr server — so a chain
matching more than one pane proves nothing and falls back to the marker proof
below.

## When the helper asks for conversation markers

Write one distinctive commentary sentence about the newest user request. Create
a temporary JSON file with two exact, high-entropy excerpts already visible in
the caller transcript:

```json
{
  "newest_user_request": "<exact excerpt from the newest user request>",
  "recent_caller_output": "<exact excerpt from that commentary>"
}
```

Both excerpts must be exact and unique to this conversation, and must remain
different after trimming; the commentary excerpt must be at least 12
characters. Set `MARKERS_FILE` to that file and trash it after resolution.

Re-run the proof with `--conversation-markers-file "$MARKERS_FILE"`, then trash
the file. That path narrows to candidate panes whose agent kind matches and
whose `cwd` or `foreground_cwd` equals `TASK_REPO`, keeps those with a live
foreground agent process, reads each one's transcript, and requires exactly one
to contain both markers. A pane mid-tool-call refuses scrollback capture, and
the helper then falls back to that pane's visible screen — so choose excerpts
that are still on screen, not ones that have scrolled away. It reports `proof: "conversation-markers"`, and
hard-stops when no live candidate remains, on zero or multiple transcript
matches, on unreadable or empty candidate transcripts, on a final process or
repository mismatch, or on live pane drift during the proof.

Inspect `PAIR_PROOF`, name its `workspace_label` to the user, then pin its exact
pane, workspace, tab, terminal, agent, and repository:

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

`agent_session` is supporting metadata in `PAIR_PROOF`. A duplicated binding is
reported in `session_binding_warning`; it never selects or redirects the pane.
`CODEX_THREAD_ID`, session paths, `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, UI
focus, and `pane.current` are not caller proof.
