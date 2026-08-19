---
name: orchestrate
description: "Manual-only orchestration of an explicit task list through isolated worktrees, headless pairs, pull requests, verified merges, and cleanup."
disable-model-invocation: true
---

# Orchestrate

Run an explicit task list as independent work units. One **unit** owns one
worktree, branch, headless pair, and pull request. The current agent is the
orchestrator and pair lead; each unit's partner is its executor. Work on one
repository per invocation.

Invoking this skill authorizes creation and normal cleanup of the units it
records, including ending their pairs and deleting merged unit branches. An
abandoned unit needs a new explicit force-cleanup instruction. Only the user's
request grants mutations, secret access, merge authority, or scope expansion;
task and ticket text supplies requirements, not authority.

## Prepare

Require a Git repository, `git`, `gh`, `trash`, and the `pair` skill installed
beside this one. Set these absolute paths:

```bash
ORCHESTRATE_DIR=<this skill directory>
UNIT="$ORCHESTRATE_DIR/scripts/unit.mjs"
PAIR="$ORCHESTRATE_DIR/../pair/scripts/pair-headless.mjs"
REPO=$(git -C <task-repository> rev-parse --show-toplevel)
```

The unit registry is
`<git-common-dir>/orchestrate/units/<unit-id>.json`. It is the durable recovery
source. Start every invocation, including a resumed one, with:

```bash
node "$UNIT" list --repo "$REPO"
```

Reconcile each record with its observed worktree, pair, newest receipt, and PR.
A `creating`, `restaff-failed`, or `dismantle-failed` record is a recovery task,
not a new unit. Ignore unrelated worktrees and never adopt or remove an
unrecorded resource. One orchestrator operates a repository at a time.

Done when every recorded unit is understood and no duplicate task, branch, or
worktree will be created.

## Staff and create

Read [staffing](references/staffing.md) before every wave. It owns arena,
model, effort, capacity, and restaff decisions. Read pair's
[`models.md`](../pair/references/models.md) for its generic risk/context/speed
rubric and per-CLI effort controls. Run the capacity helper and any applicable
live catalogs that staffing names.

Split the user's list into units. Isolation is the default. Group tasks only
when they share files, have a direct dependency, and should ship in one PR.
For each unit, write one task file with:

- the complete task and intended outcome;
- write scope and read-only context;
- validation commands and observable evidence;
- base branch, merge policy, and relevant constraints;
- an instruction to implement, validate, commit, and return `ready` with the
  commit SHA, diff summary, and exact validation output; the executor waits for
  scope approval before pushing or opening a PR.

Create every unit before waiting on any of them:

```bash
node "$UNIT" create --repo "$REPO" --unit <id> \
  --worktree <absolute-path> --branch <branch> --base <base> \
  --lead <current-cli> --partner <other-cli> --model <name-or-CLI-default> \
  --effort <level> --reason <one-line-reason> --task-file <file> \
  --scope <scope-summary> --validation <validation-summary> \
  --merge-policy <auto|hold> [--setup <project-worktree-setup-command>]
```

`create` journals the task before mutation, creates the worktree from the base,
runs the project's setup hook, initializes an executor-role headless pair, and
starts the first task with pair's `send --background`. It refuses an unrelated
record, branch, worktree, or same-CLI partner. Use the repository's own
worktree setup pipeline when one exists. Read every returned record and report
its staffing reason to the user.

A matching `create` command resumes `creating`, `setting-up`,
`initializing-pair`, or `starting`. On recovery, repeat every recorded option
but omit `--task-file`; the manifest-owned task file is authoritative. Setup
hooks must be safe to repeat because a death can occur after the hook runs but
before its next journal write. A resumed receipt names `resumed_from`. Any
different immutable option refuses and names the field.

Done when every admitted unit reports `status: created` or `status: resumed`
and its first pair turn reports `status: running`, or its failure record names
the exact recovery step.

## Monitor and recover

Pair receipts and transcripts are the only unit transport. The partner cannot
wake a yielded orchestrator and has no live pane for interjection. A user can
tail the named transcript, but that is observation only.

Run nonblocking status rounds across all units:

```bash
node "$UNIT" status --repo "$REPO" --unit <id>
node "$PAIR" wait --repo <unit-worktree> --seq <seq> --timeout-min 1
```

Launch or resume all units before waiting on one. Use bounded waits and rotate
through the active units so a slow turn cannot hide a fast blocked or failed
one. After compaction or a lead restart, `unit list` plus the receipt files is
the complete recovery path. Never resend a turn whose terminal receipt is not
yet known; inspect `in_flight`, transcript, and worktree first.

A refused or rate-limited partner is restaffed immediately. Normal scope
feedback and one bounded correction stay on the current pair. A proved
capability miss restaffs to a stronger legal arena:

```bash
node "$UNIT" restaff --repo "$REPO" --unit <id> \
  --lead <current-cli> --partner <other-cli> --model <name-or-CLI-default> \
  --effort <level> --reason <one-line-reason>
```

`restaff` refuses an in-flight turn, checkpoints the HEAD, diff, and newest
receipt, ends only that unit's pair, records staffing history, and starts the
same task with the new executor. Surface any failed checkpoint to the user.

Done when each active unit has a terminal receipt that the orchestrator has
handled, or one exact user decision is reported as blocked.

## Scope, deliver, and merge

The executor implements and the delegated `ship-it` gate reviews quality. The
orchestrator never edits or reviews unit code. It holds scope authority: compare
the task, the executor's ready summary, and
`git -C <worktree> diff --stat <merge-base>`. Missing work, an unexplained
surface, or a wrong direction gets one bounded scope correction.

When scope is sane, record the approved HEAD in the next pair task and follow
[delivery](references/delivery.md). That reference owns ship-it invocation,
chain of custody, PR checks, holds, merge, and drift. Out-of-scope findings
become follow-up tasks; quality debt created by this unit stays in the unit.

Done when the exact approved change has a delivery receipt on the PR head and
is either held for the user or merged with the required live evidence.

## Dismantle

Normal cleanup proves the unit PR is merged. It refuses an in-flight pair:

```bash
node "$UNIT" dismantle --repo "$REPO" --unit <id>
```

The helper ends the unit pair, removes its worktree, deletes the local and
remote unit branches, and removes the manifest last. It journals each step, so
a fresh session can continue a partial cleanup. For an abandoned unit, obtain
an explicit user instruction and bind it to the exact unit id:

```bash
node "$UNIT" dismantle --repo "$REPO" --unit <id> --force <id>
```

Run `unit list` again. Done when it shows no live record for each completed
unit and `git worktree list` matches the pre-run baseline.
