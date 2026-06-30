# Agents Pair Feature Playbook

Use this reference when selecting advanced Codex or Claude surfaces for a paired
task. Use features only when they move the task forward. The local CLIs are the
source of truth — verify flag names with `claude --help` / `codex --help`.

## Codex Surfaces

- Goals: mirror the Codex goal into Claude's first prompt and the shared plan.
  Carry the goal contract through checkpoints until complete, blocked, or changed
  by the user.
- Codex subagents: spawn for explicit parallel work, independent review, repo
  archaeology, verification, log/test investigation, or disjoint implementation
  slices. Keep write scopes separate and integrate results in the main thread.
- Worktrees/threads: use for isolated experiments, parallel implementation, or
  automation runs that should not touch the current checkout.
- Automations/thread automations: use thread wakeups for long loops that should
  return to this conversation; use standalone/project automations for recurring
  independent work.
- Browser and Chrome: use the in-app browser for local previews and public pages
  that do not need the user's profile; use Chrome/DevTools for logged-in state,
  extensions, existing tabs, network inspection, or performance work.
- Computer use: use for GUI-only desktop flows, simulators, settings, or apps
  that do not expose a better API.
- Apps/connectors/MCP/plugins: prefer installed connectors and MCP tools for
  private or live external data; use skills/plugins for reusable workflows.
- Image generation and artifact tools: use for UI assets, design references,
  documents, PDFs, spreadsheets, presentations, or generated visual material when
  they help the deliverable.
- Hooks/rules: respect existing enforcement. Create or change hooks/rules only
  when the user asks for persistent mechanical enforcement.

## Claude Surfaces

You drive `claude -p` directly (see `bridges/codex-with-claude.md`). Reach for
these flags when the turn needs them:

(The bridge owns the core — calling `claude -p`, session resume via `session_id`,
the subscription-auth rule, and the peer message. This lists only the *advanced*
flags on top of that.)

- `--output-format json`, or `stream-json --verbose --include-partial-messages` for
  a live token stream on long turns (neither exposes hidden reasoning).
- `--add-dir "$WORKSPACE_ROOT"`: give Claude the workspace on a write-capable turn.
- `--tools Read,Grep,Glob` + `--disallowedTools "mcp__*"`: constrained turns —
  restrict built-in tools AND deny configured MCP tools (`--tools` doesn't affect
  MCP; `--allowedTools` only auto-approves). For sanitized prompts, secret-heavy
  repos, or narrow diagnostics.
- `--effort`: `high`/`xhigh` for hard work, `max` for architecture, security,
  production-risk, UI-quality, or large-diff review.
- `--agents` / `--agent`, `claude agents`: focused Claude specialists or parallel
  background sessions; poll `claude agents --json` and store each session id +
  summary.
- `--mcp-config`, `claude mcp`, `--plugin-dir`, `--plugin-url`, `--settings`: load
  relevant Claude-native tools, plugins, and settings for the turn.
- `--json-schema`: structured Claude output when you need to parse decisions,
  findings, file lists, or next actions reliably.
- `--max-turns` and timeouts: bound runaway turns without weakening autonomy.
- `--chrome`, `--ide`, `--from-pr`, `--worktree`: use only for a concrete task need.
- `claude ultrareview <target> --json`: approved cloud-hosted multi-agent review of
  PRs, branches, or large diffs; fold findings into the checkpoint loop.

## Concrete Claude Patterns

Inspect Claude background agents started under this workspace:

```bash
claude agents --cwd "$WORKSPACE_ROOT" --json
```

Run a workflow-enabled Claude turn (skills/slash commands are on by default; add
plugins/MCP/settings only when relevant):

```bash
claude -p --resume "$SESSION_ID" \
  --permission-mode bypassPermissions \
  --plugin-dir "$PLUGIN_DIR" \
  --output-format json < "$PROMPT_FILE" > "$TRANSCRIPT_DIR/workflow.json"
```

Run an isolated Claude worktree experiment when the write scope may conflict with
the current checkout; capture the output and inspect before copying changes back:

```bash
claude -p --worktree agents-pair-experiment \
  --permission-mode bypassPermissions \
  --output-format json < "$PROMPT_FILE" > "$TRANSCRIPT_DIR/worktree.json"
```

Run approved cloud-hosted multi-agent review and capture machine-readable findings:

```bash
claude ultrareview "$TARGET" --json > "$TRANSCRIPT_DIR/ultrareview.json"
```

For each pattern, write a checkpoint summary that names the command, output file,
changed files if any, findings accepted/rejected, and next action.
