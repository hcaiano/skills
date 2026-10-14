# Collect a workflow retro window

Use the same UTC window on both hosts. Run these commands from the repository
root with Node 24 or later. Keep all output private and outside the repository. Every `--out` must
name a new directory. Node must support `node:sqlite`.

```bash
scripts="$PWD/skills/workflow-retro/scripts"
retro_run=$(node -p 'new Date().toISOString().replaceAll(/[:.]/g,"-")')
retro_root="/tmp/workflow-retro-$retro_run"
mkdir -m 700 "$retro_root"
retro_from=$(cat "$HOME/.local/state/workflow-retro/last-run" 2>/dev/null || node -p 'new Date(Date.now()-86400000).toISOString()')
retro_to=$(node -p 'new Date().toISOString()')
agent-run heavy -- node "$scripts/collect-t3.mjs" --machine pc --from "$retro_from" --to "$retro_to" --out "$retro_root/pc-t3"
agent-run heavy -- node "$scripts/collect-sessions.mjs" --machine pc --from "$retro_from" --to "$retro_to" --t3-index "$retro_root/pc-t3/index.json" --out "$retro_root/pc-sessions"
agent-run heavy -- node "$scripts/list-scheduled-tasks.mjs" --machine pc --out "$retro_root/pc-tasks"
```

Copy the maintained scripts to a private temporary directory on the Mac.
Continue independent sources after an exit of 1, and inspect the receipt.

```bash
agent-run task -- ssh mbp "mkdir -m 700 '$retro_root' '$retro_root/scripts'"
agent-run task -- scp "$scripts"/*.mjs "mbp:$retro_root/scripts/"
agent-run heavy -- ssh mbp "/opt/homebrew/bin/node '$retro_root/scripts/collect-t3.mjs' --machine mbp --from '$retro_from' --to '$retro_to' --out '$retro_root/mbp-t3'"
agent-run heavy -- ssh mbp "/opt/homebrew/bin/node '$retro_root/scripts/collect-sessions.mjs' --machine mbp --from '$retro_from' --to '$retro_to' --t3-index '$retro_root/mbp-t3/index.json' --out '$retro_root/mbp-sessions'"
agent-run heavy -- ssh mbp "/opt/homebrew/bin/node '$retro_root/scripts/list-scheduled-tasks.mjs' --machine mbp --out '$retro_root/mbp-tasks'"
agent-run task -- scp -r "mbp:$retro_root/mbp-t3" "mbp:$retro_root/mbp-sessions" "mbp:$retro_root/mbp-tasks" "$retro_root/"
agent-run heavy -- node "$scripts/collect-prs.mjs" --machine pc --indexes "$retro_root/pc-sessions/index.json,$retro_root/pc-t3/index.json,$retro_root/mbp-sessions/index.json,$retro_root/mbp-t3/index.json" --out "$retro_root/prs"
agent-run task -- ssh mbp "PATH=/opt/homebrew/bin:\$PATH trash '$retro_root'"
```

If T3 extraction fails, run `collect-sessions.mjs` without `--t3-index`.
Record the missing T3 coverage in `LIMITS.md`. After copying Mac output, its
Cursor `timelineIndex` paths refer to the corresponding copied T3 directory.
Archive the output locally before trashing the PC temporary directory.

Each index contains byte counts, per-session activity and context counts, PR
provenance, source availability, and `gapCounts`. `gaps` retains the first 200
examples. Parts contain redacted JSONL envelopes and never exceed 50 MiB.
The `prs` keys are normalized `owner/repo#number` identifiers. Discovery reads
the original records before redaction and drops invalid or credential-bearing
identifiers. Sensitive text lines and their shell or folded header continuations
become `[REDACTED]`. Structured credential values are redacted in full, including
headers represented as `{name, value}` objects or `[name, value]` pairs.
Oversized records use ordered base64 fragments with `recordId`, `fragment`, and
`total`. Concatenate decoded fragment bytes to recover the exact redacted JSON.
An exit of 1 and `complete: false` mean partial evidence. A fatal startup error
may leave no index. A rerun uses a new output directory.

Grok numeric timestamps accept seconds and milliseconds. Its untimestamped
history is context and contributes no activity or PR discovery. Claude children
share their parent's session ID. T3 uses subagent edges for parent chains and
keeps fork metadata separate. Cursor conversations use provider mappings active in the window to a
complete T3 receipt for this machine and window. `timelineActivity` counts events
in the whole thread, including provider handoffs. Read the referenced T3 parts
for provider IDs, tool inputs, and results.
Cursor `store.db` blobs remain unsupported when no matching timeline exists.
Untimestamped provider records remain explicit gaps.

Provider JSONL records default to a 2 MiB input cap, calibrated from
[seven days of record sizes on both hosts](record-sizes.md). Pass
`--record-bytes <bytes>` to `collect-sessions.mjs` to change it, from 1024 bytes
through 1 GiB. The reader keeps
one capped buffer per file; parsing and redaction also use memory proportional
to the admitted record. Larger lines leave `oversized-jsonl` gaps with the
provider, session, path, line, offset, size, and cap, then collection continues.
These gaps occur before timestamp filtering. `--part-bytes` separately bounds
output parts and fragments admitted records without dropping them.

The PR collector accepts `--urls <comma-separated URLs>` for a targeted read.
It uses the logged-in `gh` account. Reviews, review threads, nested comments,
head checks, and statuses paginate independently. Failed PRs and partial input
indexes remain gaps. Discovered PR identifiers are references, not proof a session changed
those PRs. Verify ownership when judging them.

Run maintained fixture tests with:

```bash
agent-run heavy -- node --test skills/workflow-retro/scripts/collection.test.mjs
```
