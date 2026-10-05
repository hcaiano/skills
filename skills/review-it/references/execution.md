# Review execution

Read before launching or restaffing reviewers. Paths under `scripts/` are
relative to the review-it skill directory; `<pair-dir>` is the sibling pair skill.

## Models and capacity

Use the [Review seat](../../pair/references/models.md#review-seat) and
[Pools](../../pair/references/models.md#pools), checking capacity with
`node <pair-dir>/scripts/usage-state.mjs`. Record substitutions or a capacity
reduction to one reviewer covering both axes. If no family is eligible, report
pool use, pace, and reset and ask whether to wait. If the capacity helper is
missing, record that and staff anyway.

For Codex or Cursor, resolve the newest eligible model with
`node <pair-dir>/scripts/pair-headless.mjs resolve --partner <codex|cursor>
--model latest:<family> --effort <effort>`. For Codex, add the selected
`--identity <name>` and run with the returned `CODEX_HOME=<identity_home>` and
`CODEX_BIN=<codex_bin>`. Pass `cli_model`; Cursor's ID already includes effort.

## Launch and transport

Run read-only through the matching wrapper in `scripts/`:

- `headless-claude.mjs "<prompt>" --effort <effort>`
- `headless-codex.mjs "<prompt>" --model <cli_model> --effort <effort> --base origin/<target-branch>`
- `headless-cursor.mjs "<prompt>" --model <cli_model> --base origin/<target-branch>`

For Codex/Cursor, replace `--base` with `--commit <sha>` or `--uncommitted`
when appropriate. Store each reviewer's receipt outside the repository to
avoid changing the tree fingerprint.

```bash
RECEIPT_DIR=$(mktemp -d -t review-it.XXXXXX)
RUN_TRANSPORT=<skill dir>/scripts/run-transport.mjs
RUN=$(node "$RUN_TRANSPORT" start "${CALLER_ID[@]}" \
  --label "review-it · <standards|spec|combined> review" \
  -- node <skill dir>/scripts/<wrapper> <args...> --receipt "$RECEIPT_DIR/<axis>.json")
node "$RUN_TRANSPORT" wait --run-file "$(printf '%s' "$RUN" | jq -r .run_file)"
```

Interactive Herdr leads first read [visible runs](visible-herdr-runs.md)
for `CALLER_ID` and pane rules. Elsewhere, including headless pair executors,
leave `CALLER_ID` empty and report the local run's label and transcript path.
