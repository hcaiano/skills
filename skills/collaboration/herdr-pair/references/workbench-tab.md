# Workbench tab (lazy, optional)

The workbench is a separate tab in the same workspace where long-running shared processes (servers, dev watchers, log streams) live so the user can flip to it and watch. It does not exist by default — create it only when an agent first needs to run such a process. One-shot test runs don't need it; use the agent's own pane or a temporary split.

## Creating the workbench (once per session)

```bash
WB="$(herdr tab create --workspace "$WS" --label workbench \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["result"]["tab"]["tab_id"])')"

# Record it in the session file so the partner can find it without rediscovering.
scripts/update-session.py workbench.tab_id "$WB"
```

## Running processes inside the workbench

Inside the workbench tab, split panes for whatever you need (server, logs, anything else long-running). Record pane ids in the session file so the partner can read them without rediscovering:

```bash
scripts/update-session.py workbench.server_pane "$SERVER_PANE"
scripts/update-session.py workbench.logs_pane "$LOGS_PANE"
```

## Reading workbench output

Either agent reads workbench output via:

```bash
herdr pane read <pane> --source recent --lines N
```

Whenever you need to check a server's status, tail logs, etc.
