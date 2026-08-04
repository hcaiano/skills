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
every launch. Pin drift stops the gate and requires a fresh caller proof.

## Launch and observe

Create the first process pane without moving the user's focus:

```bash
RUN_JSON=$(node "$VISIBLE_RUN" start "${PAIR_ID[@]}" \
  --label "ship-it · <simplify|standards review|spec review|combined review>" \
  -- <command> <args...>)
```

Parse and retain `pane_id`, `token`, `marker`, `receipt`, and `transcript` from
`RUN_JSON`. Immediately tell the user which labeled pane is running. The
helper streams the command's stdout and stderr into that pane and the
transcript while the calling agent remains free to inspect either surface.

Reuse a completed process pane for the next sequential command:

```bash
RUN_JSON=$(node "$VISIBLE_RUN" run "${PAIR_ID[@]}" \
  --target-pane "<existing process pane>" \
  --prior-receipt "<that pane's previous completion receipt>" \
  --prior-token "<that launch's token>" \
  --label "ship-it · <next command>" \
  -- <command> <args...>)
```

The prior receipt and token are the `receipt` path and `token` returned by that
pane's previous launch. The helper requires both values and the pane to match
before reuse, waits for the shell to regain control, and carries long command
arguments through a private temporary file instead of terminal injection.

For a dual review, start both commands in distinct visible panes before
waiting for either. Observe their completion concurrently so the lead can
validate and close each pane as soon as it finishes; do not block on one pane
while leaving another completed pane open. Close the simplify pane after its
artifacts are valid because inspection, focused validation, and the local
review commit occur before any later Claude review.

Wait on each exact completion marker:

```bash
herdr pane wait-output "<pane_id>" --match "<marker>" --timeout 3600000
```

Then require the JSON receipt's token and pane to match the launch, require
exit zero, and validate the transcript under ship-it's content rules. For
`headless-claude.mjs`, also require its separate `--receipt` JSON to contain
`{ok: true}` and non-empty validated content. A
marker timeout triggers an immediate `herdr pane get`, `herdr pane
process-info`, and `herdr pane read --source recent-unwrapped`; a visible
prompt, approval, rate limit, stalled output, or crash is the gate's current
state, not silence.

After each simplify or review process finishes, validate and capture its
marker, completion receipt, transcript, and any wrapper receipt. Reuse its
pane only for an already-planned, immediately sequential command in this gate;
otherwise the lead closes it with `herdr pane close <pane_id>`. Once simplify
and all review processes are complete, the lead closes every remaining process
pane before push. Close only panes created by this gate, never the caller or
another unit pane. Keep the closed pane IDs and receipt paths in the gate
receipt.

A long command is complete only when its exact marker is visible, its receipt
matches and passes, its transcript has valid content, the gate receipt names
the pane, and the pane is either assigned to its immediate next command or
closed. Gate cleanup is complete only when every process pane is closed. If the
helper cannot establish or preserve those facts, stop and report the pane plus
the observed state; do not fall back to an invisible process.
