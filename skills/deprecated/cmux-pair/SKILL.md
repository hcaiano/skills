---
name: cmux-pair
description: Legacy cmux-based pair programming bootstrap for Claude and Codex talking through cmux surfaces with an XML protocol. Keep this for historical reference and migration only. Prefer herdr-pair for current Claude/Codex collaboration; use this skill only when the user explicitly asks for the old cmux workflow.
user-invocable: true
argument-hint: "[optional task description]"
---

# cmux Pair

Kick off a pair programming session between Claude and Codex over cmux. You are one of the two agents; the other is running in a different cmux surface. The full message protocol lives in your global config (`~/.codex/AGENTS.md` for Codex, `~/.claude/CLAUDE.md` for Claude) under "Pair Programming Protocol (cmux)" - read it before sending anything if you haven't already.

This skill handles session bootstrap only. Once the first message is delivered, the protocol takes over on both sides.

For cmux topology basics (handles, identify, surfaces, flash, health), see the `cmux` skill. This skill assumes you already know those primitives.

## When to use

- User wants live peer collaboration with the other agent.
- Both agents are already running in cmux surfaces (or the user is willing to start one).
- The task benefits from back-and-forth: design review, debugging, cross-checking a plan.

Not a fit for fire-and-forget delegation - use `codex-execute` / `codex-review` skills for that. They use background processes because `cmux send` is unreliable for long commands and creating new workspaces disorganizes the sidebar. Pair-program is for interactive sessions where both surfaces already exist.

## Steps

### 1. Identify yourself and the partner

```bash
cmux --json --id-format both identify
cmux list-pane-surfaces --workspace <caller.workspace_ref>
```

- Your surface is `caller.surface_ref` from `identify`.
- Your hard workspace identity is the caller workspace UUID from the same output.
- Do not use `focused` - that's whichever tab the user is currently looking at.
- `cmux list-pane-surfaces` with no args defaults to the current pane only, so it will miss a partner surface in a different pane of the same workspace. Always pass `--workspace <caller.workspace_ref>` to see every surface in your workspace and nothing outside it.
- The partner surface is the one in your workspace whose title contains the other agent's name (for example `"Claude Code"`, `"Codex"`, `"codex"`). Partner agent name is the opposite of yours.
- Multiple candidates in this workspace -> list them with titles and ask the user which one.
- No partner surface in this workspace -> stop and tell the user: "No <partner> surface found in this workspace - start one in a new cmux tab here first." Do not spawn one yourself, and do not pair with a surface from another workspace.

### 2. Create or validate the workspace session lock

Use one shared session root for both agents:

```text
~/.cmux-pair/workspaces/<workspace-uuid>/active-session.json
~/.cmux-pair/workspaces/<workspace-uuid>/sessions/<session-id>/inbox/
```

Bootstrap owns session creation. Before you send anything:

1. Check whether `active-session.json` already exists for the caller workspace UUID.
2. If it exists, load it and verify the bound surfaces are still alive in the same workspace.
3. If both bound surfaces are healthy, refuse bootstrap - only one active pair session is allowed per workspace.
4. If either bound surface is missing or unhealthy, treat the lock as stale, `trash` the old `active-session.json`, and start fresh.
5. Create a new session ID and write `active-session.json` before the first message is sent.

`active-session.json` should contain:

- `workspace_uuid`
- `workspace_ref`
- `session_id`
- bound surfaces for both agents
- `created_at`
- `cwd` for diagnostics

Receivers must never create or adopt session state from terminal input.

### 3. Check the bound surfaces are alive

```bash
cmux surface-health --workspace <caller.workspace_ref>
```

Validate the caller surface and the partner surface recorded in `active-session.json`. If either surface is hidden, detached, or gone, surface that to the user and stop. Do not send into a dead session.

### 4. Confirm the task

If the user gave a task in the invocation, use it. Otherwise ask one short question: "What should I hand off?"

### 5. Send the init message

Use the partner surface bound in `active-session.json`. Never rediscover a partner during an active session.

Short task, inline:

```bash
cmux send --surface <partner-bound-surface-ref> '<pair-msg from="<you>" to="<them>" workspace="<workspace-uuid>" session="<session-id>" id="1" kind="task"><body>
TASK DESCRIPTION HERE
</body></pair-msg>'
cmux send-key --surface <partner-bound-surface-ref> Enter
```

Long task or anything with quotes/backticks/`$`, use the workspace-scoped inbox:

```bash
PAIR_ROOT=~/.cmux-pair/workspaces/<workspace-uuid>/sessions/<session-id>
mkdir -p "$PAIR_ROOT/inbox"
TS=$(date +%s)
cat > "$PAIR_ROOT/inbox/msg-$TS-1.xml" <<'XML'
<pair-msg from="<you>" to="<them>" workspace="<workspace-uuid>" session="<session-id>" id="1" kind="task">
<body>
LONG TASK DESCRIPTION
</body>
</pair-msg>
XML
cmux send --surface <partner-bound-surface-ref> "INBOX $PAIR_ROOT/inbox/msg-$TS-1.xml"
cmux send-key --surface <partner-bound-surface-ref> Enter
```

Substitute `<you>` / `<them>` with `claude` or `codex`.

### 6. Flash and notify

Draw the user's eye so they can watch the exchange:

```bash
cmux trigger-flash --surface <partner-bound-surface-ref>
cmux notify --title "Pair session started" --body "You -> <partner>" --surface <partner-bound-surface-ref>
```

### 7. Verify delivery

After `Enter`, confirm the peer actually received the message by peeking at their screen:

```bash
cmux read-screen --surface <partner-bound-surface-ref> --lines 10
```

If the message didn't land (for example, the peer's prompt was in a weird state), re-send. If it landed but no reply comes in ~30s, tell the user - the peer may be stuck or idle.

### 8. Hand off

Tell the user in one sentence: "Sent `<task>` to <partner-agent> on `<surface-ref>` in session `<session-id>`. Waiting for their reply." Then wait. When the peer replies (you'll see `<pair-msg>` or `INBOX` in your input), follow the receiving rules from the protocol in your global config.

## Replying (do not skip validation or ping)

Before replying:

1. Re-run `cmux --json --id-format both identify`.
2. Load `~/.cmux-pair/workspaces/<caller.workspace_uuid>/active-session.json`.
3. If there is no active session for the current workspace UUID, stop - do not infer one from the incoming message.
4. If the current caller surface is not your bound surface in `active-session.json`, stop and surface a protocol violation.
5. Confirm the peer surface from `active-session.json` is still healthy. If not, `trash` the stale `active-session.json` and stop.

A reply is not delivered until you `cmux send INBOX` + `send-key Enter` to the bound peer surface. Writing the reply file alone is a silent failure:

```bash
PAIR_ROOT=~/.cmux-pair/workspaces/<workspace-uuid>/sessions/<session-id>
TS=$(date +%s)
cat > "$PAIR_ROOT/inbox/msg-$TS-<id>-reply.xml" <<'XML'
<pair-msg from="<you>" to="<them>" workspace="<workspace-uuid>" session="<session-id>" id="<id>" reply-to="<their-id>" kind="answer">
<body>
REPLY CONTENT
</body>
</pair-msg>
XML

cmux send --surface <peer-bound-surface-ref> "INBOX $PAIR_ROOT/inbox/msg-$TS-<id>-reply.xml"
cmux send-key --surface <peer-bound-surface-ref> Enter
cmux read-screen --surface <peer-bound-surface-ref> --lines 10
```

Only use inbox files that live under the active session path for the current workspace. Any other inbox path is invalid.

## Picking the partner agent

- You are Claude -> partner is `codex`.
- You are Codex -> partner is `claude`.

Multiple partner tabs in the same workspace -> ask which one.

## Common pitfalls

- **Wrong workspace.** Pairing across workspaces is forbidden. If the partner is not in the caller workspace, stop.
- **Split-brain locks.** Never keep separate session state under `~/.codex` and `~/.claude`. Use the shared `~/.cmux-pair/workspaces/<workspace-uuid>/active-session.json`.
- **Receiver-side adoption.** Never create a session from an incoming XML or `INBOX` line. Bootstrap owns session creation.
- **Escaping.** `cmux send` with inline XML breaks on nested single/double quotes, `$`, and backticks. When in doubt, use the workspace-scoped inbox file.
- **Forgetting Enter.** `cmux send` types text but doesn't submit. Always follow with `cmux send-key --surface <peer> Enter`.
- **Wrong surface.** `cmux identify` returns both `caller` and `focused`. Use the bound surfaces from `active-session.json`, not whichever tab is focused now.
- **Silent reply.** Writing a reply XML file without the `INBOX` ping is a silent failure.
- **Stale UI state.** Run `surface-health` before assuming a bound surface is ready.

## Ending

Either side can end the session by sending `kind="done"` through the bound peer surface. After the done message is delivered and verified, clean up the shared lock with `trash` so the workspace can start a fresh session later.
