# Headless backend

Outside Herdr there is no partner pane, so the partner is a persistent
resumable session of the opposite CLI. You are the **lead**: you hold the
conversation with the user and drive every exchange. The exchange is
**half-duplex** — you send, and the partner's reply is that run's output. The
partner never speaks first and has no other channel back to you.

The protocol, kinds, write leases, broken-checkout announcements, and work
cycles are in [`SKILL.md`](../SKILL.md); this file owns the transport. What the
Herdr backend has and this one does not: composer proof, delivery receipts
beyond the run receipt, and `reconcile`. A turn either returned a reply or it
did not, and the transcript is the evidence either way.

## Preconditions

Set `SKILL_DIR` to this skill directory and
`PAIR_SCRIPT="$SKILL_DIR/scripts/pair-headless.mjs"`. Always use that absolute
path; the project cwd is unrelated to the installed skill path.

The task must be a git repository: the session state lives in
`<git-dir>/pair/session.json`, so a worktree holds one pair and a linked
worktree gets its own. Set `REPO_ROOT` to it.

Require the opposite CLI and `trash` on `PATH`. The partner is Codex when you
are Claude Code, and Claude when you are Codex; the helper refuses to pair a
model with itself. Leave the model unset — each CLI's own config owns model
selection.

## Start or resume

```bash
node "$PAIR_SCRIPT" init --repo "$REPO_ROOT"
```

It prints `{sid, partner, state_file}`. Creating a session spends one partner
turn: the helper sends the protocol preamble and captures the session id from
that run. `init` is idempotent — with a recorded session the CLI still knows,
it resumes and spends nothing. Record the exact `sid`; every send is bound to
it, and after compaction `status` recovers it from the state file.

Then send the first `task`, splitting scopes and write leases as `SKILL.md`
describes.

Done when `init` reports a `sid` and the first `task` has a `status: "replied"`
receipt.

## Send

Write only the body to a temp file, then invoke:

```bash
BODY=$(mktemp); trap 'trash "$BODY"' EXIT
# Write the partner message body to "$BODY".
node "$PAIR_SCRIPT" send --repo "$REPO_ROOT" --kind "$KIND" --body-file "$BODY"
```

The helper injects the header, resumes the recorded session, runs the turn as a
detached background process teeing to `<git-dir>/pair/transcripts/`, and waits
on an idle and a total deadline (`--idle-min`, `--total-min`). It prints
`{seq, transcript, reply_file, status}`:

- `status=replied`: the partner answered. Read `reply_file` and act on it.
- `status=empty-reply`: the run exited clean with nothing in it. Read
  `transcript` first — the partner may have consumed the prompt and still
  produced no final message, so a resend can duplicate work; for a write-lease
  turn inspect `git status` before resending. A body that names a file path
  beats a long one.
- `status=failed`: the CLI exited nonzero. Read `transcript` for the reason
  before resending — an auth or rate-limit failure repeats.
- `status=hang-killed`: the turn passed a deadline and was killed. Read
  `transcript` to see how far it got; a killed write-lease turn may have left
  edits, so inspect `git status` before resending.

Every turn is read-only unless you pass `--write`. A Codex turn is held by a
filesystem sandbox (`read-only`, or `workspace-write` with `--write`), while a
Claude turn is held by a permission mode (`plan`, or `acceptEdits` with
`--write`) that restrains the agent's edits without being an OS sandbox. Pass
`--write` exactly for the turns where the partner holds the write lease, and
inspect `git diff` and real validation output yourself afterwards.

The transport is half-duplex, so one turn runs at a time. A send takes a lock
by creating `<git-dir>/pair/in-flight.json`, which records the turn's sequence
and the partner process's pid, and refuses over any existing marker while
spending nothing. `status` shows the marker under `in_flight`. When its
processes are gone, clear it:

```bash
node "$PAIR_SCRIPT" clear --repo "$REPO_ROOT"
```

`clear` refuses while any recorded process is alive, and a marker it cannot
read at all is removed by hand once you have confirmed no partner process
remains. The lock catches accidents; it is not a mutex for concurrent leads.
One operation at a time is the contract: run `clear` only while no send is
running, from the one lead the session has. The sequence number advances
before the turn runs, so a killed run never lets the next send reuse a number
the partner has already seen.

## Status and end

```bash
node "$PAIR_SCRIPT" status --repo "$REPO_ROOT"
node "$PAIR_SCRIPT" end --repo "$REPO_ROOT"
```

`status` prints the sid, partner, and sequence — use it to rebuild state after
compaction. Its `session_known` reports a positive absence only: `false` proves
the CLI's session store was readable and did not hold this session, while
`true` also covers a store that could not be read at all, so it is evidence of
loss and never proof of health. `end` trashes the session directory, and runs
only when the user explicitly asks to end the pair. It refuses while an
in-flight marker exists — wait for the turn or run `clear` first — because
trashing the session mid-turn destroys the running transcript and leaves a
write-lease partner editing with no record.
