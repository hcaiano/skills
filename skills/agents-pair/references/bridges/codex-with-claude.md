# Bridge: Codex with Claude

You are **Codex**, pairing with **Claude** through the headless `claude -p` CLI. The
hub (`SKILL.md`) carries the pair contract; this bridge is the transport — and it's
just instructions. You drive `claude -p` yourself; there is no helper script. The
local CLI is the source of truth: run `claude --help` for the current flags.

## Preflight

1. `command -v claude`. Done when Claude is available; if it's missing or
   unauthenticated, say Claude pairing is unavailable and continue solo only if safe.
2. Resolve the workspace (`git rev-parse --show-toplevel`) and check `git status`,
   so you know the dirty files and can scope your write lease.
3. Pick the turn kind: `brainstorm`, `review`, `oracle`, or `write-pass`.

## Calling Claude

Send the prompt on stdin and capture JSON, so you get both the result and the
session id:

```bash
claude -p --model opus --permission-mode bypassPermissions \
  --add-dir "$WORKSPACE_ROOT" --output-format json < prompt.md > result.json
```

- **Autonomous and write-capable by default** (`bypassPermissions`, default tools).
  Claude writes code as a normal peer turn, bounded only by the write lease — not
  granted turn by turn.
- **Subscription auth only — never an API key.** Hard invariant: every pair turn
  uses the logged-in subscription, never API key, cloud-provider, or gateway
  credentials. **Verify, don't just scrub:** run `claude auth status` and confirm the
  active method is the subscription; if it's anything else — API key, provider, or an
  active gateway session — abort the turn rather than route it through non-subscription
  auth. Then keep the environment clean as defense-in-depth so a scrubbed call can't
  silently re-introduce one: strip every `ANTHROPIC_*` auth/routing var and all
  cloud-provider toggles/credentials, and neutralize a settings `apiKeyHelper`
  (`--setting-sources`). Never `--bare`. If you can't confirm subscription auth, don't
  run the turn.
- **Constrained turns** (narrow diagnostic): drop bypass, restrict built-in tools
  with `--tools Read,Grep,Glob`, and deny MCP with `--disallowedTools "mcp__*"`
  (`--tools` doesn't affect MCP; `--allowedTools` only auto-approves).
- **Isolated turns** (sanitized prompt, secret-heavy repo): nothing may inject repo
  content. Run `--safe-mode` (disables all customizations in one flag — CLAUDE.md,
  skills, slash commands, plugins, hooks, MCP servers, custom agents/commands)
  together with `--tools ""` (no built-ins), a clean env, and a **fresh** session
  (never `--resume`). Never put secrets in the prompt; if you can't fully lock the
  turn down, don't run it.
- To watch progress live, stream with `--output-format stream-json --verbose
  --include-partial-messages` (all three are needed to actually receive tokens). For
  Claude agents, MCP/plugins, worktrees, or `ultrareview`, see `../features.md`.

## Resuming the session (multi-turn pairing)

Keep one Claude conversation per workspace across turns — don't spawn a fresh one
per message:

- The first call's JSON result carries a `session_id`. Keep it (in your context, or
  a one-line note next to the goal).
- Continue with `--resume <session_id>` on later turns, and re-pass
  `--permission-mode bypassPermissions` (it isn't carried over).
- Run every call from `$WORKSPACE_ROOT` (`cd` into it first). `--resume` looks up the
  session in the current project directory and its worktrees, so resuming from a
  parent/other directory won't find the conversation.
- Start a new conversation when the goal genuinely changes — and always for an
  isolated/sanitized turn (never `--resume` into one).
- For durable goal state that survives context loss, use the hub's shared plan
  (`planning-with-files`) — that's the system of record, not a bespoke session file.

## The prompt

Mirror the goal on the first turn (per the hub): workspace, shared goal, the shared
skills + the rules that bind this turn, your turn kind, and the **write lease**
(owner, target files, forbidden changes, validation, stop point). End with one clear
ask and tell Claude to close with its **peer message** (the hub's format — what it
did, disagreements, proposed next turn + owner, changed files, validation asks).

Claude returns its peer message as text. Read it as a peer's argument, not a verdict,
and open your next turn with `Answering your last message:` before the new ask. Save
the prompt and Claude's JSON if you want a transcript — the JSON records `session_id`,
`is_error`, duration, and tokens.

For advanced surfaces, see `../features.md`.
