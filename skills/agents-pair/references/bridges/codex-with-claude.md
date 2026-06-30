# Bridge: Codex with Claude

This is the **headless** Claude bridge. The hub (`SKILL.md`) carries the peer
contract; this bridge carries the transport: **active session**, **turn kind**,
**write lease**, and **peer message**.

Claude is autonomous by default. Use the helper's write mode unless the turn is
explicitly constrained; the write lease, not hierarchy, controls who edits what.

## Preflight

1. Confirm Claude is available: `command -v claude`. Done when the command exists,
   or Claude pairing has been reported unavailable.
2. Resolve the workspace: `git rev-parse --show-toplevel` with `pwd` fallback.
   Done when `WORKSPACE_ROOT` is absolute.
3. Check dirty state: `git status --short --branch`. Done when existing dirty
   files are known and protected from the peer write lease.
4. Pick a turn kind and lead. Done when the prompt says whether this is
   `brainstorm`, `review`, `oracle`, `write-pass`, or `constrained`, and who
   holds the write lease.
5. If the user asks for Claude agents, MCP/plugins/hooks, Chrome/IDE, worktrees,
   ultrareview, or "ultracode", read `../features.md` before choosing flags.

## Active Session

Use `consult.sh --active-session` for normal pair turns. It owns session creation,
resume, locking, transcript paths, stream/final JSON capture, and checkpoint
updates. Do not create a new Claude conversation for each user message.

Completion criterion for every Claude call: the helper returns JSON/Markdown
transcripts, `active-session.json` is updated, and Codex has read Claude's peer
message before continuing.

If the stored active session is stale or for a different goal, record why and use
`--new-active-session`. For state recovery, exact paths, constrained/no-tools
turns, or subscription-auth details, read `codex-with-claude-helper.md`.

## Prompt Shape

First turn:

```text
You are Claude collaborating with Codex on the same local repository.

Workspace: <absolute workspace root>
Shared goal: <goal>
Shared skills:
- <skill-name>: <absolute SKILL.md path>; rules for this turn: <brief contract>
Turn kind: <brainstorm|review|oracle|write-pass|constrained>
Write lease:
- owner: <codex|claude>
- target files/areas: <paths or none>
- forbidden changes: <paths, secrets, generated files, unrelated dirty files>
- validation: <checks expected>
- stop: <when Claude should hand back>

Ground rules: peer, write lease, safe changes, peer message.

Ask:
<specific request for Claude>
```

Continuation turns start with:

```text
Answering your last message:
- <answer each Claude question/disagreement>

Next ask:
<delta request>
```

Done when the prompt has one clear ask, a checkable done condition, and a write
lease even for read-only turns (`target files/areas: none`).

## Shared Skills

When a task skill binds Codex, mirror that contract to Claude.

- Add a `Shared skills` block to the prompt with name, absolute `SKILL.md` path,
  why it applies, and the specific rules or references for this turn.
- Pass the same list with repeated
  `--shared-skill name=/absolute/path/SKILL.md` flags.
- For Claude agents or specialists, include the same block in the specialist
  prompt; they do not inherit it automatically.
- If Claude cannot access a skill path, paste the minimal contract into the
  prompt and note the fallback in the transcript.

## Calling Claude

Every normal paired turn uses the helper:

```bash
bash <skill-dir>/scripts/consult.sh \
  --active-session \
  --goal "$SHARED_GOAL" \
  --kind <turn-kind> \
  --prompt "$PROMPT_FILE" \
  --workspace "$WORKSPACE_ROOT" \
  --model opus \
  --effort high \
  --permission-mode bypassPermissions \
  --tools write \
  --pair-turn \
  --shared-skill agents-pair=<skill-dir>/SKILL.md \
  --timeout-seconds 600
```

Use helper `--tools write`; the helper maps that to Claude's write-capable
default tools and adds the workspace. Use `--tools read` or isolated `--tools
none` only for constrained turns. Agents-pair is subscription-auth only: do not
use `--bare`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, or provider API-key auth.

For specialist/write turns, change `--kind`, raise `--effort` only when the risk
justifies it, and add agent/plugin/MCP/settings flags only after reading
`../features.md`.

## Peer Message

Pass `--pair-turn` on every collaborative turn. The helper attaches
`../peer-message.schema.json`, saves a readable `NNNN-kind.md`, and prints
`message_to_codex`, `questions_for_codex`, `continuation_status`, and
`next_owner`.

Codex must, before the next ask:

1. Read `message_to_codex` as a peer message.
2. Answer every `questions_for_codex` and `disagreements` item under
   `Answering your last message:`.
3. Honor or explicitly counter `proposed_next_turn`.
4. Run `validation_requests`, or say why not.
5. Route on `continuation_state.status`: `continue` loops, `blocked` needs Codex
   input, `needs-user` needs the user, and `done` triggers final diff review.

If Claude returns no peer message, record that in the transcript and continue
only after deciding whether the missing handoff is acceptable for this turn.

## Prompt Patterns

- `brainstorm`: use a read-only lease (`target files/areas: none`); ask for
  options, tradeoffs, risks, and a proposed next lease.
- `review`: use a read-only lease; include the real diff summary, files, tests
  run, and findings format.
- `oracle`: use a read-only lease; ask one narrow question and require evidence.
- `write-pass`: Claude holds the write lease; name target files, forbidden
  changes, validation, and stop point.
- `constrained`: use read/no-tools controls for sanitized prompts, secrets-heavy
  workspaces, broken Claude customization, or narrow diagnostics.
