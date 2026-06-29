---
name: test-fix-loop
description: "Self-improving test/fix loop for any app in this repo, run by Claude + Codex as a pair. Enumerates a target's features into user stories, tests them for real (browser/computer-use, dev logs, runtime debugging), fixes everything it finds — bugs through UX polish — and ships autonomous PRs, looping until a quality gate and the peer both pass. Use when the user invokes /test-fix-loop, or asks to 'test and fix every feature', 'QA loop on <app>', 'test the whole app and fix what's broken', 'go through every feature and make it better', or wants a paired self-improving test/fix run. The human supplies a target + intent; the agents plan and set the goal themselves."
user-invocable: true
argument-hint: "<app/scope> [free-form intent for this run]"
---

# Test-Fix Loop

A reusable, self-improving QA loop. The human runs `/test-fix-loop <target> <intent>`
and the two agents (Claude + Codex) **plan and set the goal themselves**, enumerate
the target into user stories, test them with real execution, fix everything found
(functional bugs through subjective polish), and ship autonomous PRs — looping until
a quality gate and the peer both pass.

The human never hand-authors a `/goal` prompt. The skill owns goal generation: it
synthesizes a Scope Contract from the human's target/intent, then a **Goal Block**
whose first token is literally `/goal ` when handed to Codex's goal loop.

## Roles

- The agent the human invokes is the **coordinator-writer**. It owns the planning
  files and applies code changes.
- The other agent is the **peer**: adversarial review + runtime validation. It writes
  code only under a recorded **lease** (see Leases).
- **Both agents test in parallel**, partitioned by area, each on its own browser /
  computer-use session.
- Subagents inherit the role of the agent that spawned them and the same skill-reading
  requirement.

Default invocation is in the **Claude pane** (Claude = coordinator). The skill works
either way; the only asymmetry is the Codex goal kickoff (below).

## Required reading (every agent + subagent, before acting)

Read and obey these before touching anything:

- `planning-with-files` — the tracker is files, not a spreadsheet.
- `herdr-pair` — peer coordination protocol, leases, session file.
- `debug-mode` — hypothesis-driven runtime debugging for any non-obvious bug.
- `check-logs` — read the running `bun dev` / turbo TUI logs per app (read-only).
  Use current herdr CLI verbs (`herdr pane read <id> --source recent --lines N`,
  `herdr pane send-text`/`send-keys`); run `herdr pane --help` rather than trusting
  remembered examples. *(dogfood SI-009)*
- `impeccable` and `design` — ALL design/UX/polish work routes through these.
- `review-pr-comments` (and/or `ship-it`) — the PR review loop after opening.
- Repo `CLAUDE.md` + nearest `AGENTS.md` + `packages/ds/AGENTS.md` — hard rules,
  especially the DS rules (reusable UI only in `packages/ds`, semantic tokens, no
  app-local primitives, no direct `@radix-ui`/`@base-ui` in apps).

Record in `progress.md` that each lane read these before its first edit.

## The central invariant

> **Only current-epoch evidence can close a story; only a named, measurable delta can
> open another fix iteration.**

Everything below serves this. It is what lets "no iteration cap" coexist with
"the loop actually converges."

## Preflight (coordinator, once)

1. `command -v herdr` and `HERDR_ENV=1` and `HERDR_PANE_ID` set — else stop, tell the
   human to run inside herdr.
2. `git status --short --branch`. The worktree must be clean OR only contain changes
   the human explicitly told you to build on. **Never absorb unrelated dirty files.**
   Check `git stash list` too (shared-worktree hygiene).
3. Create a fresh branch from `origin/main` for this run
   (`test-fix/<target>-<date>`), unless the human said to work on the current branch.
   Never rebase a shared branch; merge `origin/main` if you need upstream.
4. Bootstrap `herdr-pair` (find or spawn the peer; write the session file).
5. Create the **full** tracker set BEFORE any peer kickoff:
   `.planning/<YYYY-MM-DD>-<target>-test-fix-loop/` with `task_plan.md`,
   `findings.md`, `progress.md`, AND `skill-improvements.md` — each with its
   initial schema sections. Do not send the Goal Block until all four exist (the
   peer is told to read `progress.md` immediately; a missing file is a protocol
   violation). *(dogfood SI-001)*
6. **Worktree isolation for parallel code lanes.** Two agents writing code in ONE
   shared worktree collide — the peer checking out its own branch silently
   switches HEAD under the coordinator. If BOTH lanes will write code, give each
   its own git worktree (or agree one shared branch up front when the work is a
   single feature with DISJOINT file sets — then path-leases suffice). Decide this
   here, not after the collision. *(dogfood SI-010)*
7. After any edit to a shared/large file, **verify it persisted** (re-grep for your
   change) — appends can be silently reverted by formatters/races. *(dogfood)*

## Phase 0 — Scope Contract (normalize intent → goal)

Free-form launch intent can be so loose it makes the loop impossible, or so broad it
mutates product decisions. Phase 0 pins it down. Write a **Scope Contract** into
`task_plan.md`:

- **Target** — app/package/path(s).
- **Included / excluded areas** — be explicit; exclusion is as important as inclusion.
- **Roles / states** — anon, logged-in, locales, feature-flag states that matter.
- **Story unit** — default: a user story per **route / entrypoint / API / job**,
  crossed with role/state when behavior differs materially. The human's intent
  overrides this default.
- **Quality gates** — what "PASS" means; impeccable rubric in play for UI.
- **PR-split policy** — see Phase 4.
- **Record-only categories** — what the loop must NOT auto-fix (see Guards).
- **Expected-behavior sources** — code **+ live UX + tests + product/docs copy +
  sane conventions**. Never code alone (code can encode the bug).

If ambiguity affects blast radius (what gets edited/shipped), **ask the human once**
before editing. Otherwise proceed.

### Synthesize the Goal Block and launch

From the Scope Contract, synthesize a canonical Goal Block. When handing it to
**Codex's goal loop**, send it as a standalone message whose **first token is literally
`/goal `** (Codex won't start its goal loop otherwise). This is the one send that does
*not* use the `[agent …]` header — it bootstraps Codex; all later coordination uses the
normal herdr-pair headered protocol.

Goal Block template (fill from the contract):

```
/goal Co-run the test-fix-loop with Claude as peers via herdr-pair (sid=<SID>).
Read first and obey: planning-with-files, herdr-pair, debug-mode, check-logs,
impeccable, design, review-pr-comments, plus CLAUDE.md + packages/ds/AGENTS.md.
Target + Scope Contract + tracker: .planning/<DIR>/ (read task_plan.md now).
Your lane: <peer partition>. Honor leases + test epochs in progress.md.
Invariant: only current-epoch evidence closes a story; only a named measurable
delta opens a fix iteration. Test for real with your browser + computer-use on
your own session. Fix everything in scope incl. UX/polish (UI via impeccable+DS).
Ship via autonomous PRs (never auto-merge). Work until exit criteria are met.
Coordinate with Claude using [agent codex -> claude kind=... sid=<SID>] messages.
```

The coordinator (Claude) itself does **not** need `/goal` — it just runs the loop.

**Default Claude-invoked path:** Claude sends the Goal Block as a standalone
`/goal …` message to Codex, then continues as coordinator.

**Codex-invoked path:** Codex is already coordinator. After Phase 0 it must
**start/record its own active goal** from the same Goal Block content — using Codex
goal machinery when available, otherwise treating the current `/test-fix-loop`
invocation as the active goal — and send Claude a normal
`[agent codex -> claude kind=task …]` message carrying the Scope Contract, tracker
path, partition, and exit criteria. Claude never needs a `/goal` token.

## Phase 1 — Enumerate → user stories

Discover the in-scope surface from **routes / nav / tests / API schemas / CLI commands
/ job definitions** — not guesswork. For each, write user stories into `task_plan.md`
with: id, route/entrypoint, role/state, the **expected behavior** (sourced per the
contract), and priority (P0/P1/P2). The discovered story list IS the backlog bound.
A documented residual backlog is acceptable; an unbounded "every feature forever" is not.

**Job enumeration recipe** (Trigger.dev/cron/queue work). Derive task dirs from the
target (`<target>/trigger`, e.g. `apps/tools-api/trigger` — there is no repo-root
`trigger/`) *(SI-007)*. List task ids from code, then cross-check **run history** via
the Trigger MCP (`query` the `runs` table) AND the **schedule/cron wiring** AND
**caller references** *(SI-005)*. Deadness rule: a task with 0 runs is **evidence, not
proof** — observability retention is finite (the live project retained only ~7 days),
so confirm against wiring before deleting; a paused-with-intent or on-demand task wired
to a live caller is NOT dead *(SI-004)*. Dead candidates needing a human decision get
status `NEEDS_CONFIRM`, not auto-deleted *(SI-006)*.

## Phase 1.5 — Bring the target up (live execution is mandatory)

Phase 2 needs the target actually running; do not assume it is. *(dogfood SI-002/003)*

1. **Detect** a running dev TUI / listening ports → use `check-logs` and reuse it.
2. Else **start it the maintained way** (`bun dev`, which runs with turbo `--continue`
   so unrelated failing apps do NOT tear down your target — ignore their `⨯`). Scope
   narrowly only if you can keep the wiring (dev-routes, auth bridge, backend URL).
3. **Never loop on `sudo`.** If bringing it up needs a privileged step (e.g. a proxy
   binding :443) or interactive auth, that is an auth wall — **ask the human to start
   it** (mirror `debug-mode`'s ask-the-human rule) rather than fighting it.
4. **Backend targets are heavy** — DB + secrets + OAuth bridge. Record infra prereqs
   in the Scope Contract; the live deploy via a logged-in profile is often the faster
   verification surface than a local boot.
5. **Auth/env gotchas that cost real time** (budget for them, ask the human early):
   browser auth is **origin-bound** (cookies/OAuth/CORS pinned to the exact host+port —
   a different port or branch-subdomain = no session); `NEXT_PUBLIC_*` is inlined at
   build, so changes need a **full dev restart**, not hot-reload; an **empty** env value
   may not override a committed `.env`; HTTP-from-HTTPS is mixed-content-blocked. When
   the authed app won't come up locally after one fix+restart, switch to verifying on
   the **deploy** rather than burning turns on the local environment.

## Phase 2 — Test (real execution, both lanes)

Static reading is **discovery only**. Every in-scope story is validated by real
execution before it can be marked PASS/FAIL.

- **Both agents test in parallel, partitioned by area**, each on its own session:
  Claude via `claude-in-chrome` + `computer-use` MCP; Codex via its browser +
  computer-use. One browser owner *per partition*, never two on the same session.
- Use `check-logs` to read the dev TUI for the app while testing; correlate findings
  to the **route/action/time window** you exercised. Unrelated log noise becomes a
  separate `LOW`/`UNSCOPED` finding and cannot block the final gate unless it
  reproduces during current-epoch testing.
- For any non-obvious failure, switch to `debug-mode` (instrument → reproduce →
  confirm/reject hypothesis) before attempting a fix.
- **Browser session hygiene** — each tester records in `progress.md`: identity, base
  URL, viewport, locale, auth state, seed data, and cleanup/reset actions. Stories
  that mutate shared data need isolated test data or serial execution.
- **Test epochs** — every test result is stamped with a `test_epoch` (git SHA +
  app-server restart id/time + route partition + session id + tester). See Epochs.

## Phase 3 — Fix (everything in scope, incl. polish)

Fix functional bugs **and** UX/logistical issues **and** subjective polish/redesign —
everything except `record-only` categories.

- **Consumer / usefulness gate (before fixing).** A fix that makes a cron/endpoint go
  green is worthless if nothing consumes its output — that is a feature to REMOVE, not
  fix. Before fixing a broken feature, trace its output to a live, useful consumer
  (DB table → API → rendered surface). If no real consumer exists, flip the finding
  from "fix" to "remove / `record-only`." A fix story cannot reach PASS without naming
  the downstream surface its output feeds. *(dogfood SI-008; complements the Phase 1
  deadness rule — usefulness needs a rendered consumer, not merely a caller.)*
- **Leases** — before editing a path, the writer records a lease in `progress.md`
  (path glob + story id + epoch). While a write lease is open on a partition, testers
  on that partition run discovery/smoke only and label any finding `STALE_UNTIL_RETEST`.
- **DS gate** — any change to reusable UI first reads `impeccable` + `design` +
  `packages/ds/AGENTS.md`, runs the impeccable context loader, and records whether the
  change is app-specific or DS-owned. Reusable UI lands in `packages/ds`, never as an
  app-local primitive.
- **Improvement Ledger** (per story, in `findings.md`) — baseline evidence, rubric
  scores, changed files, before/after screenshots or CLI evidence, remaining deltas.
  A story may open another fix iteration **only if it first names a measurable delta**:
  a failing assertion, logged error, a11y violation, visual regression, DS violation,
  broken responsive state, or a target rubric-score increase. If the next iteration
  cannot name one, the story becomes `PASS` or `CONVERGED` before any file is touched.

## Phase 4 — Ship (autonomous PRs)

Fix → conventional commits → push → open PR vs `main` → run `review-pr-comments`
until the PR is stably clean. **Never auto-merge** (repo rule; merge needs the human).

PR-split policy (record the choice in `task_plan.md`):

- One branch per run. **One PR** only if changes stay within one app/package and are
  small/coherent (≈ ≤20 files or one flow).
- **Split PR-per-area** when changes cross app + DS + backend boundaries, span
  unrelated route clusters, or are a large visual redesign.
- A shared **DS primitive** change is usually its **own first PR**; consuming-app PRs
  follow and depend on it.
- Open all PRs vs `main` and cross-link them from `progress.md`.

## Phase 5 — Re-test & convergence (no iteration cap)

After every code lease closes, the coordinator **increments the epoch** and marks
impacted stories `NEEDS_RETEST`. Only current-epoch evidence can close a story.

**Exit criteria (all must hold):**

1. Every in-scope story is `PASS`, `FIXED`+re-tested, `CONVERGED`, or `DEFERRED` with
   an owner-approved reason — each with current-epoch evidence.
2. The impeccable/quality gate passes for every UI story; the peer agrees.
3. **Two consecutive clean sweeps at the same git head** find nothing new.
4. Both agents exchange `accepted` (the herdr-pair completion signal).

There is no fixed iteration cap. Runaway is prevented by the Improvement Ledger
(no named delta → no new iteration), the convergence detector below, and the
herdr-pair `stalemate` / no-new-artifact guards.

**Convergence detector (not a cap):** if an iteration on a story yields no measurable
improvement against the rubric AND the peer agrees, mark it `CONVERGED`. `CONVERGED`
requires peer sign-off plus "no known defect remains; only taste/product preference
remains."

## Tracker schema (planning-with-files)

`.planning/<YYYY-MM-DD>-<target>-test-fix-loop/`:

- **task_plan.md** — Scope Contract, PR-split policy, the story backlog (Phase 1).
- **findings.md** — one entry per finding + the per-story Improvement Ledger.
- **progress.md** — leases, test epochs, browser-session hygiene records, skill-read
  confirmations, PR links, current phase.

**Story status:** `TODO` → `TESTING` → `PASS` | `FAIL` → `FIXED` (then `NEEDS_RETEST`)
→ `PASS` | `CONVERGED` | `DEFERRED`. Jobs/features awaiting a human keep/remove call
use `NEEDS_CONFIRM`.

**Finding fields:** id, story id, severity (P0/P1/P2/LOW/UNSCOPED), test_epoch,
evidence (logs/screenshots/repro), status, owner, lease (if being fixed),
`STALE_UNTIL_RETEST` flag.

**Test epoch:** id, git SHA, app-server restart id/time, route partition,
browser/session id, tester, status.

**Lease:** path glob, story id, holder (claude/codex), epoch, opened/closed.

## Guards

- **Record-only** (never auto-fix; log for the human): product/business/legal/content
  strategy, paid-service changes, auth/permissions policy, data migrations, external
  partner behavior, anything needing credentials the human did not grant.
- **Stale testing** — evidence from a prior epoch cannot close a story; re-test.
- **Branch safety** — fresh branch from `origin/main`; never absorb unrelated dirty
  files; never auto-merge; never `--no-verify`; never force-push.
- **User override always wins** — a submitted human message beats any peer message;
  surface the contradiction in your next peer message.
- **Stalemate / no progress** — same disagreement twice, or five turns with no new
  artifact → `kind=handoff` to the human with the current tracker state.
