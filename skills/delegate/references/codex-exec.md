# Codex mechanics — exec, reviews, job tracking

Raw `codex exec` mechanics for the Codex lane: one-shot builds and resumable
follow-ups. Everything here is written to sit inside a wrapper's prompt — the
wrapper runs these commands and returns the labeled report; it never delegates
onward or hands off to another agent.

## Invoke

These mechanics go inside the wrapper's prompt (SKILL.md transport owns the
wrapper rule): prompt via temp files, never inline shell quoting, never a
fixed output path (parallel lanes on one path corrupt each other). The wrapper
runs codex, re-runs the brief's Validation itself, and returns the labeled
report:

```bash
P=$(mktemp -t codex-spec.XXXXXX); F=$(mktemp -t codex-out.XXXXXX); E=$(mktemp -t codex-err.XXXXXX)
cat >"$P" <<'EOF'
<the brief, verbatim>
EOF
T=$(command -v gtimeout || command -v timeout || true)   # macOS: brew install coreutils
${T:+"$T" 900} codex exec -s workspace-write -C <repo> -o "$F" - <"$P" >/dev/null 2>"$E"
X=$?
SID=$(grep -m1 "session id:" "$E" | awk '{print $NF}')   # report it — follow-ups resume this exact thread
```

Hang-proofing, non-negotiable: the prompt always arrives via `- <file` — an
attached-but-silent stdin makes codex wait forever — and stdout goes to
`/dev/null` (the result is the `-o` file). The timeout is what guarantees the
wrapper regains control (size 900s to the slice; also set the Bash tool's own
`timeout` when running through it). On timeout (`X` = 124), triage by the
`-o` file: present → finished-but-hung, collect it and report normally,
noting the kill; absent → report STATUS timeout with what `"$E"` shows. No
`timeout` binary on the box → warn in the report and rely on the Bash tool's
timeout instead.

- `-s workspace-write` = sandboxed writes scoped to the repo, no approval
  stops. `--dangerously-bypass-approvals-and-sandbox` lifts the sandbox
  entirely — only in a repo you'd let Codex own. Flag names shift across CLI
  versions (`--full-auto` and `--yolo` don't exist on current `exec`) —
  `codex exec --help` is the source of truth.
- Read-only work (exploration, investigation, analysis): `-s read-only` instead.
- Model stays unset — `~/.codex/config.toml` owns it. Reasoning effort is the
  lead's per-slice call (`-c model_reasoning_effort=...`): depth scales with
  judgment residue. `xhigh`, set explicitly, for real builds, hard debugging,
  and stalls; `high` for standard work orders; `medium` for easy fully
  deterministic ones; `low` for rote batches — the fast lane. Below `high`
  requires two checkable things: a fully deterministic work order (zero
  judgment left in it) and a machine-checkable receipt (grep, build, tests).
  A miss below `high` escalates effort on the retry — never the same rung
  twice. Skip `minimal`/`none` for code: the seconds saved don't cover one
  failed round trip. `xhigh` is the current API ceiling (`max` returns 400
  invalid_value) — probe when a new model lands, don't assume.
- Read the `-o` file for the result. Don't parse the JSONL stream, and keep
  stderr in its file — thinking noise bloats the wrapper's context too; the
  only line worth extracting is the session id. Read the file directly only to
  debug a failing run.
- Long runs: run the wrapper agent itself with `run_in_background: true`.
- Parallel one-shots are fine: one wrapper each, disjoint files or separate
  repos.
- Outside a git repo, add `--skip-git-repo-check`.

## Follow-ups

Resuming is cheaper than a fresh run and keeps Codex's context. Resume by the
session id the initial run reported — `--last` grabs the most recent session
in the directory, which with parallel lanes or a builder race is not
necessarily yours; use it only when your lane is the only one that has run in
that repo. `resume` drops `-C` and `-s` — run it from the repo dir and set the
sandbox via config override, keeping the same policy as the initial run:

```bash
P2=$(mktemp -t codex-spec.XXXXXX); F2=$(mktemp -t codex-out.XXXXXX)
cat >"$P2" <<'EOF'
<the follow-up — just the delta instruction>
EOF
(cd <repo> && codex exec resume "$SID" \
  -c sandbox_mode="workspace-write" \
  -o "$F2" - <"$P2" 2>/dev/null)
```

Follow-ups go through a wrapper too — same reason. A fresh wrapper won't have
`$SID` in its shell: pass the id in its prompt, from the previous report.

(`--dangerously-bypass-approvals-and-sandbox` exists on `resume` too and lifts
the sandbox entirely — same rule as on exec: only in a repo you'd let Codex
own.)

## Reviews and job tracking (plugin companion)

`/codex:review`, `/codex:adversarial-review`, `/codex:status`, `/codex:result`,
and `/codex:cancel` are user-only slash commands — drive the same engine
through the plugin's companion script, and echo the matching `/codex:` command
so the user can re-run it:

```bash
shopt -s nullglob
cands=("$HOME"/.claude/plugins/cache/openai-codex/codex/*/scripts/codex-companion.mjs)
COMPANION="$(printf '%s\n' "${cands[@]}" | sort -V | tail -1)"
[ -z "$COMPANION" ] && COMPANION="$HOME/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/codex-companion.mjs"
```

If `$COMPANION` doesn't resolve to an existing file (`[ -f "$COMPANION" ]`),
stop here — none of the commands below can run; tell the user to install the
plugin with `/codex:setup`. Otherwise:

```bash
node "$COMPANION" review                              # review the diff
node "$COMPANION" adversarial-review "focus: <risk>"  # challenge the approach
node "$COMPANION" status            # active + recent jobs (add <id> for one, --wait to block)
node "$COMPANION" result <id>       # final output of a finished job — read it in full
node "$COMPANION" cancel <id>       # stop a running job
```

Review commands run in the foreground — the companion parses `--background`
for reviews but doesn't detach them. For a long review, background the Bash
call itself (`run_in_background: true`); the job still appears in `status`.

`review`/`adversarial-review` take `--base <ref>` or
`--scope auto|working-tree|branch` to retarget.

---

Invoke mechanics adapted from the `codex-first` skill in steipete/agent-scripts.
