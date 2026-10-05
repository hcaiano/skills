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

## 3. Review

`single` uses one reviewer from a family that did not implement the change,
covering Standards and Spec. `dual` uses two families, one per axis, in parallel.
Before launching or restaffing, read [execution](references/execution.md) for
model selection, capacity, wrappers, and transport.

Paste the [review brief](references/review-brief.md) and assigned axes into
each prompt, with the pinned range, commit list, repo instructions, and spec.

A review counts only after successful `wait`, a wrapper receipt with
`ok: true`, and substantive output. Refusals, rate limits, or empty results
require retry or restaffing. Promote `single` to `dual` on a material other-axis
finding, a dual-risk signal, or conflicting sources; run the missing reviewer
on the same HEAD.

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
