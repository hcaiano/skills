# Codex mechanics — exec, reviews, job tracking

Raw `codex exec` for a single self-contained prompt: no session to manage, one
result file out. For multi-round delegation, use the plugin's rescue subagent
instead — it owns Codex session state.

## Invoke

Prompt via temp file — never inline shell quoting:

```bash
P=$(mktemp); cat >"$P" <<'EOF'
<the brief: goal, repo + key paths, constraints, non-goals, proof expected, output shape>
EOF
codex exec --full-auto -C <repo> -o /tmp/codex-last.md - <"$P" 2>/dev/null
```

- `--full-auto` = sandboxed workspace-write with no approval stops. `--yolo`
  lifts the sandbox entirely — only in a repo you'd let Codex own.
- Read-only work (exploration, investigation, analysis): `-s read-only` instead.
- Read the `-o` file for the result. Don't parse the JSONL stream, and leave
  stderr suppressed — thinking noise bloats your context; drop `2>/dev/null`
  only to debug a failing run.
- Long runs: Bash `run_in_background: true`, read the `-o` file when it exits.
- Parallel one-shots are fine: disjoint files or separate repos, separate `-o`
  files.
- Outside a git repo, add `--skip-git-repo-check`.

## Follow-ups

Resuming is cheaper than a fresh run and keeps Codex's context, but `resume`
drops `-C` and the shorthand flags (`--full-auto`, `-s`) — run it from the repo
dir and set the sandbox via config override, keeping the same policy as the
initial run:

```bash
(cd <repo> && codex exec resume --last \
  -c sandbox_mode="workspace-write" \
  -o /tmp/codex-last.md - <"$P2" 2>/dev/null)
```

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

node "$COMPANION" review --background                                # review the diff
node "$COMPANION" adversarial-review --background "focus: <risk>"    # challenge the approach
node "$COMPANION" status            # active + recent jobs (add <id> for one, --wait to block)
node "$COMPANION" result <id>       # final output of a finished job — read it in full
node "$COMPANION" cancel <id>       # stop a running job
```

`review`/`adversarial-review` take `--base <ref>` or
`--scope auto|working-tree|branch` to retarget.

---

Invoke mechanics adapted from the `codex-first` skill in steipete/agent-scripts.
