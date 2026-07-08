# Codex exec — one-shot transport

Raw `codex exec` for a single self-contained prompt: no session to manage, one
result file out. For multi-round delegation and reviews, use the plugin instead —
it owns Codex session state.

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
drops `-C` and the shorthand flags — run it from the repo dir with the long flag
spelled out:

```bash
(cd <repo> && codex exec resume --last \
  --dangerously-bypass-approvals-and-sandbox \
  -o /tmp/codex-last.md - <"$P2" 2>/dev/null)
```

After two failed rounds, stop — take the slice back or re-route it.

---

Invoke mechanics adapted from the `codex-first` skill in steipete/agent-scripts.
