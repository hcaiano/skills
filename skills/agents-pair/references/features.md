# Agents Pair Feature Playbook

Use this reference when selecting advanced Codex or Claude surfaces for a paired
task. Use features only when they move the task forward.

## Codex Surfaces

- Goals: mirror the Codex goal into Claude's first prompt and the pair session
  state. Carry the goal contract through checkpoints until complete, blocked, or
  changed by the user.
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

- `claude -p`: default transport for paired turns. Capture stream JSON, final
  JSON, and Markdown.
- `--resume`: required after the first successful Claude turn; do not reuse
  `--session-id` for continuation.
- `--permission-mode bypassPermissions`: normal agents-pair mode. Pass it on
  resumed turns too because bypass mode is not automatically carried over.
- `--tools default` and `--add-dir "$WORKSPACE_ROOT"`: normal tool surface for
  autonomous peer work.
- `--effort`: use `high` or `xhigh` for normal hard work; use `max` for
  architecture, security, production-risk, UI-quality, or large-diff review.
- `--agents`/`--agent`: create focused Claude specialists for repeated roles or
  one-off expert passes.
- `claude agents`: use Claude background agents for parallel independent
  sessions that Codex can monitor. Poll with `claude agents --json` and store
  each session id plus summary in the transcript.
- `--mcp-config`, `claude mcp`, `--plugin-dir`, `--plugin-url`, `--settings`:
  load relevant Claude-native tools, plugins, and settings for the turn instead
  of asking Claude to reason from memory.
- `--json-schema`: require structured Claude output when Codex needs to parse
  decisions, findings, file lists, or next actions reliably.
- `--output-format stream-json`, `--include-partial-messages`, and helper
  `--stream`: monitor observable Claude progress during long turns. Use the
  bounded live monitor for status/tool/text snippets and inspect
  `*.stream.jsonl` only when needed. This does not expose hidden reasoning.
- `--pair-turn`: the default for real pairing turns. Attaches the bundled
  peer-message schema and makes Claude end each turn with a message back to Codex
  (direct message, questions, proposed next turn, continuation state, changed
  files, validation asks). Codex must answer that message on the next turn. See
  the Peer Message Protocol in SKILL.md. `--peer-message` is a compatibility
  alias.
- `--max-turns` and helper timeouts: bound runaway turns without weakening
  Claude's default autonomy.
- `--chrome`, `--ide`, `--from-pr`, `--worktree`, `--tmux`,
  `--prompt-suggestions`, and raw `--claude-arg`:
  use only for a concrete task need and record the reason in the transcript.
- `claude ultrareview`: use for approved cloud-hosted multi-agent code review of
  PRs, branches, or large diffs. Prefer `--json` when Codex needs to triage and
  fold findings into the checkpoint loop.

## Concrete Claude Patterns

Inspect Claude background agents started under this workspace:

```bash
claude agents --cwd "$WORKSPACE_ROOT" --json
```

Run a workflow-enabled Claude turn. Claude skills/slash commands are available
by default; add plugins/MCP/settings only when relevant:

```bash
bash <skill-dir>/scripts/consult.sh \
  --session-id "$CLAUDE_SESSION_ID" \
  --resume \
  --kind workflow \
  --prompt "$PROMPT_FILE" \
  --out-dir "$TRANSCRIPT_DIR" \
  --workspace "$WORKSPACE_ROOT" \
  --permission-mode bypassPermissions \
  --tools write \
  --plugin-dir "$PLUGIN_DIR" \
  --timeout-seconds 1200
```

Run an isolated Claude worktree experiment when the write scope may conflict
with the current checkout. Capture the returned transcript/output path and
inspect before copying changes back:

```bash
claude -p \
  --worktree agents-pair-experiment \
  --permission-mode bypassPermissions \
  --tools default \
  --effort xhigh \
  --output-format json < "$PROMPT_FILE" > "$TRANSCRIPT_DIR/worktree.json"
```

Run approved cloud-hosted multi-agent review and capture machine-readable
findings for triage:

```bash
claude ultrareview "$TARGET" --json --timeout 30 \
  > "$TRANSCRIPT_DIR/ultrareview.json"
```

For each pattern, write a checkpoint summary that names the command, output
file, changed files if any, findings accepted/rejected, and next action.
