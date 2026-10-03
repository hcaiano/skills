---
name: t3-capacity
description: "Choose the T3 Code provider instance, model, and effort from live account usage. Use before any T3 `delegate_task`, `t3_thread_launch`, or `create_threads` call, and when a T3 child hits a usage limit."
---

# T3 capacity

Staff T3 Code work on the account with room for it: a child task through
`delegate_task`, or a top-level thread the user asked for. MCP calls have no
skill hook, so this skill runs when its description matches the work; the
optional [instruction line](#stronger-discovery) makes that consistent.

`pair`'s [roster](../pair/references/models.md) owns routing, seats, families,
effort, and pool rules. This skill adds T3's live catalog and the proof that
ties a T3 instance to the pool it bills. `$SKILL_DIR` is this skill's
directory; `pair` must be installed beside it.

## 1. Set the bar and read the catalog

Set the bar before any quota is read: pair's
[routing rules](../pair/references/models.md#route-the-work) and
[seats](../pair/references/models.md#seats) give the family, effort, and
fallback the task needs. Quota later moves work between routes that clear
this bar; it never lowers it.

Call `orchestrator_capabilities`. An instance is runnable when
`canRunChildTask` is true and `constraints` is empty. The candidates are
runnable instances whose catalog carries the family's newest model. Take
instance, model, and option IDs only from this result: CLI IDs, a native
tool's model list, and remembered IDs go stale, and option IDs differ by
driver (`reasoningEffort`, `effort`, `reasoning`, `reasoning_effort`).
Instance IDs are names on this installation, not an inventory to reuse.

## 2. Confirm the T3 server

The readings describe the logins on the machine running this shell, so they
apply only to the T3 server this shell runs under:

- Walk this shell's ancestors (`ps -o ppid=,command= -p <pid>`, from `$$`) to
  the T3 server process. Without one, this shell does not run under T3.
- Take that server's settings file: a data directory in its arguments, or on
  current builds the `settings.json` beside the state database it holds open
  (`lsof -p <server-pid>`, or `/proc/<server-pid>/fd` on Linux). Another T3
  install's settings on the same machine describe another server.
- `t3_environment_read` reports the server's OS and architecture. A mismatch
  with `uname -s` and `uname -m` here means another machine; a match proves
  nothing more, since it names no host.

When a step stays uncertain, run the helper without `--settings` and tell the
user which step failed: every instance then reads `unknown`.

## 3. Read capacity

```bash
node "$SKILL_DIR/scripts/t3-capacity.mjs" \
  --settings <confirmed-settings.json> \
  --instance <providerInstanceId>:<driverKind> [--instance ...] \
  [--auth-home <providerInstanceId>=<login-home>] \
  [--declare <providerInstanceId>=<claude|cursor|grok|codex:<name>>]
```

Pass one `--instance` per candidate. The helper runs pair's usage reader
(Claude, each Codex home, Cursor's two monthly pools), reads the grok.com
login's billing, and joins the readings to instances. It reads only: no
launcher runs, no credential prints, no file changes.

An instance maps only when the settings list it under the driver the
capabilities report, and then only with a `proof`:

- `default-login`: a native CLI with no home override uses the login the
  readers use.
- `same-file`: the instance's login file is the reader's file, by device and
  inode.
- `user-declared`: `--declare`, given only when the user has stated which
  account the instance uses, in this conversation or standing instructions.
  It names an account of the instance's own driver (`codex:<name>`, `claude`,
  `cursor`, `grok`); a declaration never moves billing to another vendor.

A custom launcher can export another login, and instances with different
accounts can share one history home. When a note names a custom launcher,
read that launcher without running it, follow it to the login home it finally
exports (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, `CURSOR_CONFIG_DIR`),
and pass that home as `--auth-home`. Two instances with different launchers
landing on one pool is a misread launcher until a second read confirms it.

On macOS, pair's Claude read uses whichever of the credentials file and the
login Keychain expires last, and the Cursor CLI keeps its login in the
Keychain. No file shows which account those reads used, so Claude maps there
only by declaration, and Cursor by `default-login` or declaration.

An unmapped instance is `unknown`. A pool whose `instances` list is empty was
read but billed by no proved instance. Neither proves headroom.

## 4. Choose

1. Keep the candidates whose pool pair's
   [pool rules](../pair/references/models.md#pools) allow. The instance sets
   the pool, not the model's vendor: Opus or Grok on a Cursor instance bills
   Cursor (`cursor_models` for Grok, Composer, and Auto; `other_models` for
   the rest), never the Claude or Grok subscription.
2. Among available candidates, prefer lower `pace`, then lower
   `used_percent`, then speed; `available` lists mapped pools in that order.
   Spread a wave: count the children already running or assigned in this wave
   per pool, and send the next one to the next pool that clears the bar. A
   ranking reserves nothing; other threads spend the same pools.
3. A `protected` pool takes only work its model does better than every
   available substitute. `unknown` and `unavailable` pools take none. With no
   candidate left, repeat this choice for the seat's fallback.
4. Set effort explicitly, using the option ID the chosen model lists. T3's
   per-model defaults differ, and some Codex models default to low.

The user's explicit instance, account, model, or effort wins. When that
choice is not runnable, or its pool is not `available`, say so in one line
and proceed with it if it can run; otherwise offer the closest eligible
route.

## 5. Launch

- **Child task.** `delegate_task` with
  `target: {providerInstanceId, model, options}`. The child receives only the
  task prompt, so write a complete brief. Keep the returned `taskId`. Async
  completion wakes you; call `task_status` only when this turn needs the
  result, never as a polling loop. A harness's native subagent tool fits only
  when it runs the chosen account and model; another provider, another Codex
  account, or a model native tools lack goes through `delegate_task`.
- **Top-level thread.** Only on the user's explicit request for a separate
  thread or conversation. `t3_thread_launch` sets a `workspaceStrategy`;
  `create_threads` shares the caller's checkout. A child task stays a child
  even when a worktree would be convenient.

Report each choice in one line: instance, model, effort, pool and state,
proof, and any substitution.

## 6. Recheck

Rerun the helper before each wave and after a child fails. A refusal, a rate
limit, or Grok's `402` makes that pool unavailable whatever the reading said;
restaff only the affected task. A running child keeps its account until it
ends: there is no central scheduler and no forced restart.

## Gaps

- T3 reads usage natively but exposes no quota tool over MCP, and no MCP
  field ties a T3 server to a settings file or host.
- Drivers without a reader, such as OpenCode, stay `unknown`.
- Grok reads `unknown` until xAI reports a usage percentage. xAI sends only
  the period's end, so pace rests on an estimated start (`estimated_start`).
  Its "unlimited" plan still has a quota.
- Cursor's reading scrapes the CLI's `/usage` screen and can come back empty.

For any gap, T3's Limits view shows its own reading for each instance; ask
the user what it says rather than assuming headroom.

## Stronger discovery

A line the user can add to their own `AGENTS.md` or `CLAUDE.md`:

```markdown
Before any T3 Code `delegate_task`, `t3_thread_launch`, or `create_threads` call, use the `t3-capacity` skill to choose the instance, model, and effort.
```

On a machine whose T3 instances run custom launchers, the user can append
the proved `--auth-home` and `--declare` flags for that machine to the same
line, so each run starts from them instead of rereading the launchers.
