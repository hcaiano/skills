---
name: review-it
description: "Review and correct a finished change, returning local evidence to the caller."
disable-model-invocation: true
---

# Review gate

Return a reviewed local change and an internal record. The caller owns push,
PRs, CI, merge, and deploy.

## 1. Pin the range

Fetch `origin/<target-branch>` and pin its merge base with HEAD. Use an explicit
commit for a single-change review, or the working tree when uncommitted.
Announce the range and keep it fixed. Include intended untracked paths with
`git add --intent-to-add -- <path>`. Run focused repo checks first unless the
caller already did; keep the tree stable during review.

## 2. Grade

Grade the actual diff, including agent behavior in instruction files:

- `skip`: low risk, with focused proof covering every changed behavior.
- `single`: a bounded runtime change within one subsystem.
- `dual`: security, auth, permissions, payments, migrations, destructive data,
  infrastructure, concurrency, public contracts, cross-subsystem changes,
  ambiguous requirements, or unbounded impact.

Weakening tests requires at least `single`. When unsure, grade up. The user's
grade is a floor; record why you keep or change a caller's provisional grade.
For `skip`, proceed directly to the record.

## 3. Staff and run

Use the [Review seat](../pair/references/models.md#review-seat) and
[Pools](../pair/references/models.md#pools), checking capacity with
`node <pair-dir>/scripts/usage-state.mjs`. `single` uses one family that did not
implement the change; `dual` uses two families. Record substitutions or a
capacity reduction to one reviewer covering both axes. If no family is
eligible, report pool use, pace, and reset and ask whether to wait. If the
capacity helper is missing, record that and staff anyway.

For Codex or Cursor, resolve the newest eligible model with
`node <pair-dir>/scripts/pair-headless.mjs resolve --partner <codex|cursor>
--model latest:<family> --effort <effort>`. For Codex, add the selected
`--identity <name>` and run with the returned `CODEX_HOME=<identity_home>` and
`CODEX_BIN=<codex_bin>`. Pass `cli_model`; Cursor's ID already includes effort.

Give each reviewer the [review brief](references/review-brief.md), pinned
range, commit list, repo instructions, and spec source. `single` covers both
axes; `dual` assigns Standards and Spec separately and starts both before
waiting. Paste the brief when the reviewer cannot read the file.

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

Interactive Herdr leads first read [visible runs](references/visible-herdr-runs.md)
for `CALLER_ID` and pane rules. Elsewhere, including headless pair executors,
leave `CALLER_ID` empty and report the local run's label and transcript path.

A review passes only with successful `wait`, wrapper `{ok: true}`, and substantive
output. Refusals, rate limits, or empty results require retry or restaffing.
Promote `single` to `dual` on a material other-axis finding, a dual-risk signal,
or conflicting sources; run the missing reviewer on the same HEAD.

## 4. Fix

Verify and deduplicate findings. Apply valid, material, in-scope fixes in one
batch, including structural simplifications. Discard nits; retain out-of-scope
ideas as follow-ups. New contracts, architecture changes, or fixes that roughly
double the diff require user direction.

Run one final review only if fixes change behavior, scope, security, or
architecture risk. Apply valid findings without a third review; stop for user
direction if those fixes require another such change.

Rerun affected checks. Commit branch-range fixes and finish on a clean HEAD;
leave uncommitted-range fixes uncommitted.

## 5. Record and report

Save this record outside the working tree and give the caller its absolute
path, or its contents through agent transport if inaccessible. Retain wrapper
receipts alongside it. For `skip`, create a record directory without running
reviewers. Copy full SHAs from Git.

```markdown
## Review gate
- Gate: <skip | single | dual; reason and capacity reduction>
- Risk: <signals and impact>
- Regrade: <kept or changed; reason>
- Reviewers: <model, effort, axis; or skipped>
- Findings: <finding and fix commit, deferred issue, or discard reason>
- Second review: <ran or skipped; reason>
- Reviewed HEAD: <SHA; for skip, the assessed HEAD>
- Gate HEAD: <SHA; add uncommitted for a working-tree range>
- Transport: <run label, receipt path, transport, Herdr pane closure; or skipped>
```

Tell the human the local outcome, material fixes, and remaining blockers or
shipping steps. A clean review needs one sentence. For open findings, give
impact, location, and action. Keep audit details in the record, outside PR
bodies and comments.
