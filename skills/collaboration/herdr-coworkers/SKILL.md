---
name: herdr-coworkers
description: Pair Claude and Codex as collaborating peer agents inside herdr. Use whenever the user invokes /herdr-coworkers, asks to use coworkers in herdr, asks to "pair", "team up", "collaborate with codex", "collaborate with claude", "work with the other agent", or anything that means two AI agents should review each other's code and iterate to a finished result inside herdr. ALSO use whenever the agent's terminal input begins with a header in the form `[agent <name> -> <name> kind=<kind> sid=<...>]` — that is partner-agent traffic and the receiver MUST validate the herdr pane/session and respond per protocol, treating the message as machine-to-machine, not as ordinary user input. Trigger on the prefix even if the user did not invoke the skill themselves; the prefix is the protocol's auto-load signal.
user-invocable: true
argument-hint: "[task description]"
---

# Herdr Coworkers

Claude and Codex collaborate as peers inside herdr. One tab, two agent panes, plain-text messages flowing directly between them. The user reads along live and can interject in either pane at any time.

This skill defines the protocol and orchestration. Pane mechanics belong to the `herdr` skill.

## Prerequisite

This skill requires the `herdr` CLI and the separate `herdr` skill to be installed. Before using this skill inside herdr, load/read the `herdr` skill for CLI primitives (`pane list`, `pane get`, `pane split`, `pane run`, `pane send-text`, `pane send-keys`, `wait agent-status`, etc.). This skill does not re-document them. It defines only the coworkers protocol and orchestration rules.

## Why this exists

Two agents already collaborate fine when a human shuttles messages between panes. The bottleneck is the human typing. This skill removes that bottleneck without inventing a new transport: the agents type into each other's panes the same way the human would, but with a structured header so the receiver can tell partner traffic apart from real user input. Everything else (XML, JSON, sockets, inboxes) is over-engineered for the problem.

## Hard rules

1. **Workspace isolation.** Every `pane list` is filtered with `--workspace <my_workspace_id>`, and every returned pane's `workspace_id` is verified before use. Cross-workspace activity is forbidden — even with the flag, defense-in-depth is required because the user explicitly relies on this isolation. If something points outside the workspace, refuse and surface to the user.
2. **Same-tab pair.** The pair lives in exactly one tab with exactly two agent panes. Discovery is filtered to the caller's `tab_id`. Other tabs in the workspace are for unrelated work the user controls manually.
3. **User override always wins.** If the user types in either pane and contradicts a partner message, the user's instruction supersedes the partner's. Surface the contradiction so the user knows it happened.
4. **No retries on spawn failure.** One failed partner spawn = handoff to the user with the recent pane output. Do not loop.

## Message format

Every machine-to-machine message starts with a single header line, followed by a blank line, followed by plain English:

```
[agent <from> -> <to> kind=<kind> sid=<sid>]

<body>
```

- `<from>`, `<to>`: `claude` or `codex`.
- `<kind>`: one of `task`, `review`, `question`, `ready`, `accepted`, `blocked`, `stalemate`, `handoff`.
- `<sid>`: the session id (see Session id).

The header is what the receiver matches on. The body is plain prose — write to a teammate, not to a parser.

### Kinds

- `task` — assign or update work. Mid-flight changes that invalidate the partner's current direction also use `task` with a body that begins `STOP — <reason>`. There is no separate `interrupt` kind on purpose; the state machine stays small.
- `review` — request review of described changes (often paired with file paths and a short summary).
- `question` — ask for clarification before proceeding.
- `ready` — your side of the work is complete. Body summarizes what changed, how it was validated, and any residual risk.
- `accepted` — the partner's `ready` looks good and you have no blockers. Both sides sending `accepted` is the only completion signal.
- `blocked` — you cannot proceed without the user's input. Body names the missing decision concretely.
- `stalemate` — you and the partner have restated the same disagreement at least twice without movement. Body summarizes the disagreement so the user can break the tie.
- `handoff` — final message back to the user. Used when you've hit a progress guard (no progress, blocked, stalemate) or when both `accepted` are in and you're closing out. The body is the report the user reads.

Done = both sides have sent `accepted` for the current task. Stuck = `blocked` or `stalemate` → escalate to `handoff`.

### Session id

The initiator generates `sid` when creating the session: `<unix-ts>-<4-hex>` (e.g. `1715000000-7a3f`). Sortable, debuggable, low collision risk. Bash:

```bash
SID="$(date +%s)-$(openssl rand -hex 2)"
```

Every message must carry the matching sid. A receiver whose on-disk session sid does not match the sid in the message rejects the message as a hard error and surfaces to the user.

## Bootstrap (initiator side)

Triggered by the user invoking `/herdr-coworkers <task>` in either pane. The agent that received the invocation becomes the initiator.

1. Resolve self: `herdr pane get $HERDR_PANE_ID` → `self.workspace_id`, `self.tab_id`, `self.agent`.
2. List panes scoped to the workspace, then narrow to the same tab:
   ```bash
   herdr pane list --workspace "$WS"
   ```
   Filter the result to panes whose `workspace_id == $WS` (defense in depth) and `tab_id == $TAB`.
3. Decide:
   - **Exactly one opposite-agent pane in the tab** → that's the partner.
   - **Zero opposite agents AND the tab contains only self** → spawn (see Spawn flow). After spawning, the new pane is the partner.
   - **Multiple opposite agents** OR **the tab contains an unexpected extra pane** (e.g. a manually-split shell) → stop and ask the user which to pair with, or to clean up the tab. Never guess; this is the failure mode that broke prior pair-program approaches.
4. Generate `sid`. Create `~/.herdr-coworkers/<workspace_id>/`. Write the session file (see Session file) atomically.
5. Send the first message with `kind=task`. The body should include the user's task and a one-line fallback hint as the last line so a partner whose skill description didn't auto-load can still find their footing:
   ```
   [agent claude -> codex kind=task sid=1715000000-7a3f]

   <task body here>

   (Herdr coworkers protocol — if your skill didn't auto-load, run /herdr-coworkers, or follow the [agent X -> Y kind=... sid=...] header format.)
   ```

## Spawn flow

Run only when bootstrap finds zero opposite agents and the tab contains only self.

1. Resolve the partner binary:
   ```bash
   PARTNER_BIN="$(command -v codex)"   # or claude — whichever is the opposite
   ```
   If empty, abort before splitting and handoff to the user. Do not create an empty pane and leave it dangling.
2. Split right with focus retained:
   ```bash
   NEW_PANE="$(herdr pane split "$HERDR_PANE_ID" --direction right --no-focus \
     | python3 -c 'import sys, json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')"
   ```
3. Launch the partner:
   ```bash
   herdr pane run "$NEW_PANE" "$PARTNER_BIN"
   ```
4. Wait for readiness via herdr's detected agent state — never via prompt glyphs (`>` / `›` change with themes and versions):
   ```bash
   herdr wait agent-status "$NEW_PANE" --status idle --timeout 60000
   ```
5. On timeout, capture context and handoff to the user. Do not retry, do not silently close the pane:
   ```bash
   herdr pane read "$NEW_PANE" --source recent --lines 40
   ```
6. After idle, re-verify with `herdr pane get "$NEW_PANE"` that `workspace_id` matches self, `tab_id` matches self, and `agent` is the expected opposite type. Any mismatch → stop and surface.
7. Resume bootstrap step 4 with the new pane as the partner.

## Pre-send checks (every send)

Run these before every `pane send-text` to the partner. Direct pane injection has sharp edges; these checks defuse the common ones.

1. **Identity:** `herdr pane get <partner>` → must still exist; `workspace_id` must match self; `tab_id` must match self; `agent` must match the partner agent type recorded in the session file. Any mismatch → mark session stale, surface to user, stop.
2. **Visible input guard:** `herdr pane read <partner> --source visible --lines 8`. If there's clearly unsubmitted or queued user-authored text in the partner's input buffer, do not clobber it. Ignore agent UI placeholder/suggestion text such as Claude's `Try "how does <filepath> work?"`, empty prompt hints, model/status lines, or similar non-user suggestions. Treat `Press up to edit queued messages` plus visible queued prose as real user input and stop before sending.
3. **Working partner:** if `agent_status == working`, only send if this is an intentional `STOP — ...` interrupt. Otherwise wait for idle:
   ```bash
   herdr wait agent-status <partner> --status idle --timeout <budget>
   ```
4. **Send body via temp file** (safe for quotes, `$`, backticks, multi-line):
   ```bash
   MSG=/tmp/coworkers-msg-$$.txt
   cat > "$MSG" <<'EOF'
   [agent claude -> codex kind=review sid=1715000000-7a3f]

   <body>
   EOF
   herdr pane send-text <partner> "$(cat "$MSG")"
   herdr pane send-keys <partner> Enter
   ```
   Inline send-text is fine for short single-line bodies, but use the heredoc whenever the body might contain shell-special characters.
5. **Verify post-send:** `herdr pane read <partner> --source recent --lines 10`. The header line should appear in history (out of the input buffer). If it's still in the input buffer, the agent likely needs a second `Enter` (some TUIs require it after a large paste) — re-send `pane send-keys <partner> Enter`. If still stuck, surface to the user.

## Receiving

When your terminal input begins with `[agent <X> -> <you> kind=<kind> sid=<sid>]`, treat it as partner traffic, not as a user request:

1. Re-resolve self: `herdr pane get $HERDR_PANE_ID`.
2. Load `~/.herdr-coworkers/<self.workspace_id>/session.json`. If missing, this is a protocol violation — do not invent or adopt session state from the message; surface to the user.
3. **sid match:** the `sid` in the message must equal `session.sid`. Mismatch is a hard error.
4. **Sender match:** the message claims a `<from>` agent. The session file's `partner.agent` must equal that value, and `partner.pane_id` must still resolve (via `pane get`) to a pane in your workspace and tab with that agent type. Any mismatch → reject and surface.
5. Process the message per its `kind`. Then prepare a reply with your own `kind=` and the same `sid`. Run the same pre-send checks before sending.
6. Update the session file atomically: increment `round`, set `last_status[self.agent]` to your reply's kind, update `no_progress_count` per the loop guards.

## Progress Guards

Two LLMs can disagree forever in good faith. Guards are what make the loop safe to leave running.

- **No fixed round cap.** Do not stop merely because the agents have exchanged a certain number of messages. Continue as long as the loop is producing useful artifacts, evidence, decisions, fixes, or narrowed options.
- **No-new-artifact heuristic.** Before each non-final send, self-check: have I produced new code, new test results, a concrete decision, or narrowed an option since my last turn? If five of my own consecutive turns have produced nothing new, I send `kind=handoff` instead of continuing the loop. Increment `no_progress_count` in the session file each time you self-detect "nothing new"; reset it whenever you do produce something new.
- **Self-reported stalemate.** If you have now restated the same disagreement at least twice without partner movement, send `kind=stalemate` with a short summary of the disagreement and what each side wants. Do not keep arguing.
- **User override.** Any user input in either pane wins over partner messages. If the user contradicts something the partner just said, do what the user said and surface the contradiction in your next partner message so the partner knows the ground shifted.

Why these and not a fixed round budget? Time and message count are poor proxies for progress. A long typecheck, server boot, or useful review loop must not force a handoff. Produced artifacts and narrowing decisions are better signals.

## Session file

Path: `~/.herdr-coworkers/<workspace_id>/session.json`. One per workspace; never per-tab, since the workspace is the isolation boundary.

```json
{
  "sid": "1715000000-7a3f",
  "workspace_id": "w...",
  "tab_id": "w...:1",
  "self": { "agent": "claude", "pane_id": "w...-1" },
  "partner": { "agent": "codex", "pane_id": "w...-2" },
  "round": 0,
  "last_status": { "claude": null, "codex": null },
  "no_progress_count": 0,
  "workbench": { "tab_id": null, "server_pane": null, "logs_pane": null },
  "created_at": "2026-05-10T12:00:00Z"
}
```

`self` is from the perspective of whichever agent is reading the file — both agents read the same file but interpret `self`/`partner` from their own viewpoint. (Practical note: the simplest implementation writes the file with the initiator's perspective and the partner mentally swaps the roles when reading. Don't rewrite the file just to flip the labels.)

### Atomic writes

Two agents can race on the round counter. Always write via temp file + rename:

```bash
TMP="$FILE.tmp.$$"
printf '%s' "$JSON" > "$TMP" && mv "$TMP" "$FILE"
```

Pane IDs in this file are cached live handles, not durable identity. Before relying on a recorded pane ID, re-verify it via `pane get` per the pre-send checks. herdr's docs explicitly warn that public pane IDs can compact when panes close.

## Workbench tab (lazy)

The workbench is a separate tab in the same workspace where long-running shared processes (servers, dev watchers, log streams) live so the user can flip to it and watch. It does not exist by default — create it only when an agent first needs to run such a process.

1. Create the tab once:
   ```bash
   WB="$(herdr tab create --workspace "$WS" --label workbench \
     | python3 -c 'import sys, json; print(json.load(sys.stdin)["result"]["tab"]["tab_id"])')"
   ```
   Update `session.json.workbench.tab_id` atomically.
2. Inside the workbench tab, split panes for whatever you need (server, logs, anything else long-running). Record `server_pane` / `logs_pane` ids in the session file so the partner can read them without rediscovering.
3. Either agent reads workbench output via `herdr pane read <pane> --source recent --lines N` whenever they need to check a server's status, tail logs, etc.

One-shot test runs do not need the workbench. Use the agent's own pane or a temporary split.

## Failure handling cheatsheet

- **Spawn launch failed (binary missing or pane never went idle):** handoff to user with `pane read` recent output. Do not retry.
- **Multiple partner candidates / unexpected extra panes in the same tab:** stop and ask the user.
- **sid mismatch in incoming message:** hard error; surface to user. Do not adopt the new sid.
- **Partner pane went away mid-session:** mark session stale, surface to user. The user decides whether to restart.
- **send-text appears to land but Enter didn't submit:** re-send `Enter` once. If still stuck, surface and stop.
- **User typed something in your pane mid-loop that contradicts the partner:** user wins. Apply the user's instruction; tell the partner the ground changed in your next message.

## Closing a session

When both sides have exchanged `accepted` and the work is genuinely done, the side that triggered closure sends a final `kind=handoff` to the user (in their own pane, by emitting it as a normal output, not via `pane send-text`) summarizing what was accomplished. Then `trash ~/.herdr-coworkers/<workspace_id>/` so a fresh session can start cleanly.

`blocked` and `stalemate` paths also end in `kind=handoff` to the user, with the same cleanup. Never leave a stale session file lying around — the next `/herdr-coworkers` invocation will refuse to start if it finds one with live panes.

## Why this isn't pair-program-2

The earlier `pair-program` skill (cmux, XML messages, shared inbox files) had a recurring failure mode: agents thought no partner was available even when one was. That came from cmux's discovery story, not from XML — but the XML/inbox machinery added enough surface area that bugs there hid the discovery problem.

Coworkers takes a different bet: herdr exposes a reliable self-id (`HERDR_PANE_ID` + `pane get`), so discovery is trivially solid. Once discovery is solid, the rest of the protocol can be a single header line on top of plain prose. No XML, no shared file message bus, no socket. Just two agents typing into each other's terminals with enough structure that they can tell partner messages apart from user messages.
