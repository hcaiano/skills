# Process transport

Use this contract for every ship-it simplify or native review command that
does not run as an interactive slash command in the current visible agent
pane. The transport records whether the command ran in a visible Herdr process
pane or as a local background process. These backends provide the same launch
and receipt shape, but different operator control: a Herdr run is observable
and interruptible in its own pane; a local run has no live surface for
observation or interjection. Its transcript is the only record; the user can
tail that file when needed.

## Select and launch

Set `RUN_TRANSPORT` to this skill's `scripts/run-transport.mjs`. When
`HERDR_ENV=1`, locate the `herdr-pair` skill installed beside ship-it, then read
and execute its `references/caller-pane-resolution.md` proof for the task
repository. Build the `PAIR_ID` argument array exactly as that reference
derives it from the proof JSON. The proof's pane, workspace, tab, terminal,
agent, and repository form one immutable pin, and its tab is the work unit.

Start each command without moving the user's focus:

```bash
RUN=$(node "$RUN_TRANSPORT" start "${PAIR_ID[@]}" \
  --label "ship-it · <simplify|standards review|spec review|combined review>" \
  -- <command> <args...> --receipt "<wrapper-result.json>")
RUN_FILE=$(printf '%s' "$RUN" | jq -r .run_file)
```

Outside Herdr, omit `PAIR_ID`; the helper selects `local`. With `HERDR_ENV=1`,
the caller proof must be complete for `herdr` selection. An incomplete or
drifted Herdr pin stops the gate instead of silently running invisibly.
Retain the run file and its `transport`, `pane_id`, `pid`, `token`, `marker`,
`receipt`, and `transcript` fields. Immediately tell the user the transport
and label; for Herdr, also name the pane.

The Herdr backend delegates to `herdr-visible-run.mjs`. It rechecks the full
pin and caller foreground process before every launch. Pin drift stops that
launch and requires a fresh proof; an already-selected Herdr run never changes
backend. The local backend starts a detached child, tees its output to the
transcript, and writes the completion receipt on exit. The local child writes
only to its transcript;
the transport owns observation: pane, marker, and receipt for Herdr; PID and
receipt polling for local. The headless Claude and Codex wrappers
own both backends' idle and total deadlines, PID-scoped termination, and content
validation.

For a dual review, start both commands before waiting for either. A Herdr dual
review uses distinct visible panes. Observe both completions concurrently so
the lead can validate and close each Herdr pane as soon as it finishes; do not
wait on one while leaving another completed pane open. Close a Herdr simplify
pane after its artifacts are valid because inspection, focused validation, and
the local review commit occur before any later Claude review.

## Wait and validate

Wait through the transport helper for each exact run:

```bash
node "$RUN_TRANSPORT" wait --run-file "$RUN_FILE"
```

Require the completion receipt's token and `transport` to match the run file,
require exit zero, and validate the transcript under ship-it's content rules.
For `headless-claude.mjs` or `headless-codex.mjs`, also require the separate
wrapper receipt to contain `{ok: true}` and non-empty validated content. A
refusal, rate-limit notice, or empty payload is failure even when the command
exits zero.

The Herdr backend retains every visible-run invariant: `pane_id` and `marker`
must be non-null; the helper waits for the exact marker; the completion
receipt's pane and token must match the launch. A marker timeout triggers an
immediate `herdr pane get`, `herdr pane process-info`, and `herdr pane read
--source recent-unwrapped`; a visible prompt, approval, rate limit, stalled
output, or crash is the gate's current state, not silence.

After each Herdr process finishes, capture its marker, completion receipt,
transcript, and wrapper receipt. Reuse its pane only for an already-planned,
immediately sequential command in this gate, with the prior receipt and token
validated before reuse; otherwise the lead closes it with `herdr pane close
<pane_id>`. Once simplify and all reviews finish, close every remaining process
pane before push. Close only panes created by this gate, never the caller or
another unit pane. Keep the closed pane IDs and receipt paths in the delivery
receipt.

A process is complete only when the transport wait validates its token,
transport, exit, receipt, and transcript content. A Herdr process additionally
requires its exact marker, matching pane, gate-receipt entry, and a pane that is
assigned to its immediate next command or closed. Herdr cleanup is complete
only when every process pane is closed. If the helper cannot establish or
preserve these facts, stop and report the run's transport plus the observed
state.
