# Delegate — one-time setup

All optional: the skill falls back to model overrides on generic agents without
any of this. Pinning the roster buys two things — the delegation stance lives in
the agent files instead of being restated in every brief, and Claude auto-routes
to these agents from their descriptions even when the skill isn't invoked.

## 1. Orchestrator model

`/model` → Fable (or the current top-tier Claude model) → highest reasoning
effort available.
Plan quality is the whole game; effort spent by the orchestrator is repaid by
every delegated slice.

## 2. Pinned subagents

The roster's canonical definitions ship with the skill in `agents/` —
`codex-worker` (build + analysis wrapper carrying the exec mechanics),
`deep-reasoner`, `fast-worker`, `skeptic`. Don't hand-copy their contents;
install one of two ways:

- **Claude Code plugin install**: nothing to do — the plugin manifest loads
  them automatically, namespaced (`hcaiano:codex-worker`).
- **skills.sh or manual install**: run the bundled script once —

  ```bash
  bash <skill-dir>/scripts/setup-roster.sh                 # → ~/.claude/agents (all projects)
  bash <skill-dir>/scripts/setup-roster.sh .claude/agents  # → scope to one repo
  ```

  Existing files are never overwritten without `--force`.

Agents load at session start — restart or use `/agents` to pick them up. To
change a definition, edit the file in `agents/` (the single source) and
re-run the script.

Heads-up: if a pinned model isn't available on your account, Claude Code
silently falls back to the session model — `deep-reasoner` on a Fable session
would quietly run on Fable, inverting the point of the roster. If delegate
work looks suspiciously premium, check which model actually ran.

## 3. Codex CLI

Install and authenticate the Codex CLI:

```bash
npm i -g @openai/codex
codex login
```

Confirm it with one read-only `codex exec` probe. `codex-worker` runs raw
`codex exec` (`references/codex-exec.md`); with no Codex at all, `fast-worker`
builds — you lose the Codex lane, not the run.

The builder's model is Codex's own to resolve: a `model` pin in
`~/.codex/config.toml` or, unpinned, the CLI's built-in default — the skill
never overrides it. Default reasoning effort lives in the same file
(`model_reasoning_effort`); per-slice briefs may override only the effort. A
pinned model does not auto-upgrade when a newer one launches: update the pin
(or remove it and keep the codex CLI updated so its built-in default tracks
the latest).

## 4. Companion skills

`delegate` references two skills it doesn't bundle: `tdd` (the red → green
loop and what makes tests worth keeping) and `planning-with-files` (the
`task_plan.md` / `findings.md` / `progress.md` contract with session
recovery). Install implementations with those contracts into your skills
directory (`~/.claude/skills`, or `~/.agents/skills` shared across agents).
Missing them costs the reference, not the run — briefs still carry red → green
inline, and one-sitting runs never need the plan files.

## 5. Make it the default (optional)

One line in the project's `CLAUDE.md` keeps the stance on without invoking the
skill each time:

> For non-trivial multi-step work, act as tech lead: use the `delegate` skill.
