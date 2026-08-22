# Ask Codex from Claude

Drive the local Codex CLI directly. Leave `--model` unset: Codex's config owns
model selection. Check `codex exec --help` when flags drift.

## Read-only question or review

```bash
P=$(mktemp -t ask-codex.XXXXXX)
F=$(mktemp -t ask-codex-result.XXXXXX)
E=$(mktemp -t ask-codex-error.XXXXXX)
# Write the complete prompt to "$P", then:
codex exec -s read-only -C "$WORKSPACE_ROOT" -o "$F" - \
  <"$P" >/dev/null 2>"$E"
SID=$(grep -m1 "session id:" "$E" | awk '{print $NF}')
```

Read `"$F"` for the reply. Keep `SID` only for a follow-up on the same focused
exchange; never use `--last` when another Codex lane may have run in the repo.

```bash
(cd "$WORKSPACE_ROOT" && codex exec resume "$SID" \
  -c sandbox_mode="read-only" -o "$F" - <"$P" 2>"$E")
```

## Scoped write pass

Only when the user asked for implementation, use
`-s danger-full-access -c 'approval_policy="never"'` initially and
`-c sandbox_mode="danger-full-access" -c 'approval_policy="never"'` on resume —
the standing 2026-08-22 decision: writable headless runs bypass the sandbox
and the approval prompts (they are separate controls, and a machine whose
config keeps approvals on-request would still stall), and the write lease plus
your own inspection are the restraint. The prompt must name the write lease
and validation. Afterwards, inspect `git diff`, touched files, and actual
validation output yourself.

Outside a Git repository add `--skip-git-repo-check`. Never pin a model in the
skill or command.
