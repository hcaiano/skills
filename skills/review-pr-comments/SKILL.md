---
name: review-pr-comments
description: "Fetch PR review comments from bots and humans, triage as fix/false-positive/out-of-scope/needs-discussion/informational, apply valid same-PR fixes, reply to processed threads, push to the PR branch, and keep rechecking until the latest head is stably clean. Use when the user asks to review PR comments, check PR feedback, handle reviews, address comments, triage a PR, or fix PR comments."
user-invocable: true
argument-hint: "[PR number, URL, or 'all' for all open PRs]"
---

# Review PR Comments

Dedicated entrypoint for the PR comment loop. The shared policy — mode-split
safety, categories, classification context, bot detection, reply format, the
inventory + recheck loop, and the clean-stop definition — lives in
`references/pr-comment-loop.md`; API endpoints live in
`references/github-comment-fetching.md`. **Load both before acting and follow
them; this skill adds only the entrypoint contract, preflight, and flow — it does
not restate the policy.**

## When to run (proactive — don't wait to be asked)

You OWN the review threads on every PR YOU open. Run this loop **automatically**,
scoped to PRs you created in this work (don't retroactively sweep others'), at two
moments:

1. **~3–5 min after `gh pr create`** — CodeRabbit, the Codex/ChatGPT connector,
   and Socket post a few minutes after open, not at open.
2. **After every push** to that PR branch — bots re-review new commits progressively.

**Reporting gate:** never report a PR "green / ready / merge-ready / done" until a
clean recheck per the loop reference's stop definition holds. CI-green is not
review-clean. The usual misfires: declaring ready at open-time before bots comment,
and counting only non-outdated threads while unresolved outdated ones remain.

## Inputs

`$ARGUMENTS` is a PR number, URL, or `all`. With no argument, detect from the
branch: `gh pr view --json number -q .number`. `all` is expanded mode — list
candidates and confirm before processing (see Mode-Split Safety in the reference).

## Preflight

Fail early with a clear blocker, not after edits:

1. `gh auth status` and `gh repo view` — CLI authed, repo resolves.
2. `git status`, branch, remote, push permission. Refuse to work on `main` unless
   the user asked.
3. Resolve the target PR, or confirm expanded mode for `all`.
4. Read repo instruction files (`AGENTS.md`, `CLAUDE.md`, or local equivalent).
5. Identify the quality gate (instructions → lockfiles → package scripts → ask).
6. Fetch the PR diff file list before classifying.

## Flow

1. **Discover** every review surface for the PR (commands in
   `github-comment-fetching.md`): review comments, review bodies, issue comments,
   unresolved threads (including `isOutdated=true`), latest-head checks, and
   mergeability. Build the inventory per the reference's Inventory Rules.
2. **Classify and reply** per the reference (categories, required context, bot
   detection, reply format, thread resolution, review-body minimization). For each
   Fix: read the file + surrounding code, apply the smallest change, batch related
   fixes into conventional commits, run the quality gate, then reply on each fixed
   finding with the commit SHA. Post False Positive / Out of Scope replies
   immediately.
3. **Push**: rebase or merge the target branch per repo convention, resolve
   conflicts, rerun the quality gate, push (never force-push without an explicit
   ask).
4. **Recheck** per the reference's Recheck Loop: reviewer surfaces before CI, two
   consecutive clean rechecks on the same head ≥3 min apart, reset the count on any
   new finding. Stop only on the reference's clean state or a precise blocker.

## Summary Report

End with:

```markdown
PR #123 - Review Complete
Fixed: <count> (each replied with commit SHA on the original thread)
Dismissed: <count> (each replied as false positive on the original thread)
Out-of-scope: <count> (each replied with deferral reason on the original thread)
Needs attention: <thread URLs awaiting user input>
Unreplied: <should be 0 — if not, list thread URLs and reason>
CI:
Merge-ready:
Commits:
Remaining:
```

`Unreplied` must be `0` for a clean run (it counts only Fix / False Positive /
Out of Scope). Every Needs Discussion thread appears under `Needs attention` with
its URL.
