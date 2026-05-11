---
name: review-pr-comments
description: "Fetch PR review comments from bots and humans, triage as valid/false-positive, auto-fix valid issues, reply to resolved threads, push, and keep rechecking until the PR is stably clean rather than stopping after one quick pass."
user-invocable: true
argument-hint: "[PR number, URL, or 'all' for all open PRs]"
---

# Review PR Comments

Automated PR comment triage and resolution loop. Fetches comments from all reviewers (Devin, CodeRabbit, Ultracite, Copilot, Coderabbit, humans), classifies them, fixes valid issues, replies to threads, and loops until the PR is clean.

## When to use

Use when the user says "review pr comments", "check pr feedback", "handle pr reviews", "address comments", "triage pr", "fix pr comments", or wants to process review feedback on one or more PRs.

## Inputs

- `$ARGUMENTS` — PR number, full PR URL, or `all` (processes all open PRs for current repo)
- If no argument given, detect from current branch (`gh pr view --json number -q .number`)

## Phase 1: Discovery

1. Determine target PR(s):
   - Single PR: from argument or current branch
   - `all`: `gh pr list --author @me --state open --json number,title,headRefName` — list and confirm with user
2. For each PR, fetch **all** comments:
   ```
   gh api repos/{owner}/{repo}/pulls/{number}/comments
   gh api repos/{owner}/{repo}/pulls/{number}/reviews
   gh api repos/{owner}/{repo}/issues/{number}/comments
   ```
3. Filter out already-resolved threads (unless user passes `--include-resolved`)
4. Group comments by author and thread

## Phase 2: Classification

Classify each comment into one of five categories:

| Category | Action | Criteria |
|----------|--------|----------|
| **Fix** | Auto-fix in code | Clear, actionable code change request with specific file/line in this PR's diff |
| **Out of Scope** | Open follow-up PR | Valid finding, but the file/line is not part of this PR's diff |
| **False Positive** | Reply and dismiss | Bot flagging something that's intentional or incorrect |
| **Needs Discussion** | Flag for user | Ambiguous, architectural, or requires human judgment |
| **Informational** | Acknowledge | Praise, status updates, or non-actionable observations |

**Out-of-scope detection.** Before classifying as Fix, run `gh pr diff <num> --name-only` and check whether the comment's `path` is in that list. If not, the finding is Out of Scope — do not silently dismiss it. See Phase 4b.

### Bot-specific triage heuristics

Different bots have different false-positive profiles. Apply these priors:

- **CodeRabbit** (`coderabbit-ai[bot]`): High-quality suggestions but sometimes flags intentional patterns. Check if the suggestion conflicts with project conventions (CLAUDE.md rules). Nitpick-level comments are usually safe to dismiss.
- **Devin** (`devin-ai-integration[bot]`): Implementation-focused. Usually actionable but may suggest changes outside PR scope — flag those as Needs Discussion.
- **Ultracite** (`ultracite[bot]}`, `UltraCite`): Linting/style focused. Cross-reference with Biome config — if Biome doesn't flag it, likely false positive.
- **Copilot** (`copilot[bot]`): Variable quality. Validate each suggestion against actual code context.
- **SonarQube/SonarCloud**: Security/reliability focused. Take security findings seriously; code smell findings may be false positives.
- **Human reviewers**: **Always treat as valid** unless obviously a question or praise. Human feedback is never auto-dismissed.

### Classification rules

1. Read the file and surrounding context before classifying — never classify from comment text alone
2. If a bot suggests something that contradicts CLAUDE.md or project conventions, classify as False Positive
3. If a suggestion would change behavior (not just style), classify as Needs Discussion unless you're confident it's correct
4. If multiple bots flag the same thing, weight it more toward Fix

## Phase 3: Execute Immediately

Do NOT ask for confirmation. Directly apply fixes and dismiss false positives. Only flag "Needs Discussion" items for the user at the end.

Print a brief triage summary as you go (one line per comment), then immediately start fixing.

## Phase 4: Execute Fixes

For each Fix item:

1. Read the target file
2. Apply the minimal change that satisfies the comment
3. Stage only the changed file
4. **Do NOT commit yet** — batch all fixes into logical commits at the end

After all fixes applied:

1. Group fixes by scope/type into conventional commits
2. Commit each group: `fix(scope): address review comment — <brief description>`
3. Run project lint/build to verify fixes don't break anything
4. If lint/build fails, fix the issue and add to the commit

## Phase 4b: Out-of-Scope Follow-Up PRs

For each Out of Scope item, do not bury it in a dismissal. Open a follow-up PR so the finding can't be forgotten.

1. **Verify the finding is real** — read the file and confirm the bug/risk exists. If it doesn't reproduce, reclassify as False Positive.
2. **Group by file/concern.** Multiple out-of-scope comments touching the same file or theme go into ONE follow-up PR.
3. **Branch from `origin/main`** (not from the current PR's branch — keeps the follow-up reviewable in isolation):
   ```bash
   git fetch origin main
   git checkout -b fix/<short-slug> origin/main
   ```
4. **Apply the minimal fix** and commit with conventional format.
5. **Open the PR** with a body that:
   - Links back to the parent comment via permalink (`#issuecomment-XXXXX` or `#discussion_rXXXXX`)
   - States explicitly "addresses out-of-scope finding from #<parent-pr>"
   - Includes a short test plan
6. **Reply on the parent PR** with the new PR's number so reviewers can see the trail: *"Out of scope here; followed up in #NNNN."*

**Guardrails:**
- If the out-of-scope finding is **low severity** (style nit, doc typo on an unrelated file), skip the follow-up PR and instead reply on the parent PR explaining why it was deferred. Don't spam PRs for trivia.
- If a single triage round would produce **more than 2 follow-up PRs**, stop and confirm with the user before opening any of them — that volume usually means the bot is reviewing against the wrong base or the parent PR has bigger problems.
- Never open follow-up PRs for findings classified as False Positive or Informational.
- Never open follow-up PRs that depend on changes still being made on the parent PR — wait for the parent to merge first.

## Phase 5: Reply to Comments

For each processed comment, post a reply on the PR thread:

- **Fix**: Reply with what was changed. Example: *"Fixed — added null check for `user.profile` before accessing `.avatar`. See commit abc1234."*
- **Out of Scope**: Reply with the follow-up PR number. Example: *"Out of scope for this PR (file not in diff); followed up in #NNNN."*
- **False Positive**: Reply with reasoning. Example: *"This is intentional — we avoid `useMemo` here because the computation is trivial and memoization would add unnecessary overhead per our performance guidelines."*
- **Needs Discussion**: Do not reply — flag in the summary for the user to handle manually
- **Informational**: Optionally react with a thumbs-up, no text reply needed

**Reply formatting (top-level issue comments only).** GitHub's issue-comments endpoint has no threading. When a bot posts a top-level comment (e.g. Codex), start your reply with a short blockquote of the parent and a permalink so the timeline stays legible:

```
> [Codex P2 — Use bunx for Inngest CLI startup](https://github.com/.../#issuecomment-XXXXX)
> <one-line excerpt of the original>

Addressed in commit abc1234 — <one-line of what changed>.
```

One reply per finding — don't bundle multiple Codex/CodeRabbit items into a single comment.

Use `gh api` to post replies:
```
gh api repos/{owner}/{repo}/pulls/{number}/comments/{comment_id}/replies -f body="..."
```

For review comments that are part of a review thread, use the correct reply endpoint:
```
gh api repos/{owner}/{repo}/pulls/{number}/comments -f body="..." -f in_reply_to={comment_id}
```

## Phase 6: Push & Loop

1. Push all commits to the PR branch
2. **Immediately sync with the latest `main` before starting the final recheck cycle**:
   ```bash
   git fetch origin main
   git merge --no-edit origin/main
   ```
   - If this produces conflicts, resolve them now
   - After resolving conflicts, stage the resolutions, complete the merge commit, rerun the project quality gate, and push again
   - Never leave the branch behind `main` and still call it done
3. Enter a bounded recheck loop for **up to ~20 minutes after each push**. Do not do a single blind sleep and stop.
4. Use a backoff schedule for rechecks: ~90s, ~3m, ~5m, then every ~5m until clean or timeout
5. On every recheck, inspect **all** of the following:
   - New comments from bots triggered by the push
   - CI failures or still-pending checks for the latest head commit
   - New human comments that arrived during processing
   - **Unresolved review threads** — do not rely on flat comment lists alone
   - PR mergeability/state in GitHub — the branch must not be in a conflicted or stale merge state
6. If new actionable comments exist, go back to Phase 2. After the next push, restart the recheck timer from the beginning.
7. If GitHub reports merge conflicts or the branch is behind `main`, fetch `main`, merge it, resolve conflicts, rerun validation, push, and restart the recheck timer
8. Only stop when you have a **stable clean pass**:
   - No new actionable comments on the latest head
   - No unresolved review threads
   - No pending or failing checks that are still relevant to the latest head
   - Branch is synced with the latest `main`
   - GitHub reports the PR as mergeable / not conflicted
   - Two consecutive clean rechecks, so slower bot reviewers have a chance to appear
9. If the ~20 minute limit is reached, stop and report exactly what is still pending or unresolved instead of pretending the loop is done

## Phase 7: Summary Report

Print a final report:

```
PR #123 — Review Complete (stable clean pass reached)
=====================================
Fixed: 7 comments (5 bot, 2 human)
Dismissed: 4 false positives
Out-of-scope follow-ups: 2 (#456, #457)
Needs attention: 1 discussion item
CI: passing
Merge-ready: yes

Commits:
  abc1234 fix(dashboard): address null check and unused import
  def5678 fix(api): add input validation per review

Follow-up PRs:
  #456 fix(auth): default bearer when token present (Codex P2 from #123)
  #457 docs(env): clarify CLOUDFLARE_MCP_TOKEN contract

Remaining:
  - [human: @teammate] src/api/routes.ts:30 — auth question (needs your reply)
```

## Multi-PR Mode

When `all` is passed or multiple PRs are specified:

1. List all open PRs and confirm which to process
2. For each PR, use a **separate worktree** via `/worktree` to avoid branch conflicts
3. Process PRs sequentially (not parallel) to avoid rate limiting and allow user oversight
4. If the user explicitly asks for parallel, use background agents with worktrees
5. Print a combined summary at the end

## Rules

- **Never force push** — always regular push
- **Never merge PRs** — only address comments and push fixes
- **Conventional commits** — all fix commits follow the format
- **Minimal changes** — fix exactly what's requested, don't refactor beyond scope
- **Read before edit** — always read the file before making changes
- **Respect project conventions** — CLAUDE.md rules override bot suggestions
- **Rate limiting** — add 1s delay between GitHub API calls to avoid hitting limits
- **Never skip hooks** — all commits go through pre-commit hooks
- **Do not declare victory early** — unresolved threads or pending reviewer passes mean the loop is not finished yet
- **Always integrate latest `main`** — if the branch is stale or conflicted with `main`, fix that before finishing
- **Final status must mean merge-ready** — clean comments alone are not enough
