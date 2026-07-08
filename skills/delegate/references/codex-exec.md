# Codex mechanics — exec, reviews, job tracking

Raw `codex exec` for a single self-contained prompt: no session to manage, one
result file out. For multi-round delegation, use the plugin's rescue subagent
instead — it owns Codex session state.

## Invoke — through a wrapper, not your own shell

Codex run from your own shell puts its output in your context at lead prices.
Spawn a cheap wrapper instead — `Agent`, `model: "sonnet"`, low effort — whose
prompt embeds the slice's brief plus the mechanics below verbatim. The wrapper
runs codex, re-runs the brief's Validation itself, and returns the labeled
report; only that report reaches you. (The plugin's rescue subagent is this
wrapper prebuilt — prefer it when the plugin is installed.)

Mechanics for the wrapper — prompt via temp files, never inline shell quoting,
never a fixed output path (parallel lanes on one path corrupt each other):

```bash
P=$(mktemp -t codex-spec.XXXXXX); F=$(mktemp -t codex-out.XXXXXX)
cat >"$P" <<'EOF'
<the brief, verbatim>
EOF
codex exec --full-auto -C <repo> -o "$F" - <"$P" 2>/dev/null
```

- `--full-auto` = sandboxed workspace-write with no approval stops. `--yolo`
  lifts the sandbox entirely — only in a repo you'd let Codex own.
- Read-only work (exploration, investigation, analysis): `-s read-only` instead.
- Read the `-o` file for the result. Don't parse the JSONL stream, and leave
  stderr suppressed — thinking noise bloats the wrapper's context too; drop
  `2>/dev/null` only to debug a failing run.
- Long runs: run the wrapper agent itself with `run_in_background: true`.
- Parallel one-shots are fine: one wrapper each, disjoint files or separate
  repos.
- Outside a git repo, add `--skip-git-repo-check`.

## Follow-ups

Resuming is cheaper than a fresh run and keeps Codex's context, but `resume`
drops `-C` and the shorthand flags (`--full-auto`, `-s`) — run it from the repo
dir and set the sandbox via config override, keeping the same policy as the
initial run:

```bash
(cd <repo> && codex exec resume --last \
  -c sandbox_mode="workspace-write" \
  -o "$F2" - <"$P2" 2>/dev/null)
```

Follow-ups go through a wrapper too — same reason. `resume --last` picks the
most recent session recorded for that directory, so run it from the same repo.

(`--dangerously-bypass-approvals-and-sandbox` exists on `resume` but lifts the
sandbox entirely — same rule as `--yolo`: only in a repo you'd let Codex own.)

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
