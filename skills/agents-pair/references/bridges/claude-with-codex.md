# Bridge: Claude with Codex

You're Claude Code; your peer is Codex, via the OpenAI **codex** plugin. The hub
(`SKILL.md`) has the pairing rules — this is the transport. Codex is an equal
engineer: delegate real work to it, have it review your diff before you ship, let
it challenge risky designs, and run long jobs in the background while you keep
moving. Verify its output against the real diff before you trust it.

## Two ways in

- **Delegation** → the `codex:codex-rescue` subagent (`Agent` tool,
  `subagent_type: "codex:codex-rescue"`). Write-capable by default. Your
  Claude-driven path for implementation, diagnosis, research, or a second pass.
- **Reviews & jobs** → run `codex-companion.mjs` via `Bash`: `review`,
  `adversarial-review`, `status`, `result`, `cancel`, `transfer`, `setup`. The
  review/job slash commands are `disable-model-invocation`, so you can't fire them
  through the SlashCommand tool — drive the companion directly (invoking this skill
  is the user opting in), and always echo the matching `/codex:` command so they
  can re-run it. The exceptions are `/codex:setup` and `/codex:rescue`, which are
  model-invocable.

Resolve the script once (it finds its own plugin root, so a direct `node` call
works):

```bash
shopt -s nullglob
cands=("$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs)
COMPANION="$(printf '%s\n' "${cands[@]}" | sort -V | tail -1)"
[ -z "$COMPANION" ] && COMPANION="$HOME/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs"
```

(Avoid `ls` here — it can append a `*` to executables and break the path.) If that
finds nothing, don't improvise: tell the user to run `/codex:setup`.

## Preflight

- Confirm Codex is ready: `node "$COMPANION" setup --json` (or `/codex:setup`). If
  it reports missing or unauthenticated, stop and point the user to `/codex:setup`
  — don't roll your own install or auth.
- Know the workspace (`git rev-parse --show-toplevel`); Codex tracks jobs per repo.
- Check `git status` first, so you can tell Codex's edits from pre-existing work
  and never hand Codex files you have open.

## Delegating work

Shape the request operator-style (see Prompting below), then call the subagent.
Embed Codex routing flags in the prompt text — the subagent extracts them:
`--write` (the default; omit only for read-only diagnosis or research), `--resume`
(continue Codex's last thread) or `--fresh`, `--model spark` (maps to
`gpt-5.3-codex-spark`), `--effort <none|minimal|low|medium|high|xhigh>`. Leave
model and effort unset unless the user asked. `--background`/`--wait` don't apply
here — the subagent ignores them; background via the Agent tool's
`run_in_background` instead.

```
Agent(subagent_type: "codex:codex-rescue",
      description: "Codex: <short>",
      prompt: "<shaped task>. Root-cause and patch the failing token-refresh
               test in src/auth/session.test.ts.")
```

For long or open-ended work, run it with `run_in_background: true`, then keep
working on files Codex isn't touching; you're notified on completion, and the job
also shows up in `status`/`result`.

When it returns, **verify before integrating**: read `git diff` and the touched
files, run the tests. If Codex failed or never ran, say so and stop — don't
quietly replace a failed Codex run with your own implementation.

## Reviewing your diff

```bash
node "$COMPANION" review --wait         # small diff
node "$COMPANION" review --background    # larger; detach via the Bash run_in_background flag
```

Add `--base <ref>` or `--scope auto|working-tree|branch` to retarget.
`adversarial-review` takes the same flags plus focus text — use it to challenge an
approach, not just hunt defects:

```bash
node "$COMPANION" adversarial-review --background "focus: tenant isolation, rollback safety"
```

**Review-only — strict.** When findings come back: present them first, severity-
ordered, with exact file:line, keeping Codex's inference-vs-fact distinctions. Then
**stop** — change nothing, not even an obvious one-liner, until the user says which
to fix. Offer `/codex:review` so they can re-run it. A review is a peer message:
weigh it, disagree with evidence, and fold agreed fixes into your next writing turn.

## Background jobs

```bash
node "$COMPANION" status            # this repo's active + recent jobs (--all for older ones)
node "$COMPANION" status <id>       # one job, full detail (add --wait to block)
node "$COMPANION" result <id>       # final output of a finished job
node "$COMPANION" cancel <id>       # stop a running one
```

Show `result` in full. While a job runs, make progress on a disjoint slice and
checkpoint when it lands.

## Prompting Codex

Use the `gpt-5-4-prompting` skill. Prompt Codex like an operator: compact,
XML-tagged, one task per run. Give it `<task>` plus context, the output shape you
want, and what "done" means. Add a verification loop for code, grounding rules for
review/research, an action-safety note for write runs. On follow-ups, `--resume`
and send only the delta instruction.

## Handoff dialogue

The plugin is request/response, not a live channel — realize the hub's
peer-message loop across calls. Codex's output (findings, or a task summary with
next steps) is its reply; read it as a peer's argument, not a verdict. Continue the
same thread with `--resume`, opening with your takeaways and answering its open
questions before the next ask. Don't one-shot a hard problem.

For advanced surfaces, see `../features.md`.
