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

Set `REPO_ROOT` to the existing task directory. A Git worktree keeps session
state in `<git-dir>/pair/session.json`, so a worktree holds one pair and a linked
worktree gets its own. A plain directory uses
`$XDG_STATE_HOME/pair/<basename>-<realpath-hash>/` when `XDG_STATE_HOME` is set,
and defaults to `~/.local/state/pair/<basename>-<realpath-hash>/`. A GitHub remote
is not a precondition, and the directory does not need to use Git.

Look for a pair to resume before creating one: `status --repo "$REPO_ROOT"`
reports a recorded session, and `init` resumes it rather than replacing it.

Require the partner CLI (`claude`, `codex`, `cursor-agent`, `grok`, or
`opencode`) on `PATH`. The partner is chosen, never derived, and the helper refuses
to pair a CLI kind with itself — except two Codex accounts: a partner named
with `--identity <name>` runs under `~/.codex-profiles/<name>` (`default`
selects `~/.codex`), while the same home is refused by the transport.
The lead's own account is read from its environment before anything is
overridden for the child. For model, effort, and pool choices, read
[`models.md`](models.md). Leave `--model` unset for the CLI default, name an
exact catalog ID, or ask for a family with `latest:<family>`. Choose
Codex effort explicitly from the values the catalog lists for the model
(`low|medium|high|xhigh|max`, plus `ultra` where offered — Luna's seat is
`max`); use the per-CLI rubric for the other effort controls.

The Codex binary is `codex` on `PATH` unless `CODEX_BIN` names another
install. Two installs on one machine publish different catalogs (2026-09-07:
0.147.0 had no Astra, 0.153.4 did), so `init` verifies the chosen binary with
`--version`, resolves the catalog through it, and records its absolute path as
`partner_bin` with `partner_bin_version`; every later turn runs that recorded
binary whatever `PATH` says then. A family the chosen binary does not publish
refuses and names the binary, the page count, and the home it read.

## Start or resume

```bash
node "$PAIR_SCRIPT" init --repo "$REPO_ROOT" --partner "$PARTNER" \
  [--identity "$IDENTITY"] [--model "$MODEL"] [--effort "$EFFORT"] \
  [--role peer|executor]
```

It prints `{sid, partner, role, model, effort, identity, identity_home,
model_resolved, model_source, resolved_at, partner_bin, partner_bin_version,
state_file}`. Creating a session
spends one partner turn: the helper sends the complete protocol preamble and,
for every partner but Grok, captures the session id from that run — Grok is
handed a session id the helper generates, so nothing has to be parsed. The
preamble already carries the protocol; the first `task` carries task context,
so the partner never needs to reread this skill. `init` is idempotent — with a
recorded session the CLI still knows, it resumes and spends nothing, taking
partner, identity, home, and binary from the record rather than from the
caller's flags or environment; a recorded
session with a different partner is refused rather than replaced, and so is a
different `--identity`. A recorded session that its own store proves absent is
a loss: `init` refuses, keeps the record and history, and names the state file
to inspect before the pair is ended and a new one created. Record the
exact `sid`; every send is bound to it, and after compaction `status` recovers it
from the state file.

`--identity` defaults to `default`. Only Codex accepts a name: it must be a
simple name whose home `~/.codex-profiles/<name>` already exists, and the
helper pins the canonical absolute path as `identity_home`. Every partner
process — init, each send's worker, and the `session_known` probe — runs
with `CODEX_HOME` set to that recorded home, never to the caller's own. No
credential is read or copied; the home is the account. A session recorded
before identities existed keeps the `CODEX_HOME` it inherited; nothing moves
it to another account. Every partner spawn also strips the lead's own harness
markers (`CLAUDECODE`, `CODEX_SANDBOX`, `CODEX_THREAD_ID`, `CURSOR_AGENT`,
`GROK_SESSION_ID`, and the rest of `LEAD_MARKERS`) after the lead has
detected itself from them, so a partner that runs this helper in turn does not
take itself for the lead's CLI or account; provider auth and config variables
pass through.

`--model latest:<family>` resolves before the first run: Codex through
`codex app-server` `model/list` on the identity's own account and the
recorded binary, following `nextCursor` across every page (a repeated cursor
or more than twenty pages refuses); Grok through
`grok models`, taking only lines that are exactly `<family>-<version>` plus
the CLI's own annotation, so `grok-4.7-preview` is another model and never a
truncated `grok-4.7`; Cursor through `cursor-agent --list-models` together
with `--effort` (the resolved ID carries the effort, so no `[effort=…]` suffix
is added). Cursor picks the newest plain version first and only then requires
the effort there: a newest version that lacks it refuses and names the older
ID to use explicitly, instead of downgrading. Claude passes the documented
alias (`fable`, `opus`, `sonnet` — `claude --help` names them as aliases for
the latest model) to the CLI, whether written as `latest:fable` or bare
`fable`, and records the exact ID from the init stream's `system.init.model`;
a CLI-default or explicit-ID Claude run is recorded the same way, and every
resumed turn passes that exact ID. The requested form stays in `model` and
the pick in `model_resolved`, with `model_source` and `resolved_at`; a Codex
pick also records the catalog IDs considered, the effort list that validated
`--effort`, the binary, and the page count. A plain `latest`, an unknown
family, a hidden or promo entry, an effort the catalog does not offer, or two
members tied at the newest version refuse before a session exists. A Claude
alias that resolves outside its family, or a bootstrap the CLI marks
`is_error`, refuses after the bootstrap run: that run's session exists in
Claude's own store, but no pair state is recorded and there is nothing to
end. OpenCode has no family resolution.

The helper records model and effort in session state. Claude receives
`--effort low|medium|high|xhigh|max` on every invocation and `--model
<model_resolved>` on every resumed turn, so a moving alias never changes a
live session; Codex receives
`model_reasoning_effort`, Grok `--reasoning-effort`, and Cursor an
`[effort=…]` suffix inside `--model` (so Cursor needs a model). OpenCode
receives `--variant <effort>` on every invocation. Resume keeps the recorded
session and its settings; the CLI's own help is the authority for any value not
named in [`models.md`](models.md).

Then send the first `task`, splitting scopes and write leases as `SKILL.md`
describes.

Done when `init` reports a `sid` and the first `task` has a terminal
`status: "replied"` receipt.

## Send

Write only the body to a temp file, then invoke:

```bash
BODY=$(mktemp); trap 'rm -- "$BODY"' EXIT
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

The worker tees streaming output to the state directory's `transcripts/`, waits
on an idle and a total deadline (`--idle-min`, `--total-min`), and writes the
final receipt to a temporary file before renaming it into place. For a Git
worktree that transcript path is `<git-dir>/pair/transcripts/`; for a plain
directory it is under the fallback above. The worker releases the lock only
after that rename. `wait` reads only a complete receipt:

```bash
node "$PAIR_SCRIPT" wait --repo "$REPO_ROOT" [--seq "$SEQ"]
```

A writable `kind=task` turn defaults to a 45-minute idle budget and a
120-minute total budget — a delivery turn runs the repository's own CI, which
alone can take an hour; every other turn and `init` default to 20 idle and 60
total. Explicit `--idle-min`/`--total-min` replace those defaults, and a
hang-kill receipt names the flag to raise. The session preamble tells the
partner to keep tool output flowing during long turns, so useful activity
resets the watchdog.

Time the partner spends queued for the devbox heavy-work slot is not its
work. On Linux the supervisor walks `/proc` every ten seconds
(`PAIR_HEADLESS_QUEUE_PROBE_MS` changes the cadence) for an `agent-run heavy`
process under the partner that has not yet spawned its worker — that is a
job blocked in the machine-wide queue. While one is found, the total budget
pauses and the idle clock counts the wait as activity; when the slot is
granted the idle clock restarts. The in-flight marker carries
`heavy_queue: {queued, since, job, seconds, episodes}` for `status` to show,
and the receipt records the excluded `heavy_queue` total. Size `--total-min`
to the validation's own run time, not to the queue. Without `/proc` nothing
is detected and the plain budgets apply.

Never wrap `send`, `wait`, or `init` in `agent-run heavy`: the partner's own
validation commands take the slot when they run, and a send held inside it
occupies the one machine-wide slot for the whole turn — every other unit's
validation then queues behind an idle model session (observed 2026-09-11, a
180-minute send holding the slot with three units waiting). The helper is a
light launcher; run it directly.

With no `--seq`, `wait` follows `state.seq`, not the in-flight marker, so a
fast turn that already cleared its marker is still waitable. `--seq` selects an
older turn. The default wait timeout is 125 minutes — the largest default total
budget plus slack; pass `--timeout-min N` when the turn needs a different
bound. If the worker is dead and no receipt exists,
`wait` returns `reason=worker-lost` immediately instead of waiting for the
timeout. A `running` receipt is not terminal; call `wait` and then read its
`receipt_file`.

`wait` blocks the lead's session for as long as it runs, and a lead harness
kills a long foreground command (exit 137) without a receipt. A lead that must
stay reachable polls with `status` — its `in_flight` marker shows the seq,
start time, partner pid, and any `heavy_queue` — and the transcript's size
and mtime, and reserves `wait` for bounds of a few minutes or for a run in the
harness's own background facility.

Terminal receipts print `{seq, transcript, reply_file, status}` and, when
applicable, `receipt_file`:

- `status=replied`: the partner answered. Read `reply_file` and act on it.
- `status=empty-reply`: the run exited clean with nothing in it. Read
  `transcript` first — the partner may have consumed the prompt and still
  produced no final message, so a resend can duplicate work; for a write-lease
  turn inspect the task directory and `git status` when Git is present before
  resending. A body that names a file path beats a long one.
- `status=failed`: the CLI exited nonzero. Read `transcript` for the reason
  before resending — an auth or rate-limit failure repeats.
- `status=hang-killed`: the turn passed a deadline and was killed. Read
  `transcript` to see how far it got; a killed write-lease turn may have left
  edits, so inspect the task directory and `git status` when Git is present
  before resending. The receipt adds `partial_reply=true` only when nonempty
  assistant text was recovered.
- `status=failed` with `reason=grok-cancelled`: Grok emitted a clean cancelled
  end event. Treat it as a failure, never as `replied` or `empty-reply`.
- `status=worker-lost`: the supervisor died before it could write a receipt.
  Inspect the transcript, lock, and task directory, then recover the marker
  before a new send.
- `status=wait-timeout`: the selected worker has not produced a receipt within
  the wait bound. Inspect `status` and the transcript before choosing a new
  action.

Every terminal receipt from `send` may also carry:

- `heavy_queue: {seconds, episodes}` — time excluded as described above.
- `throttle_signals: {rate_limit_lines, first}` — transcript lines that look
  like a rate limit, 429, quota, or retry notice. Counted, not interpreted: a
  slow or throttled partner is otherwise indistinguishable from a stuck one.
- `rate_limits` — for a Codex partner, one read-only `account/rateLimits/read`
  through `codex-rpc.mjs` against the recorded identity home and binary right
  after the turn: `{read_at, primary, secondary}` with `window_minutes`,
  `used_percent`, and `resets_at` per window, or `{error}` when the read
  failed. It is the same reading `usage-state.mjs` measures pace from, taken
  where the turn just spent it.

The helper writes a reply file only for a nonempty extracted reply. Grok joins
`text` deltas and leaves `thought` evidence in the transcript; Cursor uses its
final successful `result`; OpenCode joins `text` parts from its raw JSON
events; Codex uses its `--json` event stream and output file.
The stream is the watchdog's liveness signal for Grok (`streaming-json`), Cursor
(`stream-json`), OpenCode (`--format json`), Codex (`--json`), and Claude
(`stream-json`).

After two consecutive proved Grok cancellations, the receipt advises a fork.
The counter increments while the turn owns the lock and resets on the next
terminal non-cancelled result. Inspect the task directory and transcript before
following that advice; cancellation is not proof that the edits are complete.
A fork is the cure for cancellations, so a cancellation on the proved fresh
fork — or two more after any committed fork — records `capability_miss`: that
receipt advises restaffing, and `fork` refuses until a turn returns `replied`
— a failed, empty, or hang-killed turn proves nothing and keeps the miss.

## Fork a cancelled Grok session

Schedule a fork after the cancellation advice:

```bash
node "$PAIR_SCRIPT" fork --repo "$REPO_ROOT" [--retry]
```

The command emits `status=fork-scheduled` and records the target. That output
means the fork runs on the next normal `send`; it does not run a turn by itself.
Forking is an atomic transaction owned by that send. It records
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
`--read-only`. Pass the flag exactly where the lease differs from the role.
Inspect the task files, `git diff` when Git is present, and real validation
output yourself afterwards.

A headless run has no approver: a tool call left waiting for one is denied or
cancelled, never queued. Writable turns therefore run every partner with its
full bypass — Henrique's standing decision (2026-08-22) for the dedicated dev
machines these pairs run on: Codex gets the `danger-full-access` sandbox,
Claude and Grok get `--permission-mode bypassPermissions` (Grok also gets
`--always-approve`, because under `acceptEdits` it cancelled its own tool
calls as "User cancelled" on wp-917), Cursor gets `--force`, and OpenCode gets
`--auto`. Nothing OS-level restrains a writable partner; the write lease,
scope contract, and review gates are the restraint.

Read-only turns keep each CLI's restraining mode: Codex a `read-only`
filesystem sandbox, Claude and Grok `--permission-mode plan`, and OpenCode the
built-in `plan` agent. A Cursor turn writes by default in `--print`, so its
read-only turns are the ones carrying `--mode plan`. Only the Codex mode is an
OS sandbox; the other modes restrain the agent without one.

The transport is half-duplex, so one turn runs at a time. In a Git worktree, a
send takes a lock by creating `<git-dir>/pair/in-flight.json`; in a plain
directory, the lock is beside `session.json` in the fallback state directory.
It records the turn's sequence, `supervisor_pid`, and `partner_pid`, and
refuses over any existing marker while spending nothing. `status` shows the marker
under `in_flight`. When its processes are gone, clear it:

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

`status` prints the sid, partner, role, model, effort, identity,
`identity_home`, `model_resolved`, `model_source`, `resolved_at`, and sequence —
use it to
rebuild state after compaction. Its `session_known` reports a positive absence
only: `false` proves the CLI's session store was readable and did not hold this
session, while `true` also covers a store that could not be read at all, so it
is evidence of loss and never proof of health. It probes the recorded Codex
identity home's `sessions` (`~/.codex/sessions` for `default`),
`~/.claude/projects`, `~/.grok/sessions`, and `~/.cursor/chats`. OpenCode keeps
sessions in a database, so the helper cannot prove an OpenCode session absent
with a filesystem walk; its next resumed turn is the authority.

`scripts/codex-rpc.mjs` is the read-only door to a Codex account for other
helpers: `codexRead(method, params, { codexHome, bin })` runs one short-lived
`codex app-server`, completes `initialize` → `initialized`, and answers
exactly one of `account/read`, `account/rateLimits/read`, or `model/list`
before killing the server (TERM, then KILL after one second). It never starts a
model turn, bounds its output and time, never surfaces the server's stderr,
and selects the account only through `CODEX_HOME` and the binary through
`bin` or `CODEX_BIN`. `codexModelCatalog` follows the catalog's pages,
`listCodexHomes` names the homes on the machine, and `verifyCodexBinary`
proves a binary answers `--version`.

`end` deletes the session directory, and runs
only when the user explicitly asks to end the pair. It refuses while an
in-flight marker exists — wait for the turn or run `clear` first — because
deleting the session mid-turn destroys the running transcript and leaves a
write-lease partner editing with no record.
