# Unit recovery

Read when a record's lifecycle is anything but `working`, when a unit command
returns `ok: false`, or when resuming after compaction or a lead restart. Start
from `node "$UNIT" list --repo "$REPO"` and act on each record's backend state;
Herdr-specific recovery is in [Herdr units](herdr-units.md). Every recovery
repeats the same command with the recorded inputs; the helper journals each
step, so a fresh session continues where the last one stopped.

## Create

`create` journals the task before any mutation, then fetches the base from
`origin`, creates the worktree from `origin/<base>` (the local base only when
origin lacks it) and records that `base_ref` and `base_sha`, adds
`/PR_BODY.md` once to the repository's Git exclude file, runs the setup hook,
initializes an executor-role pair, and starts the first task with pair
`send --background`. The record stores the exclude path, pattern, and first
ensure result. `create` refuses an unrelated record, branch, worktree, or
duplicate issue.

A matching `create` resumes `creating`, `setting-up`, `initializing-pair`, or
`starting`. Repeat every recorded option but omit `--task-file`: the
manifest-owned task file is authoritative. Setup hooks must be safe to repeat,
because a death can land after the hook runs and before its next journal
write. A resumed receipt names `resumed_from`; any different immutable option
refuses and names the field.

A failed new create rolls back what it made. When the rollback itself fails,
the record stays as `create-failed` with a `rollback` list naming each
resource; report it, and clean it with the forced dismantle once the user
gives that instruction.

A recoverable Cursor record that stores a separate effort and has no live pair
resumes with the current effort-specific catalog model and no `--effort`;
`create` records that staffing migration in history. A live recorded Cursor
pair resumes with its recorded inputs.

## Restaff

`restaff` refuses an in-flight turn, checkpoints the HEAD, worktree status and
diff, and newest receipt or Herdr ACK state, ends only that unit's pair,
records staffing history, and starts the same task with the new executor. A
matching retry resumes `restaffing` or `restaff-failed`; any different target
field refuses.

## Dismantle

A `dismantling` or `dismantle-failed` record resumes with the same dismantle
command, including the same `--force <id>` when the original carried it. The
record's `cleanup` list shows each finished step.

## Child-process timeouts

The helper gives ordinary child commands two minutes, pair `send` five
minutes, and setup or pair `init` 30 minutes. A timeout kills the complete
child process group before rollback. Raise a limit only after evidence shows
the default is too short, through the positive millisecond variables
`ORCHESTRATE_COMMAND_TIMEOUT_MS`, `ORCHESTRATE_PAIR_SEND_TIMEOUT_MS`, or
`ORCHESTRATE_LONG_COMMAND_TIMEOUT_MS`; every command keeps a timeout.
