# PR Comment Loop

Shared policy for `review-pr-comments` and `ship-it`.

## Mode-Split Safety

Start in default single-PR mode unless the user explicitly expands scope.

- **Default single-PR mode:** fix comments in files already in the PR diff, reply to processed comments, commit, and push to the same PR branch.
- **Expanded mode:** requires explicit user confirmation before processing `all`, creating follow-up PRs, touching files outside the PR diff, switching branches, modifying `main`, or opening more than one PR.

If a comment is valid but outside the current PR diff, verify it and then ask before doing follow-up work unless the user already confirmed expanded mode.

## Categories

| Category | Criteria | Action |
|---|---|---|
| Fix | Clear, actionable change in the current PR diff. | Apply the smallest code change, commit, and reply. |
| Out of Scope | Valid finding outside the current PR diff. | Verify, then defer or ask for expanded-mode follow-up. |
| False Positive | Incorrect, already handled, or conflicts with repo conventions. | Reply with concise reasoning. |
| Needs Discussion | Ambiguous, architectural, product-sensitive, or behavior-changing without clear confidence. | Flag for the user; do not reply automatically. |
| Informational | Praise, summaries, walkthroughs, status updates. | Optionally react; no text reply needed. |

Human comments are authoritative unless obviously praise, status, or a question. Bot comments must be validated against code and repo instruction files.

## Bot Detection

Treat an author as a bot when `user.login` contains `bot`, or when it matches a known automation account such as CodeRabbit, Codex/OpenAI, Devin, Copilot, Sonar, Greptile, Korbit, or Ultracite. Everything else is human.

## Required Context Before Classification

For each actionable-looking comment:

1. Read the target file and surrounding code.
2. Check whether the target file is in the PR diff.
3. Read repo instruction files (`AGENTS.md`, `CLAUDE.md`, or local equivalents).
4. Check whether the suggestion changes behavior, security, data flow, or public API.
5. Check whether multiple comments identify the same root issue.

Classify from evidence, not from comment text alone.

## Reply Format

Reply once per finding.

- Fix: `Fixed in <commit> - <what changed>.`
- False Positive: `Reviewed as false positive - <why>.`
- Out of Scope: `Out of scope for this PR - <deferred reason or follow-up PR>.`
- Needs Discussion: no automatic reply.
- Informational: optional reaction only.

For top-level issue comments, include a short quote and permalink to the parent before the reply so the timeline remains readable.

## Recheck Loop

After every push, inspect all latest-head surfaces again:

- new comments
- unresolved review threads
- CI/check status
- mergeability/conflict state
- branch staleness against target

Success requires two consecutive clean rechecks on the latest head. Stop with a precise blocker when auth/rate limits prevent inspection, checks stop changing across repeated rechecks, merge conflicts require broader judgment, or the next action needs expanded-mode confirmation.
