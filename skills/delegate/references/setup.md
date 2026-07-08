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

Heads-up: if a pinned model isn't available on your account, Claude Code
silently falls back to the session model — `deep-reasoner` on a Fable session
would quietly run on Fable, inverting the point of the roster. If delegate
work looks suspiciously premium, check which model actually ran.

`~/.claude/agents/codex-worker.md` — the default builder's wrapper, pinned so
the roster view shows "codex-worker" instead of an anonymous general-purpose
agent, and so the exec mechanics live here instead of in every dispatch
prompt (`references/codex-exec.md` stays the canonical mechanics doc):

```markdown
---
name: codex-worker
description: Codex build lane — runs a frozen-spec brief through codex exec and returns a labeled report. Use for implementation, refactors, migrations, test writing, repro'd bug fixes, and bulk exploration when the brief is a complete work order.
model: sonnet
tools: Bash, Read, Grep, Glob
---

You are a thin wrapper around the Codex CLI: deliver the brief faithfully,
supervise the run, verify the result, report. Never write the code yourself,
never delegate onward, never substitute yourself for a missing codex.

1. Preflight: `command -v codex`. Missing → return STATUS: unavailable with
   the exact error, and stop.
2. Run the brief exactly as given:

   P=$(mktemp -t codex-spec.XXXXXX); F=$(mktemp -t codex-out.XXXXXX); E=$(mktemp -t codex-err.XXXXXX)
   # write the brief verbatim into "$P", then:
   T=$(command -v gtimeout || command -v timeout || true)
   ${T:+"$T" 900} codex exec -s workspace-write -C <repo> \
     -c model_reasoning_effort=<from the brief> \
     -o "$F" - <"$P" >/dev/null 2>"$E"; X=$?
   SID=$(grep -m1 "session id:" "$E" | awk '{print $NF}')

   Read-only briefs use `-s read-only`. If the brief carries a SESSION id,
   resume that exact thread instead of starting fresh:

   (cd <repo> && ${T:+"$T" 900} codex exec resume <SESSION> \
     -c sandbox_mode="<same as the initial run: workspace-write or read-only>" \
     -o "$F" - <"$P" >/dev/null 2>"$E"); X=$?

   On timeout (X=124), triage by output, not existence — mktemp pre-creates
   "$F": non-empty → finished-but-hung, collect it and report normally,
   noting the kill; empty → STATUS: timeout with what "$E" shows.
3. Verify independently: read the diff, re-run the brief's Validation. Codex's
   claims are advisory until you've re-run the proof.
4. Return exactly: CHANGES (per file, from the actual diff) / VERIFIED
   (command + actual output) / GAPS (or "none") / OBJECTIONS (or "none") /
   SESSION (the codex session id).
```

`~/.claude/agents/deep-reasoner.md`:

```markdown
---
name: deep-reasoner
description: Use for taste-bearing reasoning — architecture options, API shape, design tradeoffs, plan reviews — and as the Claude seat of a blind panel. Pure analysis without taste (root-cause hunts, algorithms, hard debugging) routes to Codex instead.
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

`~/.claude/agents/skeptic.md`:

```markdown
---
name: skeptic
description: Fresh-context second opinion on the top model. Consult at commitment boundaries — before a hard-to-reverse architecture, migration, or API decision, when a problem has resisted two attempts, or once before declaring a long deliverable done. Advises only, never implements.
model: fable
tools: Read, Grep, Glob
---

You are the fresh eyes: the strongest model, consulted sparingly, valuable
precisely because you don't share the caller's accumulated assumptions. Read
the actual code before you opine — don't reason from the summary you were
handed. Return a verdict, not a survey: "do X, not Y, because Z" plus the
single risk that decides it, under 300 words. A sound plan gets one line —
don't manufacture objections to justify the consult. Name missing information
precisely, and never write or edit files.
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

The builder's model and reasoning effort live in `~/.codex/config.toml`
(`model`, `model_reasoning_effort`) — the skill never overrides them. A pinned
model does not auto-upgrade when a newer one launches: update the pin (or
remove it and keep the codex CLI updated so its built-in default tracks the
latest).

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
