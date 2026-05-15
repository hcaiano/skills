---
name: check-logs
description: Navigate the turborepo dev TUI inside herdr to read a specific app's logs and answer questions about it. Use whenever the user says "/check-logs", "check logs of <app>", "what's happening in <app>", "is <app> running", "look at the dev output for <app>", or asks log questions about an app while a `bun dev` / `turbo run dev` TUI is open in another herdr pane. Read-only — only sends arrow keys / `/` search to switch which task is visible; never starts, stops, or restarts the server.
user-invocable: true
argument-hint: "[app name, e.g. cms or frontend]"
---

# Check Logs

The user already has a turborepo dev TUI running in another herdr pane (typical command: `bun dev`). Your job is to find that existing pane, focus the task the user asked about, read its logs, and answer. **Never start a new dev server from this skill.**

If the user gave an app name in the argument, use it. If not, infer from context — the most recent app they were editing, what they just mentioned, or what shows a failure glyph (`⨯`) in the sidebar.

## What you need to know about the turbo TUI

- The screen has two columns: a **sidebar** on the left listing every task (e.g. `@gam3s/frontend#dev`, `//#dev:cms`, `@gam3s/backend#dev`), and a **log column** on the right showing the currently-selected task's stdout/stderr.
- The sidebar has glyphs: `»` for running, `⨯`/`✗` for failed. The header at the top of the right column is `<task-name> > <message>` — that tells you which task you're actually looking at.
- **Only the focused task's logs appear in the buffer.** Other tasks' output is not in scrollback until you select them.
- Keybinds (turbo ≥ 2.x): `↑`/`↓` or `j`/`k` move sidebar selection (also swaps the log column), `/` opens a search/filter, `u`/`d` scroll logs, `U`/`D` page logs, `t`/`b` jump to top/bottom of the focused task's logs, `m` shows the keybind help.
- **Never press `q`** (quits the TUI) **or `i`** (gives the user's keyboard to the running process). Use `Enter` only to confirm a `/` search selection — outside search it can focus/interact depending on TUI state. The skill is read-only.

## Steps

### 1. Find the existing turbo TUI pane

```bash
herdr pane get "$HERDR_PANE_ID"           # capture your workspace_id
herdr pane list --workspace <workspace_id>
```

Only inspect panes in the same workspace, and skip your own agent pane. Read likely panes with:

```bash
herdr pane read <pane_id> --source visible --lines 80
```

Use a pane only if the visible buffer has clear turbo TUI evidence: a left sidebar with task rows like `<pkg>#dev` / `//#dev:<app>` / `<app>:dev`, plus a right log column or turbo-specific strings such as `Tasks:`, `cache bypass`, `cache hit`, `Packages in scope:`, or `command finished with error`. Conversation panes, diffs, and shell history that merely mention `turbo` or `bun dev` are not enough.

If no existing pane matches, stop and tell the user: "No existing turborepo dev TUI found in this workspace. I did not start one." Do not start one yourself.

### 2. Select the target task

Match the user's app name against sidebar entries. The user typically says `cms`, `frontend`, `backend`; the sidebar entry is the full package/task name like `//#dev:cms` or `@gam3s/frontend#dev`. Match by substring, case-insensitive.

If you are unsure whether `/` is search in this turbo version, press `m` first and read the keybind help. Don't guess with random keys.

Fastest way — use `/` to filter:

```bash
herdr pane send-keys <turbo_pane> /
sleep 0.3
herdr pane send-text <turbo_pane> 'cms'   # or whatever the user said
sleep 0.3
herdr pane send-keys <turbo_pane> Enter
sleep 0.5
herdr pane read <turbo_pane> --source visible --lines 60
```

If `/` search is unavailable or confusing, fall back to arrow keys manually:

1. Read the screen.
2. Check the **right-column header** (the line at the top of the right pane, e.g. `//#dev:cms > ...`), **not the sidebar**. Stop only when that header names the target task.
3. If the target is only visible in the sidebar, press `Down` once.
4. Read again.
5. Repeat, capped at about 20 keypresses or the number of visible task rows.

```bash
herdr pane read <turbo_pane> --source visible --lines 60
herdr pane send-keys <turbo_pane> Down
sleep 0.3
herdr pane read <turbo_pane> --source visible --lines 60
```

Do not automate the stop condition with a substring match. The sidebar always contains the target name, so `grep cms` or `case *cms*` will false-positive before the log column is focused.

### 3. Read and answer

Once the target task is focused, its logs fill the right column. Read a generous window:

```bash
herdr pane read <turbo_pane> --source visible --lines 200
```

If the logs are long, scroll within the task:

```bash
herdr pane send-keys <turbo_pane> b   # jump to bottom (most recent)
herdr pane send-keys <turbo_pane> U   # page up
```

Then answer the user. Quote the relevant log lines verbatim (errors especially — they're the evidence). If logs look clean, say so plainly: "frontend looks healthy — last output is `ready in 1.2s`, no errors in the visible buffer."

## Don'ts

- Don't press `q` or `i`. Ever, unless the user explicitly asked you to stop or interact with the TUI.
- Don't restart the dev server to "get a clean run" — that destroys the evidence.
- Don't invent errors. If the logs look fine, the answer is "looks fine, here's what I see."
- Don't paste 500 lines of raw output. Trim to what's relevant, preserve error lines exactly.
