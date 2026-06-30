# Workbench tab (lazy, optional)

A separate tab in the same workspace where long-running shared processes (servers, dev watchers, log streams) live so the user can flip to it and watch. It does not exist by default — create it only when an agent first needs to run such a process. One-shot test runs don't need it; use the agent's own pane or a temporary split.

## Creating the workbench (once per session)

```bash
WB="$(herdr tab create --workspace "$WS" --label workbench \
  | node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).result.tab.tab_id)')"
```

Then record `workbench.tab_id = $WB` in the per-tab session file `~/.herdr-coworkers/$WS/$TAB_SLUG/session.json` (`TAB_SLUG=${TAB_ID//:/_}`) using the same atomic JSON-update pattern from the main SKILL.md.

## Running processes inside the workbench

Split panes inside the workbench tab for whatever you need (server, logs, etc.). Record `workbench.server_pane` and `workbench.logs_pane` in the session file via the same atomic update so the partner can find them without rediscovering.

## Reading workbench output

```bash
herdr pane read <pane> --source recent --lines N
```
