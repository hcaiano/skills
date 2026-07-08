# Delegate — one-time setup

All optional: the skill falls back to model overrides on generic agents without
any of this. Pinning the roster buys two things — the delegation stance lives in
the agent files instead of being restated in every brief, and Claude auto-routes
to these agents from their descriptions even when the skill isn't invoked.

## 1. Orchestrator model

`/model` → the top tier (Fable 5 today) → highest reasoning effort available.
Plan quality is the whole game; effort spent by the orchestrator is repaid by
every delegated slice.

## 2. Pinned subagents

Write these files (or create the equivalents with the `/agents` wizard). Use
`~/.claude/agents/` for all projects, or `.claude/agents/` to scope to one repo.
Agents on disk load at session start — restart or use `/agents` to pick them up.

`~/.claude/agents/deep-reasoner.md`:

```markdown
---
name: deep-reasoner
description: Use for reasoning-heavy phases — architecture, debugging complex issues, algorithm design, tradeoff analysis. Use proactively when a task needs deep thought rather than mechanical execution.
model: opus
---

Think thoroughly, then return a concise conclusion the orchestrator can act on:
the decision, the evidence behind it, and the risks. No transcript, no hedging
filler — if something is genuinely uncertain, say so once and say why.
```

`~/.claude/agents/fast-worker.md`:

```markdown
---
name: fast-worker
description: Use for light tasks that need Claude taste (user-facing copy, UI tweaks) or session tools, and as the builder for well-specified grunt work when Codex is unavailable.
model: sonnet
---

Execute efficiently and exactly to the brief — no scope creep, no refactors
riding along. Report what changed, what you ran to verify it, and nothing else.
```

## 3. Codex plugin

Install the Codex CLI first (`npm i -g @openai/codex`), then in Claude Code:

```text
/plugin marketplace add openai/codex-plugin-cc
/plugin install codex@openai-codex
/codex:setup
```

`/codex:setup` confirms auth and readiness. Without the plugin, one-shot slices
can still go through raw `codex exec` (`references/codex-exec.md`); with no
Codex at all, `fast-worker` builds — you lose the flat-rate pool, not the run.

## 4. Make it the default (optional)

One line in the project's `CLAUDE.md` keeps the stance on without invoking the
skill each time:

> For non-trivial multi-step work, act as tech lead: use the `delegate` skill.
