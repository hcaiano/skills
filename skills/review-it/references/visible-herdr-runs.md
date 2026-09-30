# Visible Herdr runs

Read this when step 4 runs in an interactive Herdr lead. Each review then runs
in its own labelled pane that the user can watch and interrupt.

## Caller pin

Locate the `pair` skill installed beside this one, then read and execute its
`references/caller-pane-resolution.md` proof for the task repository. Build the
`CALLER_ID` argument array exactly as that reference derives it from the proof
JSON. The proof's pane, workspace, tab, terminal, agent, and repository form
one immutable pin, and its tab is the work unit.

An incomplete or drifted pin stops the launch: rerun the proof. A Herdr lead's
reviews always run in panes. After each `start`, tell the user the label and
the pane.

## Pane reuse

Reuse a finished pane only for an already-planned, immediately sequential
command in this gate. Keep `start` and add the finished run's pane, completion
receipt, and token, so the helper proves the pane is the one it launched before
it sends anything:

```bash
RUN=$(node "$RUN_TRANSPORT" start "${CALLER_ID[@]}" \
  --label "review-it · <axis> review" \
  --target-pane "<pane_id>" \
  --prior-receipt "<prior completion receipt>" \
  --prior-token "<prior token>" \
  -- <command> <args...> --receipt "<wrapper-result.json>")
```

## Wait and close

A `dual` review uses two panes. Wait on both concurrently, and validate and
close each one as soon as its run finishes.

When `wait` reports no completion marker, run the three inspection commands it
prints. A visible prompt, approval, rate limit, stalled output, or crash is the
gate's current state, not silence.

After each run, keep its marker, completion receipt, transcript, and wrapper
receipt, then close its pane with `herdr pane close <pane_id>` unless the
reuse rule assigns it the next command. Close only panes this gate created,
never the caller's or another unit's.

Done when every pane this gate created is closed before step 5 and its ID is on
the receipt's `Transport` line. If the helper cannot establish or preserve
these facts, stop and report the run's transport and the observed state.
