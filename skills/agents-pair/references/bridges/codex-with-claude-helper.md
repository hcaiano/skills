# Codex with Claude Helper Reference

Use this only when the normal bridge points here: active-session recovery,
constrained/no-tools turns, subscription-auth questions, or helper debugging.

## Active Session State

Normal pair turns use one active session per workspace root:

```text
~/.agents-pair/workspaces/<workspace-hash>/active-session.json
~/.agents-pair/workspaces/<workspace-hash>/sessions/<session-id>/transcript/
```

The workspace hash is:

```bash
WORKSPACE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
WORKSPACE_ROOT="$(cd "$WORKSPACE_ROOT" && pwd -P)"
WORKSPACE_HASH="$(printf '%s' "$WORKSPACE_ROOT" | shasum -a 256 | awk '{print substr($1,1,16)}')"
```

`active-session.json` records workspace, pair session id, Claude session id,
goal, model, effort, status, establishment flags, turn count, no-progress count,
checkpoints, and timestamps. Treat it as the handoff contract between turns, not
as conversational memory.

`consult.sh --active-session` loads or creates this file under a workspace lock.
On the first successful turn it creates a Claude session; later turns resume the
stored Claude session id. If establishment fails after Claude emitted a session
signal, the next helper call resumes that id instead of creating a duplicate.

Use `--new-active-session` only after recording why the previous active session
is stale. If the stored workspace or goal does not match the current task, stop
or replace intentionally; do not leak work into the wrong Claude conversation.

After non-`claude -p` Claude surfaces, checkpoint the same active session with
the command, output path, related agent/review id, changed files, validation, and
next action.

## Constrained Turns

Helper tool modes:

- `--tools write`: normal pair mode. The helper passes Claude `--tools default`
  and `--add-dir "$WORKSPACE_ROOT"`.
- `--tools read`: read-only mode. The helper passes `Read,Grep,Glob`, mounts
  allowed directories, and disables slash commands and skills.
- `--tools none`: isolated no-tools mode. The helper passes an empty tools list,
  disables slash commands and skills, and adds a system prompt forbidding
  simulated tool use.

The helper rejects `--active-session --tools none` and explicit
`--tools none --resume <session>` because no-tools turns must not inherit prior
conversation history. Run them with a fresh `--session-id` and `--out-dir`.

Use constrained modes only for sanitized prompts, secrets-heavy workspaces,
broken Claude customization, or narrow diagnostics where autonomy adds risk
without improving the result.

## Subscription Auth

Agents-pair is subscription-auth only. Never configure or suggest
`ANTHROPIC_API_KEY`, `apiKeyHelper`, Console/API-key auth, provider auth
environment variables, or `--bare`.

The helper preserves this by rejecting raw `--bare`, rejecting raw
`--setting-sources`, disabling default Claude settings sources with
`--setting-sources ""`, rejecting explicit settings containing `apiKeyHelper` or
provider-auth variables, scrubbing provider/API auth variables from the
subprocess environment, and launching Claude with
`CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1`.

## Raw Flags And Surfaces

When plugins, MCP configs, settings, custom agents, hooks, or raw Claude flags
are added, record why in the transcript and keep the write lease scoped. Prefer
the helper's named flags over `--claude-arg`; use raw passthrough only when the
helper has no first-class option.
