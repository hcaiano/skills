# Headless backend

Outside Herdr there is no partner pane, so the partner is a persistent
resumable session of the partner CLI. You are the **lead**: you hold the
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

Look for a pair to resume before creating one: `status --repo "$REPO_ROOT"`
reports a recorded session, and `init` resumes it rather than replacing it.

Require the partner CLI (`claude`, `codex`, `cursor-agent`, or `grok`) and
`trash` on `PATH`. The partner is chosen, never derived, and the helper refuses
to pair a model with itself. For model, effort, and pool choices, read
[`models.md`](models.md). Leave `--model` unset for the CLI default. Choose
Codex effort explicitly from `low`, `high`, or `xhigh`; use the per-CLI rubric
for the other effort controls.

## Start or resume

```bash
node "$PAIR_SCRIPT" init --repo "$REPO_ROOT" --partner "$PARTNER" \
  [--model "$MODEL"] [--effort "$EFFORT"] [--role peer|executor]
```

It prints `{sid, partner, role, model, effort, state_file}`. Creating a session
spends one partner turn: the helper sends the complete protocol preamble and,
for every partner but Grok, captures the session id from that run — Grok is
handed a session id the helper generates, so nothing has to be parsed. The
preamble already carries the protocol; the first `task` carries task context,
so the partner never needs to reread this skill. `init` is idempotent — with a
recorded session the CLI still knows, it resumes and spends nothing; a recorded
session with a different partner is refused rather than replaced. Record the
exact `sid`; every send is bound to it, and after compaction `status` recovers it
from the state file.

The helper records model and effort in session state. Claude receives
`--effort low|medium|high|xhigh|max` on every invocation; Codex receives
`model_reasoning_effort`, Grok `--reasoning-effort`, and Cursor an
`[effort=…]` suffix inside `--model` (so Cursor needs a model). Resume keeps
the recorded session and its settings; the CLI's own help is the authority for
any value not named in [`models.md`](models.md).

Then send the first `task`, splitting scopes and write leases as `SKILL.md`
describes.

Done when `init` reports a `sid` and the first `task` has a terminal
`status: "replied"` receipt.

## Send

Write only the body to a temp file, then invoke:

```bash
BODY=$(mktemp); trap 'trash "$BODY"' EXIT
# Write the partner message body to "$BODY".
node "$PAIR_SCRIPT" send --repo "$REPO_ROOT" --kind "$KIND" --body-file "$BODY" \
  [--background]
```

The helper injects the header, resumes the recorded session, and starts one
detached supervisor path. The supervisor owns the partner process, transcript,
deadlines, final receipt, and lock release. A synchronous send waits for that
worker; `--background` returns after the atomic startup handshake. The
handshake prints `status=running` only after the worker owns the lock and the
running record contains both `supervisor_pid` and `partner_pid`. It also names
the `transcript` and the eventual `receipt_file`; this running record is not the
final receipt.

The worker tees streaming output to `<git-dir>/pair/transcripts/`, waits on an
idle and a total deadline (`--idle-min`, `--total-min`), and writes the final
receipt to a temporary file before renaming it into place. It releases the lock
only after that rename. `wait` reads only a complete receipt:

```bash
node "$PAIR_SCRIPT" wait --repo "$REPO_ROOT" [--seq "$SEQ"]
```

With no `--seq`, `wait` follows `state.seq`, not the in-flight marker, so a
fast turn that already cleared its marker is still waitable. `--seq` selects an
older turn. The default wait timeout is 65 minutes; pass `--timeout-min N` when
the turn needs a different bound. If the worker is dead and no receipt exists,
`wait` returns `reason=worker-lost` immediately instead of waiting for the
timeout. A `running` receipt is not terminal; call `wait` and then read its
`receipt_file`.

Terminal receipts print `{seq, transcript, reply_file, status}` and, when
applicable, `receipt_file`:

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
  edits, so inspect `git status` before resending. The receipt adds
  `partial_reply=true` only when nonempty assistant text was recovered.
- `status=failed` with `reason=grok-cancelled`: Grok emitted a clean cancelled
  end event. Treat it as a failure, never as `replied` or `empty-reply`.
- `status=worker-lost`: the supervisor died before it could write a receipt.
  Inspect the transcript, lock, and worktree, then recover the marker before a
  new send.
- `status=wait-timeout`: the selected worker has not produced a receipt within
  the wait bound. Inspect `status` and the transcript before choosing a new
  action.

The helper writes a reply file only for a nonempty extracted reply. Grok joins
`text` deltas and leaves `thought` evidence in the transcript; Cursor uses its
final successful `result`; Codex uses its `--json` event stream and output file.
The stream is the watchdog's liveness signal for Grok (`streaming-json`), Cursor
(`stream-json`), Codex (`--json`), and Claude (`stream-json`).

After two consecutive proved Grok cancellations, the receipt advises a fork.
The counter increments while the turn owns the lock and resets on the next
terminal non-cancelled result. Inspect the worktree and transcript before
following that advice; cancellation is not proof that the edits are complete.

## Fork a cancelled Grok session

Schedule a fork after the cancellation advice:

```bash
node "$PAIR_SCRIPT" fork --repo "$REPO_ROOT" [--retry]
```

The command emits `status=fork-scheduled` and records the target. Forking is an
That output means the fork runs on the next normal `send`; it does not run a
turn by itself. Forking is an atomic transaction owned by that send. It records
`pending_fork` before starting, resumes the old session with
`--resume <old-sid> --fork-session --session-id <new-sid>`, and puts the new sid
in that turn's protocol header. State commits the new sid only after the
stream proves the new session ID. A failed fork retains explicit recovery state,
so inspect it before retrying. The next normal send carries the body and
produces the normal turn receipt; use `fork --retry` only to replace a failed
pending target.

State history keeps each committed transition as
`{sid, forked_at, successor_sid}`. The first post-fork message states the sid
change because copied history still contains the old literal sid. Use the
checkpoint in that message to carry only the task state that needs continuity.

The session's role sets each turn's default: under `peer` a turn is read-only
unless you pass `--write`, and under `executor` it is writable unless you pass
`--read-only`. Pass the flag exactly where the lease differs from the role, and
inspect `git diff` and real validation output yourself afterwards.

What holds a turn differs by partner. A Codex turn is held by a filesystem
sandbox (`read-only`, or `workspace-write` with `--write`). A Claude turn is
held by a permission mode (`plan`, or `acceptEdits` with `--write`) that
restrains the agent's edits without being an OS sandbox, and a Grok turn by the
same kind of mode (`plan` or `acceptEdits`). A Cursor turn writes by default in
`--print`, so its read-only turns are the ones carrying `--mode plan` — the
mode restrains the agent, and is not an OS sandbox either.

The transport is half-duplex, so one turn runs at a time. A send takes a lock
by creating `<git-dir>/pair/in-flight.json`, which records the turn's sequence,
`supervisor_pid`, and `partner_pid`, and refuses over any existing marker while
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

`status` prints the sid, partner, role, model, effort, and sequence — use it to
rebuild state after compaction. Its `session_known` reports a positive absence
only: `false` proves the CLI's session store was readable and did not hold this
session, while `true` also covers a store that could not be read at all, so it
is evidence of loss and never proof of health. It probes `~/.codex/sessions`,
`~/.claude/projects`, `~/.grok/sessions`, and `~/.cursor/chats`.

`end` trashes the session directory, and runs
only when the user explicitly asks to end the pair. It refuses while an
in-flight marker exists — wait for the turn or run `clear` first — because
trashing the session mid-turn destroys the running transcript and leaves a
write-lease partner editing with no record.
