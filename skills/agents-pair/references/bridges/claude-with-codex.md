# Bridge: Claude with Codex

You're Claude Code; your peer is Codex, via the OpenAI **codex** plugin. The hub
(`SKILL.md`) carries the pairing contract; this bridge is the transport.

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

1. Resolve `COMPANION`. Done when it points at `codex-companion.mjs`, or the user
   has been told to run `/codex:setup`.
2. Confirm Codex is ready: `node "$COMPANION" setup --json` (or `/codex:setup`).
   Done when setup reports ready, or the run has stopped with the setup fix.
3. Resolve the workspace with `git rev-parse --show-toplevel`. Done when the repo
   root is known.
4. Check `git status`. Done when pre-existing dirty files are known and the Codex
   write lease avoids files you are already editing.

## Delegating work

Shape the request as one clear task (see Prompting below), then call the subagent.
Embed Codex routing flags in the prompt text — the subagent extracts them:
`--write` (the default; omit only for read-only diagnosis or research), `--resume`
(continue Codex's last thread) or `--fresh`. Leave `--model` unset so Codex runs
its latest default. Leave `--effort` unset for routine work and raise it
(`high`/`xhigh`) only for a hard, risky, or high-stakes slice — and tighten the
prompt before reaching for more reasoning. Pass either flag explicitly only when
the user names one. `--background`/`--wait` don't apply here — the subagent ignores
them; background via the Agent tool's `run_in_background` instead.

```
Agent(subagent_type: "codex:codex-rescue",
      description: "Codex: <short>",
      prompt: "<shaped task>. Root-cause and patch the failing token-refresh
               test in src/auth/session.test.ts.")
```

For a **background job**, run the Agent with `run_in_background: true`, then keep
working on a disjoint write lease. The job also shows up in `status`/`result`.

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

Show `result` in full. While a background job runs, make progress on a disjoint
write lease and checkpoint when it lands.

## Prompting Codex

Give the subagent one clear task per run:

```text
Goal: <one outcome>
Context: <repo facts Codex needs>
Write lease: <owner, target files, forbidden changes, stop point>
Done: <checkable completion criterion>
Validation: <tests, diff review, evidence rules>
```

The rescue subagent tightens your wording before sending. On follow-ups, use
`--resume` with only the delta instruction.

## Handoff dialogue

The plugin is request/response, not a live channel — realize the hub's
peer-message loop across calls. Codex's output (findings, or a task summary with
next steps) is its reply; read it as a peer's argument, not a verdict. Continue the
same thread with `--resume`, opening with your takeaways and answering its open
questions before the next ask. Don't one-shot a hard problem.

For advanced surfaces, see `../features.md`.
