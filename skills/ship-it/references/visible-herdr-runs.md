# Visible Herdr runs

Use this contract for every ship-it simplify or native review command that
does not run as an interactive slash command in the current visible agent
pane.

## Pin the unit

Require `HERDR_ENV=1`. Locate the `herdr-pair` skill installed beside
ship-it, then read and execute its
`references/caller-pane-resolution.md` proof for the task repository. Keep
the returned pane, workspace, tab, terminal, agent, and repository as one
immutable pin for this gate. The proof's tab is the work unit.

Set `VISIBLE_RUN` to this skill's
`scripts/herdr-visible-run.mjs`. Build the `PAIR_ID` argument array exactly as
that reference derives it from the proof JSON, and pass `"${PAIR_ID[@]}"` to
every `start` or `run` call.

The helper rechecks the full pin and the caller's foreground process before
every launch. Pin drift stops the gate and requires a fresh transcript proof.

## Launch and observe

Create the first process pane without moving the user's focus:

```bash
RUN_JSON=$(node "$VISIBLE_RUN" start "${PAIR_ID[@]}" \
  --label "ship-it · <simplify|standards review|spec review|combined review>" \
  -- <command> <args...>)
```

Parse `pane_id`, `marker`, `receipt`, and `transcript` from `RUN_JSON`.
Immediately tell the user which labeled pane is running. The helper streams
the command's stdout and stderr into that pane and the transcript while the
calling agent remains free to inspect either surface.

Reuse a completed process pane for the next sequential command:

```bash
RUN_JSON=$(node "$VISIBLE_RUN" run "${PAIR_ID[@]}" \
  --target-pane "<existing process pane>" \
  --label "ship-it · <next command>" \
  -- <command> <args...>)
```

For a dual review, start both commands in distinct visible panes before
waiting for either. A simplify pane may be reused for the later Claude
review after simplify has completed.

Wait on each exact completion marker:

```bash
herdr pane wait-output "<pane_id>" --match "<marker>" --timeout 3600000
```

Then require the JSON receipt's token and pane to match the launch, require
exit zero, and validate the transcript under ship-it's content rules. A
marker timeout triggers an immediate `herdr pane get`, `herdr pane
process-info`, and `herdr pane read --source recent-unwrapped`; a visible
prompt, approval, rate limit, stalled output, or crash is the gate's current
state, not silence.

Keep the labeled panes in the unit through the gate receipt and report their
IDs. The unit's normal tab dismantle closes them. For a standalone ship-it
run, close only panes created by this gate after the final outcome has been
reported and their receipts have been captured.

A long command is complete only when its exact marker is visible, its receipt
matches and passes, its transcript has valid content, and the gate receipt
names the pane. If the helper cannot establish or preserve those facts, stop
and report the pane plus the observed state; do not fall back to an invisible
process.
