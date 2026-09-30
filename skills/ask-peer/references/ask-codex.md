# Ask Codex from Claude

Drive the local Codex CLI directly. Resolve the requested model through the
sibling `pair` skill on the account the pool check chose. `IDENTITY` is
`default` or a `~/.codex-profiles` name. Set `USER_MODEL` only when the user
named a model; otherwise the roster's seat supplies `FAMILY` and `EFFORT`:

```bash
MODEL_REQUEST=${USER_MODEL:-latest:$FAMILY}
R=$(node "$PAIR_DIR/scripts/pair-headless.mjs" resolve --partner codex \
  --identity "$IDENTITY" --model "$MODEL_REQUEST" --effort "$EFFORT")
MODEL=$(jq -r '.cli_model // empty' <<<"$R")
export CODEX_HOME=$(jq -r '.identity_home // empty' <<<"$R")
CODEX=$(jq -r '.codex_bin // empty' <<<"$R")
```

`PAIR_DIR` is the installed `pair` skill directory. Check `R.ok`, `MODEL`, and
`CODEX_HOME` before proceeding; on a refusal, read `R.reason` and resolve it.
The exported `CODEX_HOME` and `$CODEX` make every `exec` and `resume` use the
account and the install whose catalog the resolver read. Pass `MODEL` and `EFFORT` on every run and
resume. Check `codex exec --help` when flags drift.

## Read-only question or review

```bash
P=$(mktemp -t ask-codex.XXXXXX)
F=$(mktemp -t ask-codex-result.XXXXXX)
J=$(mktemp -t ask-codex-events.XXXXXX)
# Write the complete prompt to "$P", then:
"$CODEX" exec --json -s read-only -C "$WORKSPACE_ROOT" -m "$MODEL" \
  -c model_reasoning_effort="$EFFORT" -o "$F" - <"$P" >"$J"
SID=$(jq -r 'select(.type == "thread.started") | .thread_id' "$J" | head -n1)
```

Read `"$F"` for the reply; when it is empty, read the events in `"$J"` for
the reason. Keep `SID` only for a follow-up in the same exchange, and resume
by that id, never `--last`:

```bash
(cd "$WORKSPACE_ROOT" && "$CODEX" exec resume "$SID" -m "$MODEL" \
  -c sandbox_mode="read-only" -c model_reasoning_effort="$EFFORT" \
  -o "$F" - <"$P" >/dev/null)
```

## Scoped write pass

Only when the user asked for implementation, replace the read-only sandbox
with `-s danger-full-access -c 'approval_policy="never"'` on the first run and
`-c sandbox_mode="danger-full-access" -c 'approval_policy="never"'` on resume.
The prompt names the write lease and validation.

Outside a Git repository, add `--skip-git-repo-check`.
