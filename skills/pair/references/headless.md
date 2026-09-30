# Headless backend

Outside Herdr the partner is a persistent, resumable session of the partner
CLI. You are the **lead**: you hold the conversation with the user and drive
every exchange. The exchange is **half-duplex** — you send, and the partner's
reply is that run's output; the partner never speaks first. There is no
composer proof, no delivery receipt beyond the run receipt, and no
`reconcile`: a turn either returned a reply or it did not, and the transcript
is the evidence either way. The protocol, kinds, write leases, broken-checkout
announcements, and work cycles are in [`SKILL.md`](../SKILL.md); this file
owns the transport.

## Preconditions

Set `SKILL_DIR` to this skill directory and
`PAIR_SCRIPT="$SKILL_DIR/scripts/pair-headless.mjs"`, always as an absolute
path. Set `REPO_ROOT` to the existing task directory; it need not use Git or
have a remote. A Git worktree keeps its session in `<git-dir>/pair/`, so each
linked worktree holds its own pair; a plain directory uses
`${XDG_STATE_HOME:-~/.local/state}/pair/<basename>-<realpath-hash>/`.

Run `status` first: `init` resumes a recorded session rather than replacing
it.

Require the partner CLI (`claude`, `codex`, `cursor-agent`, `grok`, or
`opencode`) on `PATH`. The partner is chosen, never derived, and the helper
refuses to pair a CLI kind with itself, except two Codex accounts on
different homes (`--identity` below). Take model, effort, and pool from
[`models.md`](models.md): leave `--model` unset for the CLI default, or name
an exact catalog ID or `latest:<family>`. `CODEX_BIN` selects a Codex install
other than `codex` on `PATH`; `init` records the binary it verified, and every
later turn runs that one.

## Start or resume

```bash
node "$PAIR_SCRIPT" init --repo "$REPO_ROOT" --partner "$PARTNER" \
  [--identity "$IDENTITY"] [--model "$MODEL"] [--effort "$EFFORT"] \
  [--role peer|executor]
```

A new session spends one partner turn on the protocol preamble, so the
partner never needs this skill; the first `task` carries the task context.
`init` prints the `sid` and the recorded settings, including
`model_resolved`. Record the `sid`: every send is bound to it, and after
compaction `status` recovers it.

`init` is idempotent. With a recorded session the CLI still knows, it resumes
and spends nothing, taking partner, identity, and binary from the record, not
from your flags or environment. It refuses a different `--partner` or
`--identity` rather than replacing the session. When the partner CLI's own
store proves the session gone, `init` refuses, keeps the record, and names the
state file to inspect before you end the pair and start a new one.

`--identity` defaults to `default`. Only Codex accepts a name, and its home
`~/.codex-profiles/<name>` must already exist. Every partner process for the
session runs with `CODEX_HOME` set to that recorded home, never the caller's;
no credential is read or copied, and the lead's own home is refused.

Model and effort are fixed for the session: every turn passes the recorded
effort through the CLI's own flag, and a resumed Claude turn pins the exact
model its first run reported. Then send the first `task`, splitting scopes and
write leases as `SKILL.md` describes.

Done when `init` reports a `sid` and the first `task` has a terminal
`status=replied` receipt.

## Send

Write only the body to a temp file, then invoke:

```bash
BODY=$(mktemp); trap 'rm -- "$BODY"' EXIT
# Write the partner message body to "$BODY".
node "$PAIR_SCRIPT" send --repo "$REPO_ROOT" --kind "$KIND" --body-file "$BODY" \
  [--write|--read-only] [--background] [--idle-min N] [--total-min N]
```

The helper injects the header, resumes the recorded session, and hands the
turn to a detached supervisor that owns the partner process, transcript,
deadlines, receipt, and lock. A synchronous send waits for it. `--background`
returns `status=running` once the supervisor holds the lock; that record names
the `transcript` and the future `receipt_file`, and is not the final receipt.
Collect the receipt with:

```bash
node "$PAIR_SCRIPT" wait --repo "$REPO_ROOT" [--seq "$SEQ"] [--timeout-min N]
```

`wait` follows the latest turn unless `--seq` names an older one, and reads
only a complete receipt. Its default bound is 125 minutes. `wait` blocks your
session, and a lead harness kills a long foreground command (exit 137) without
a receipt. To stay reachable, poll `status` (its `in_flight` marker) and the
transcript's size, and keep `wait` for short bounds or the harness's own
background facility.

Budgets: a writable `kind=task` turn gets 45 idle and 120 total minutes,
because a delivery turn runs the repository's own CI; every other turn and
`init` get 20 and 60. `--idle-min` and `--total-min` replace them, and a
hang-kill receipt names the flag to raise. Time the partner spends queued for
the devbox heavy-work slot is not counted, so size `--total-min` to the
validation's own run time. Run `send`, `wait`, and `init` directly, never
inside `agent-run heavy`: the partner's own validation takes the slot when it
runs, and a send held inside it blocks every other unit's validation behind an
idle model session.

## Receipts

Terminal receipts print `seq`, `transcript`, `reply_file`, and `status`, plus
`receipt_file` when applicable:

- `status=replied`: read `reply_file` and act on it.
- `status=empty-reply`: the run exited clean with no reply. Read `transcript`
  first — the partner may have consumed the prompt, so a resend can duplicate
  work; for a write-lease turn, inspect the task directory and `git status`
  when Git is present before resending. A body that names a file path beats a
  long one.
- `status=failed`: the CLI exited nonzero. Read `transcript` before resending;
  an auth or rate-limit failure repeats. `reason=grok-cancelled` marks a clean
  Grok cancellation, which is a failure, never a reply.
- `status=hang-killed`: the turn passed a deadline and was killed. A
  write-lease turn may have left edits, so inspect the task directory and
  `git status` when Git is present before resending. `partial_reply=true`
  means some assistant text was recovered.
- `status=worker-lost`: the supervisor died before writing a receipt, and
  `wait` reports it at once. Inspect the transcript, lock, and task directory,
  then `clear` before a new send.
- `status=wait-timeout`: no receipt within the wait bound. Inspect `status`
  and the transcript before choosing a new action.

A receipt may also carry `heavy_queue` (queue time excluded from the
budgets), `throttle_signals` (transcript lines that look like a rate limit,
counted, not interpreted), and, for Codex, `rate_limits`: a read-only quota
reading of the recorded account taken right after the turn.

## Write and read-only turns

The role sets each turn's default: under `peer` a turn is read-only unless you
pass `--write`, and under `executor` it is writable unless you pass
`--read-only`. Pass the flag exactly where the lease differs from the role.
Inspect the task files, `git diff` when Git is present, and real validation
output yourself afterwards.

A headless run has no approver, so a writable turn runs its partner with full
bypass, Henrique's standing decision for these dedicated dev machines: Codex
`danger-full-access` with approvals off, Claude and Grok
`--permission-mode bypassPermissions` (Grok also `--always-approve`), Cursor
`--force`, and OpenCode `--auto`. Nothing OS-level restrains a writable
partner; the write lease, scope contract, and review gates are the restraint.
A read-only turn keeps each CLI's restraining mode: Codex's `read-only`
sandbox, `--permission-mode plan` for Claude and Grok, `--mode plan` for
Cursor, and the `plan` agent for OpenCode. Only the Codex mode is an OS
sandbox.

## Fork a cancelled Grok session

After two consecutive proved Grok cancellations the receipt advises a fork.
Inspect the task directory and transcript first; a cancellation does not prove
the edits complete. Then schedule it:

```bash
node "$PAIR_SCRIPT" fork --repo "$REPO_ROOT" [--retry]
```

`status=fork-scheduled` means the fork runs on the next normal `send`, which
carries the body and returns the normal receipt. State moves to the new sid
only after the stream proves it, and history keeps
`{sid, forked_at, successor_sid}`. Use `--retry` only to replace a failed
pending fork. The first post-fork message states the sid change, because
copied history still holds the old one, and carries a checkpoint of the task
state that needs continuity.

A cancellation on the fresh fork, or two more after any committed fork,
records `capability_miss`: the receipt advises restaffing, and `fork` refuses
until a turn returns `replied`.

## Lock and clear

One turn runs at a time. A send takes the lock by creating `in-flight.json`
beside the session file and refuses over any existing marker, spending
nothing; `status` shows it under `in_flight`. When the recorded processes are
gone, clear it:

```bash
node "$PAIR_SCRIPT" clear --repo "$REPO_ROOT"
```

`clear` refuses while any recorded process is alive; a marker it cannot read
is removed by hand once you have confirmed no partner process remains. The
lock catches accidents, not concurrent leads: run one operation at a time,
from the session's one lead.

## Status and end

```bash
node "$PAIR_SCRIPT" status --repo "$REPO_ROOT"
node "$PAIR_SCRIPT" end --repo "$REPO_ROOT"
```

`status` prints the sid, settings, sequence, and any `in_flight` marker; use
it to rebuild state after compaction. `session_known: false` proves the
partner CLI's store lacks the session; `true` also covers a store it could not
read, so it is never proof of health. OpenCode keeps sessions in a database,
so its next resumed turn is the only authority.

`end` deletes the session directory and runs only when the user explicitly
asks to end the pair. It refuses while an in-flight marker exists (wait for
the turn or `clear` first), because deleting mid-turn destroys the running
transcript and leaves a write-lease partner editing with no record.
