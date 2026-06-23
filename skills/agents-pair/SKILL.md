---
name: agents-pair
description: "Pair Codex in the Codex app with Claude Code through `claude -p` and related Claude CLI features. Use when the user asks Codex to work with Claude, debate or brainstorm with Claude, have Claude review plans/code, mirror a Codex goal into Claude, use Claude/Codex subagents, run long goal loops, or escalate to Claude-native agents/workflows. For paired UI/frontend work, route design decisions through the impeccable skill."
---

# Agents Pair

Use this skill from Codex when Claude should act as a peer planner, critic,
reviewer, or second implementation brain through Claude Code. It is the Codex
app counterpart to `herdr-pair`: preserve the same useful back-and-forth, but use
headless Claude CLI calls instead of live panes. Codex and Claude are equal
engineers pairing on the same repo: they plan, write, review, and decide
together. Codex carries the user-facing thread and final summary as logistics,
not as authority over the work.

Default to true pair programming, not management. Alternate who leads; both
models propose plans, push back, and write code. Codex must not gatekeep
Claude's writing or pre-decide outcomes Claude should have a real say in. When
they disagree, resolve it with tests, repo conventions, and evidence, not rank.

Claude is invoked as a headless collaborator with explicit prompts, a persisted
Claude session id, JSON result capture, and transcript files. Claude's normal
mode is autonomous and write-capable: `--permission-mode bypassPermissions` with
`--tools default`. Claude is expected to write code as a normal part of pairing,
not only when explicitly permitted. The one hard constraint is mechanical, not
hierarchical: only one agent edits a given file set at a time.

## Preflight

1. Confirm `claude` exists:
   ```bash
   command -v claude
   ```
   If it is missing or unauthenticated, say that Claude pairing is unavailable
   and continue solo only if the task can still be handled safely.
2. Resolve the workspace root with `git rev-parse --show-toplevel`; fall back to
   `pwd` outside a git repo.
3. Check `git status --short --branch` before any edits. Record dirty files in
   the transcript and preserve unrelated user changes. Claude may write in the
   current workspace by default, but each turn still states target files,
   constraints, and forbidden areas.
4. Choose the Claude turn purpose for this task:
   - `brainstorm`: option generation, architecture, tradeoffs.
   - `review`: adversarial plan/code review.
   - `oracle`: hard narrow question with repo context.
   - `write-pass`: focused implementation or test/documentation changes.
   - `specialist-agent`: Claude Code custom agent or workflow for a focused role.
   - `ultrareview`: Claude Code's cloud-hosted multi-agent code review.
   - `ultracode`: combined Codex + Claude specialists/workflows + high-effort
     cross-review for unusually hard work.
5. Detect relevant local capabilities before committing to a profile. The local
   CLI is the source of truth:
   ```bash
   claude --help
   claude agents --help
   claude ultrareview --help
   claude mcp --help
   claude plugin --help
   ```
   There may not be a literal `ultracode` command. If the user asks for
   "ultracode", do not assume a magic command; select the strongest relevant
   profile from Capability Routing.

## Session State

Keep one active pair session per workspace root. Do not spawn a fresh Claude
conversation for each user message inside that session, and do not infer state
from terminal history, old prompts, or loose files.

Create state under:

```text
~/.agents-pair/workspaces/<workspace-hash>/active-session.json
~/.agents-pair/workspaces/<workspace-hash>/sessions/<session-id>/transcript/
```

Use this exact workspace hash recipe so future turns find the same state:

```bash
WORKSPACE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
WORKSPACE_ROOT="$(cd "$WORKSPACE_ROOT" && pwd -P)"
WORKSPACE_HASH="$(printf '%s' "$WORKSPACE_ROOT" | shasum -a 256 | awk '{print substr($1,1,16)}')"
```

Store:

```json
{
  "workspace_root": "/absolute/path/to/repo",
  "session_id": "2026-06-22T120000Z-abcd",
  "claude_session_id": "uuid-from-uuidgen",
  "goal": "user goal copied verbatim or summarized faithfully",
  "model": "opus",
  "effort": "xhigh",
  "capability_profile": "peer-autonomous",
  "status": "active",
  "session_established": false,
  "session_establishing": false,
  "turn": 0,
  "no_progress_count": 0,
  "checkpoints": [],
  "created_at": "2026-06-22T12:00:00Z",
  "updated_at": "2026-06-22T12:00:00Z"
}
```

Use `consult.sh --active-session` for normal pair turns. The helper holds a
workspace lock, loads or creates `active-session.json`, chooses `--session-id`
for the first attempt and `--resume` after success or a failed establish with a
Claude session signal, derives the transcript directory, and updates the stored
Claude session id/checkpoint after success. If the active session is unrelated,
record why and pass `--new-active-session`; goal mismatches otherwise stop
instead of leaking work into the wrong Claude conversation. User instructions
always override old session state.

For long-running goals, update the session after each meaningful checkpoint:
plan accepted, files edited, tests run, Claude reviewed, Codex subagent returned,
blocker found, user changed direction, or no-progress detected. This lets Codex
resume with the current goal state instead of rediscovering the work.

After every successful Claude call, ensure the returned JSON `session_id` is
written back to `claude_session_id`. Set `session_established: true` only after
the first successful turn. Reusing `--session-id` for later turns fails; active
session mode handles this automatically. Use explicit `--session-id`/`--resume`
only for recovery or a deliberately separate Claude conversation.

After non-`claude -p` Claude surfaces, still update the same session state:
record the command, output path, related background-agent id or review id,
checkpoint summary, files changed, and next action. `active-session.json` is the
handoff contract between long loops, not just the `claude -p` resume handle.

## Capability Routing

Pick the collaboration profile that will materially improve the result. Claude
is an autonomous peer by default; downgrade only for a specific safety reason.

- `peer-autonomous`: default. Run Claude with workspace access, `--tools write`,
  and `--permission-mode bypassPermissions`. Use for goal mirroring,
  brainstorming, implementation, tests, docs, and reviews. Claude writes as a
  peer; permission is not granted turn by turn.
  Alternate leads as the work flows rather than defaulting Codex into the chair.
- `codex-lead`: Codex takes the writing turn while Claude reviews. Use when Codex
  genuinely has the clearer local context or is integrating Claude's previous
  work, not as the standing default. Hand the lead back to Claude on the next
  natural unit of work.
- `claude-lead`: Claude takes the writing turn while Codex reviews. Reach for
  this freely whenever Claude has the clearer context, the better tools/model for
  the slice, or simply hasn't held the pen recently. A healthy session alternates
  `codex-lead` and `claude-lead`.
- `parallel-codex`: spawn Codex subagents for independent exploration, review,
  verification, or disjoint implementation slices. Use when the user asks for
  subagents/parallel work or the task is broad enough to justify explicit
  delegation. Keep write scopes disjoint.
- `parallel-claude`: use Claude background agents or `--agents`/`--agent` for
  focused Claude specialists such as reviewer, planner, tester, migration
  critic, UX critic, security reviewer, or implementer. Use `--mcp-config`,
  `--plugin-dir`, `--plugin-url`, and `--settings` when a specialist needs a
  relevant Claude-native capability.
- `workflow-enabled`: use Claude slash commands, skills, plugins, hooks, MCP
  servers, Chrome, IDE, or project settings when they are relevant to the task.
  These are available by default through the helper; record any special plugin,
  MCP, settings, or raw flag choices in the transcript.
- `codex-app-surfaces`: use Codex app worktrees, thread tools, Git diff tools,
  in-app browser/browser use, Chrome, computer use, image generation, plugins,
  apps/connectors, MCP tools, or automations when those surfaces directly help.
- `ultra-review`: use `claude ultrareview <target>` for cloud-hosted multi-agent
  review of a PR, branch, or large diff when the user asks for it or approves it.
- `ultracode`: compose the strongest relevant local surfaces rather than looking
  for one magic command: Codex plan + Codex subagents + Claude autonomous
  peer turn + Claude specialists/workflows + `--effort max` where useful +
  repeated cross-review + strict validation.
- `constrained`: use read-only/no-tools controls only for sanitized
  prompts, secret-heavy workspaces, broken Claude customizations, or a narrow
  diagnostic where autonomy would add risk without improving output. The helper
  denies MCP tools with `--disallowed-tools "mcp__*"` in `none` and `read` modes
  because Claude's `--tools` flag only limits built-in tools. Do not use
  `--bare`: agents-pair is subscription-auth only, and Claude bare mode skips
  OAuth/keychain subscription auth in favor of API-key-style auth.

Do not escalate automatically just because a feature exists. Escalation should
buy either better search breadth, a stronger adversarial read, domain-specific
craft, or better endurance on a long goal.

## Skill Routing

Pairing does not replace domain skills. Codex should load and follow the best
local skill for the actual work, then use Claude to challenge or complement it.
Any skill Codex loads for the task is shared pair context, not private Codex
context.

- For UI, frontend, product surfaces, app shells, dashboards, landing pages,
  visual polish, UX copy, accessibility, responsive behavior, or design systems:
  use `impeccable` before shaping or editing UI. Pass Claude the relevant
  impeccable constraints and ask for a UI critique against them. Verify visually
  with browser screenshots or equivalent checks before finalizing.
- For library/framework/API details, use current documentation tooling first
  before asking Claude to reason from memory.
- For debugging, PR shipping, PR comment handling, or repo-specific workflows,
  prefer the dedicated local skill and use Claude as reviewer or second opinion.
- For long tasks, goals, research, or migrations, use `planning-with-files`.
  Keep `task_plan.md`, `findings.md`, and `progress.md` as shared pair state,
  pass that skill to Claude, and update the files at checkpoints.

## Shared Skill Context

When Codex uses a useful skill, tell Claude and Claude agents to use the same
skill contract so both agents stay on the same page.

1. Include a `Shared skills` section in every Claude prompt after goal/context:
   skill name, absolute `SKILL.md` path, why it applies, and the specific rules
   or references Claude must honor for this turn.
2. Pass the same skill list through the helper with repeated
   `--shared-skill name=/absolute/path/SKILL.md` flags.
   The helper mounts shared skill dirs only for read turns or skills already in
   the workspace. In write mode, external skill rules must be in the prompt or
   inspected in a read-mode turn first.
3. When using `--agents-json`, `--agent`, or Claude background agents, include
   the same `Shared skills` section in the specialist prompt. Specialists do not
   inherit that context unless Codex gives it to them.
4. Do not paste full skill bodies by default. Give paths and the relevant
   extracted constraints; load reference files only when that skill says they are
   needed for the current turn.
5. If Claude cannot access the skill path, paste the minimal required contract
   into the prompt and record that fallback in the transcript.

When selecting advanced Codex or Claude surfaces, read
`references/features.md`. It covers Codex goals, subagents, worktrees,
automations, browser/Chrome/computer use, plugins/MCP/apps, hooks, image/artifact
tools, and Claude agents, plugins, MCP, hooks, worktrees, JSON schemas,
background agents, and ultrareview.

## Mirroring The Goal

When the user sets a Codex goal or asks for Claude collaboration, send Claude the
same goal before planning or implementation. With `claude -p`, mirror the goal in
the first prompt to the stored `claude_session_id`; do not rely on an interactive
slash command.

If you ever fall back to an interactive Claude surface, send `/goal` as a
standalone input before sending the goal body.

First Claude prompt shape:

```text
You are Claude collaborating with Codex on the same local repository.

Workspace: <absolute workspace root>
Shared goal: <goal>
Shared skills:
- <skill-name>: <absolute SKILL.md path>; relevant rules: <brief constraints>
Your role for this turn: <brainstorm|review|oracle|write-pass>
Autonomous mode: enabled with bypass permissions and default tools.
Edit policy: you are an equal engineer on this repo. Write code whenever it
advances the turn; you do not need Codex's permission to edit. The only limit is
that we never edit the same files at once, so stay within the target files below.
Target files or areas: <paths or "none for this turn">
Forbidden changes: <paths, secrets, generated files, unrelated dirty files>

Ground rules:
- Codex is your equal peer, not your manager; the user is the authority.
- Push back, propose your own plan, and take the lead when you see the better
  path. Disagreement is expected; settle it with tests and evidence, not rank.
- Do not ask the user directly; ask Codex concise questions if blocked.
- Prefer concrete risks, tests, file paths, and decision criteria.
- Do not request or expose secrets.
- Keep scope tight; broad refactors need a clear reason.
- Do not commit, push, merge, deploy, or change credentials.
- End the turn with your peer message (message to Codex, questions, proposed next
  turn, continuation state, changed files, validation asks). Codex will answer it.

Initial ask:
<specific question for Claude>
```

On continuation turns, open the prompt body with an `Answering your last message:`
block that responds to each of Claude's questions and disagreements from the prior
peer message, then state the new ask. This closes the loop so Claude sees its
points were heard.

Save every Claude prompt and response in the numbered transcript directory. Keep
Claude's raw JSON too because it records `is_error`, `session_id`, duration,
turn count, and token use.

## Peer Message Protocol

Every pairing turn is one side of an ongoing conversation, not a one-shot review.
Claude ends each turn with a structured **peer message** back to Codex, and Codex
must answer it on the next turn. This is what keeps the pair a dialogue between
equals instead of Codex driving a subordinate.

Pass `--pair-turn` to the helper on every collaborative turn. It attaches
`references/peer-message.schema.json` and tells Claude to end the turn with this
envelope (`--peer-message` is a compatibility alias):

- `message_to_codex`: Claude's direct peer message: what it did or concluded,
  where it disagrees, what the pair should do next.
- `questions_for_codex`: concrete questions Codex must answer.
- `proposed_next_turn`: who should hold the pen next (`owner`), the goal, target
  files, validation.
- `continuation_state`: `status` of `continue`, `blocked`, `needs-user`, or
  `done`, plus a one-line reason.
- `changed_files`: files Claude actually wrote, so Codex reviews the real diff.
- `validation_requests`: checks Claude wants Codex to run.
- `disagreements`: open objections Claude is surfacing instead of silently
  complying.

The helper renders this as a readable `NNNN-kind.md` transcript and prints
`message_to_codex`, `questions_for_codex`, `continuation_status`, and
`next_owner` in stdout, so Codex can answer without re-parsing raw JSON.

Codex's obligations each turn the loop continues:

1. Read `message_to_codex` as a peer message, not a report to file.
2. Answer every `questions_for_codex` and `disagreements` item in the next prompt
   under `Answering your last message:` before adding a new ask.
3. Honor or explicitly counter `proposed_next_turn`; do not silently reassign the
   lead or ignore Claude's handoff.
4. Run `validation_requests`, or say why not, and report results back.
5. Route on `continuation_state.status`: `continue` means loop, `blocked` means
   answer blockers first, `needs-user` means ask the user, `done` means run final
   diff review.

If Claude returns no peer message, note it in the transcript and continue, but
real pairing turns default to `--pair-turn`.

## Calling Claude

Prefer the bundled helper so prompts go through stdin and responses are captured
as stream JSON, final JSON, and Markdown. The normal pair mode is autonomous:
`--tools write`, `--permission-mode bypassPermissions`, Claude slash
commands/skills enabled, `--add-dir "$WORKSPACE_ROOT"`, and Claude running from
`$WORKSPACE_ROOT`. In Claude Code, `--disable-slash-commands` disables Claude
skills too; pass that flag only for constrained sanitized turns.
`--pair-turn` uses `stream-json` by default, prints bounded live progress
(`status`, tool calls/results, assistant text snippets, final peer message), and
saves the full raw stream as `NNNN-kind.stream.jsonl`. Do not try to read hidden
reasoning; the stream may expose reasoning-block markers or token counts, but the
useful signal is what Claude says, does, and returns.

Every normal Claude turn in a pair session:

```bash
bash <skill-dir>/scripts/consult.sh \
  --active-session \
  --goal "$SHARED_GOAL" \
  --kind plan-review \
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

The first active-session call creates state and uses Claude `--session-id`.
Later calls in the same workspace reuse the stored Claude conversation with
`--resume`. Do not create a new UUID unless starting a deliberately separate pair
session or replacing a stale one with `--new-active-session`.

For specialist and focused implementation turns, use the same shape with
`--kind specialist-review` or `--kind write-pass`, `--effort xhigh`, the same
`--shared-skill` list, and `--agents-json`/`--agent` when using Claude
specialists.

For final high-stakes adversarial review, use `--effort max`. Do this for
architecture, security, production-risk, UI-quality, or large-diff review when
the extra reasoning is likely to change the result.

If you bypass the helper, keep the same defaults unless you are intentionally
running a workflow-enabled pass, and pipe the prompt through stdin instead of
passing large prompt text as a shell argument.

Agents-pair is subscription-auth only. Never configure or suggest
`ANTHROPIC_API_KEY`, `apiKeyHelper`, Console/API-key auth, or `--bare` for this
skill. Claude's docs say bare mode skips OAuth/keychain reads; that conflicts
with the subscription-only contract, so the helper rejects raw `--bare`, rejects
settings that contain `apiKeyHelper`, and unsets `ANTHROPIC_API_KEY` before
launching Claude.

For `--tools none` and `--tools read`, the helper disables slash commands and
denies MCP tools with `mcp__*` so constrained prompts stay compatible with
Claude subscription auth while avoiding broader Claude surfaces. In `none`, it
also appends a system prompt telling Claude it has no tools and must not narrate
or simulate tool calls. Use these modes only as safety escape hatches; normal
agents-pair turns stay autonomous.
The helper rejects `--active-session --tools none` because an active session can
resume prior Claude conversation history; run isolated no-tools consults with an
explicit fresh `--session-id` and `--out-dir` instead. It also rejects explicit
`--tools none --resume <session>` for the same reason.
For `--tools none` and `--tools read`, the helper also denies MCP tools with
`mcp__*` so configured external/private MCP servers are not still callable.

When plugins, MCP configs, settings, custom agents, hooks, or raw Claude flags
are added for a turn, record why in the transcript and keep the target files
scoped. The goal is stronger shared work, not hidden background changes.

If the target is a PR or branch and the user explicitly wants or approves a
cloud-hosted Claude review, `claude ultrareview <target>` is available on this
machine. Treat it as an optional external review surface, not the default
pairing transport.

## Collaboration Loop

1. **Clarify goal.** Restate the user goal and constraints. Mirror it to Claude.
2. **Select capabilities.** Decide which Codex tools, Codex subagents, Claude
   profile, domain skills, and docs lookups are worth using for this goal.
3. **Debate the plan.** Before major edits, have Codex and Claude challenge the
   plan for failure modes, missing tests, simpler alternatives, and
   domain-specific skill gaps. Reach a shared decision; neither model finalizes
   the plan unilaterally when the other has an open objection.
4. **Alternate lead turns.** Codex and Claude take turns holding the pen. Either
   may take a `write-pass`; hand the lead back and forth as the work moves rather
   than parking it with one model. Default to giving Claude real writing turns,
   not just review turns. Multiple agents may work in parallel only when write
   scopes are disjoint. Each write turn names target files, forbidden changes,
   expected validation, and when to stop.
5. **Checkpoint on new evidence.** On long goals, loop through checkpoints:
   after substantial edits, failed tests, changed assumptions, runtime evidence,
   UI screenshots, subagent results, Claude background-agent results, or
   external-review findings. Ask the peer model only when there is new
   information to evaluate or a real decision to make.
6. **Review the actual diff.** After each write-pass, the other peer reviews
   `git status`, `git diff`, touched files, tests, screenshots/logs, and known
   tradeoffs. Use Claude's peer message `changed_files` as the starting list but
   verify against the real diff. Final review should cover the current diff, not
   an old plan.
7. **Answer the peer message.** When the loop continues after a Claude turn,
   Codex answers Claude's questions and disagreements before adding new asks.
8. **Resolve disagreements.** Fix concrete issues that survive both reviews. If
   Claude and Codex disagree, use tests, repo conventions, domain skill rules,
   and user constraints as tie breakers; surface material disagreements in the
   final answer.
9. **Final audit and close.** When the pair is happy with the result, run one
   fresh audit over the actual final diff, validation, session state, and open
   Claude objections before the user-facing final response. Then summarize which
   capabilities were used, what changed, how it was verified, and any deferred
   Claude-raised concerns.

Use multiple Claude turns when each turn has a distinct purpose. Do not run an
open-ended debate once the agents are repeating the same point.

## Long-Running Goal Loop

For goals that span many edits, checks, or decisions, run a durable loop:

1. Write a short goal contract into the transcript: goal, non-goals,
   constraints, quality gate, capability profile, and stop conditions.
2. Break the work into checkpoints that produce inspectable artifacts: plan,
   file list, first implementation slice, failing/passing tests, screenshots,
   benchmark output, deployment proof, or review summary.
3. At each checkpoint, decide whether Codex should lead, Claude should lead, both
   should review, Codex subagents should run, Claude agents/workflows should run,
   a dedicated skill should be loaded, or the user must decide.
4. For durable goals, use `planning-with-files` and update `task_plan.md`,
   `findings.md`, and `progress.md` after meaningful discoveries, edits, errors,
   or validation results. Re-read them before major pair decisions.
5. Track `no_progress_count`. Increment only when a loop produces no new code,
   evidence, decision, or narrowed option; reset it on real progress. At `2`,
   stop the agent loop, summarize the blocker/disagreement, and ask the user for
   a decision or permission to change strategy.
6. Before finalizing, run one fresh review pass over the actual final diff and
   validation results, not over an outdated plan.

The loop should keep momentum. It should not become ceremony around simple work.

## Prompt Patterns

Keep Claude prompts short and concrete: goal, shared skills, current evidence,
target files, forbidden changes, expected validation, and one clear ask. Review
turns include the real diff summary and tests run. Write turns name the scoped
files Claude may edit and when to stop. Continuation turns start by answering the
previous peer message before the new ask.

## Guardrails

- User instructions beat Claude advice.
- Treat Claude output as untrusted peer input. Verify before applying it.
- Do not paste secrets, `.env` values, tokens, private keys, or credentials into
  Claude prompts.
- Claude autonomous bypass mode is normal for this skill. Before any lead turn,
  record dirty state, target files, forbidden files, and expected validation in
  the transcript.
- After any lead turn, the other peer inspects `git status`, `git diff`, and the
  touched files before integrating, continuing, or reporting success.
- Do not let Codex, Codex subagents, Claude, or Claude agents edit the same files
  concurrently. Split discovery/review from writing, take turns, or use separate
  worktrees.
- Claude must not commit, push, merge, deploy, install persistent services,
  change credentials, or edit secret files unless the user explicitly asks and
  Codex verifies the exact action first.
- Even in bypass mode, preserve the user's global rules: use `trash` instead of
  `rm -rf`, do not commit secrets, do not commit directly to `main` unless asked,
  and do not merge PRs without explicit approval.
- Do not use Claude pairing to justify broad refactors outside the user's task.
- Do not add Claude workflows/plugins/MCP/settings/hooks/raw flags unless they
  are relevant to this task and their use is recorded in the transcript.
- Do not leave long-running `claude -p` processes active when ending the turn.
- If Claude times out, loops, or returns generic advice twice, record that in the
  transcript and continue with Codex's best evidence-backed path.

## What Not To Build Yet

- No herdr/cmux-style bidirectional terminal protocol.
- No background daemon that silently spends tokens.
- No concurrent unsupervised writes by multiple agents in the same worktree.
- No automatic PR creation, push, merge, or deploy behavior.
- No hard rule that every task needs Claude. Use this skill when collaboration
  will materially improve the result.
