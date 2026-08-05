---
name: herdr-orchestrate
description: "Manual-only orchestration of GitHub issues in dedicated Herdr work units: triage, delegate, scope-check, ship, merge, and dismantle. The user owns blocked decisions and holds for high-risk or visible UI work."
disable-model-invocation: true
---

# Herdr Orchestrate

A **work unit** is the atom of delegation: one worktree, one Herdr tab, one
or two agents, one PR. A unit holds one issue by default, or several issues that
belong together and ship as a single PR. This skill finds free issues, splits
them into units, sets each unit up, kicks it off, scope-checks its diff
before it ships, and merges and dismantles what passes; the user can read
and interject per tab at any time.

For herdr CLI mechanics — command syntax, IDs, JSON output — follow the
`herdr` skill installed alongside this one: print the relevant command group
(`herdr tab`, `herdr agent`, `herdr pane`) instead of guessing flags, and
read identifiers from command responses. The CLI auto-updates and can change
mid-run — when a command errors with an unknown subcommand or flag, re-read
the `herdr` skill and the CLI's own help instead of retrying remembered
syntax.

## Preconditions

- `herdr` with the agent automation commands (`herdr agent start`,
  `herdr agent prompt`), `gh`, `jq`, and `trash` on `PATH`, plus
  `HERDR_ENV=1`. If any is missing, stop and say so.
- Set `PAIR_SCRIPT` to the absolute
  `<herdr-pair skill dir>/scripts/herdr-pair.mjs` path. Before any GitHub,
  Project, branch, worktree, tab, pane, agent, or message mutation, read and
  execute
  `<herdr-pair skill dir>/references/caller-pane-resolution.md`.
  That proof resolves the explicit task repository and returns `PAIR_PROOF`
  plus `PAIR_ID`. Pin `PAIR_PROOF.pane` as the report pane and
  `PAIR_PROOF.workspace_id` plus `PAIR_PROOF.tab_id` as this run's exact Herdr
  origin. Stop when the proof does not complete exactly.
- A unit milestone carries the pinned `workspace_id`; use it to resume the
  run. User navigation never changes the pin and existing runs never resolve
  focus again. A continuation without the pin stops.
- Stop before any GitHub, Project, branch, worktree, tab, pane, agent, or
  message mutation when that pane does not resolve or hosts no agent — the
  report channel reaches only a pane that has one, and a shell pane would
  swallow every milestone push. Say which, so the user can start the run from
  an agent pane.

## Guardrails

1. The pinned `workspace_id` is this run's entire Herdr world. Use only
   `workspace get <id>`, `tab list --workspace <id>`, and
   `pane list --workspace <id>` for discovery. Every other tab, pane, and
   agent command targets a workspace-qualified ID returned by those calls;
   receiving another workspace's row is already an isolation failure.
2. One work unit per tab; address only panes that unit created.
3. The unit's agents implement; ship-it's gate reviews quality; the
   orchestrator aims and holds **scope authority**. It never edits or
   reviews the unit's code — no `/code-review`, `codex review`,
   `/simplify`, no standards passes; its checkpoints are scope scans (the
   issues, the lead's summary, the `--stat` diff). Final approval and the
   merge are the orchestrator's, by standing user authorization, only for
   a PR carrying the graded `## Delivery gate` receipt with green required
   checks. When
   any checkpoint shows the graded model missing the bar, restaff on a
   smarter model (`references/models.md`) — never polish weak work by
   feedback; a follow-up issue records out-of-scope findings, never
   quality debt the unit created. A pane showing its CLI's rate or
   session limit is restaffed to the other pool now, not waited out.
4. Pair units: the delegate's `herdr-pair` run owns the pair protocol. Start
   the pair's two agents yourself at the unit's graded models and effort —
   `herdr-pair` adopts an existing peer and only spawns (at default effort
   and model) when one is missing.
5. The project's own tooling (worktree script, triage skill, implement skill)
   controls provisioning.
6. Before provisioning a unit, note which branch/worktree resources already
   exist. Track every resource created by this run — including any auxiliary
   pane or tab opened for a unit mid-run (a push pane, a watcher): register
   it to that unit and close it at the unit's dismantle, or the moment it is
   no longer needed. On failure, remove created resources in reverse order;
   adopted resources survive. If cleanup cannot finish, report one explicit
   checkpoint with the failed step and exact IDs.
7. Published history is immutable: when main (or the base) advances under a
   unit's pushed branch, the steer to the lead is merge `origin/<base>`,
   resolve, re-gate on the merge HEAD — never rebase, so force-push never
   enters a steer. A permission denial in any pane is a signal to surface
   to the user, never a bug to route around or coach a delegate past.
8. Selection never creates an issue as recovery. Before an explicitly
   requested issue or Project write, read each candidate Project's live README,
   choose exactly one whose scope matches, and verify one active membership.
   For SecondLane, CI/infrastructure/DX belongs to Project #11, not Project #2.

## Phase 0 — Survey (every invocation)

The live Herdr session is the registry: `create-unit.mjs` tags every unit pane
with `unit`, `role`, and `report_pane` metadata tokens, so a fresh
orchestrator — new session, lost context — recovers the full picture from live
state rather than from memory or from parsing a label.

Using the pinned `workspace_id`, list only its tabs and panes
(`herdr tab list --workspace <id>`; `herdr pane list --workspace <id>`). Each
pane row carries its `tokens` and agent state. Set aside every pane whose
`tokens.role` is `process-pane` — those are a gate's own short-lived runs, not
unit panes — along with panes carrying no tokens at all. Of what remains, a
unit pane must have complete metadata: a `unit`, a `report_pane`, and a `role`
of `lead` or `peer`. Some-but-not-all is inconsistent state that stops the
survey and goes to the user. Group the complete rows by the pair (`tokens.unit`, `tokens.report_pane`) — never by `tokens.unit` alone,
which would merge two runs that happened to pick the same key — and require
every pane in a group to agree on repository and to hold distinct roles before
treating it as one unit. Then classify each group by its `report_pane`:

- it is this run's pinned report pane → the unit is ours;
- it is another pane that is live and still hosts an agent → the unit belongs
  to that run: ignore it and report it;
- it no longer resolves to a live agent pane → the unit is **orphaned**, its
  orchestrator gone. Adopt it, which is what lets an orchestrator restarted in
  a new pane (the restaff path in guardrail 3) recover its own units instead of
  disowning them.

Adoption is not a re-tag. The delegate captured `HERDR_UNIT_REPORT_PANE` in its
environment when its tab was created, so re-tagging tokens alone leaves it
pushing milestones into a dead pane and the unit stays silent. Adopt in this
order, and only in this order:

1. [Send](#sending-a-message-to-an-agent) each live agent in the unit a
   one-line re-route naming the new report pane and requiring it to use that
   value from now on instead of its captured variable.
2. Wait for each of those agents to acknowledge **through the new report
   pane**. A landed receipt proves the message was submitted, not that a busy
   delegate has processed it, and a delegate that has not yet read it is still
   pushing into the dead pane. These acknowledgements are the one traffic that
   [Unit reports](#unit-reports) cannot validate normally — the unit's tokens
   still name the old run precisely because step 3 has not happened yet — so
   while an adoption is open, validate each one against the orphaned group it
   came from plus that agent's own pane tail, and never against this run's
   tokens. Handle nothing else from that unit until the handshake closes.
3. Only then re-tag the unit's panes with this run's `report_pane`.

Re-tagging last is what makes the adoption honest: until every agent has
answered on the new channel, the tokens still say the unit belongs to the old
run, so an orchestrator restarted mid-adoption finds it unadopted and retries
rather than assuming a routing change that never took. A unit whose agents
cannot be reached is reported to the user, never silently adopted.
Skip a unit whose pane cwd resolves to another repository. Target later agent
reads by pane ID. For each unit of this repository, note its issues, branch,
agent states (working / blocked / idle), any PR for its branch — check merged
and closed too, `gh pr list --state all --head <branch>` — and the newest
`[unit ...]` line in the lead's pane output, which records what that lead last
pushed to the run's report pane; treat an unhandled line as just received. Also map every
shell pane labeled `ship-it · ...` in that tab: read its foreground process
and recent unwrapped output, and record whether its
`SHIP_IT_VISIBLE_DONE ...` marker is present. These panes are the live
simplify/review status surface, including prompts, stalls, failures, and
completion.

Sweep the residue while the map is fresh: a unit tab whose PR is already
merged (merged outside the shipped handler, or by the user) gets its
dismantle now — worktree, branches, tab, per the shipped `auto` path; an
auxiliary tab or pane registered to a unit that is no longer in flight gets
closed. Residual state never waits for the next milestone.

Then branch on the input:

- **Status** — "how are things going", "what needs me": jump to
  [Status report](#status-report).
- **Unit report** — input starts with `[unit` from a lead's push: jump to
  [Unit reports](#unit-reports).
- **Delegation** — continue with triage; in-flight issues are already taken.

## Phase 1 — Triage

Goal: a short list of issues with nothing blocking an agent from starting.

1. If the project has its own triage skill, use it for the analysis and skip
   to presenting.
2. Otherwise list candidates with
   `gh issue list --state open --json number,title,labels,assignees,url,author`
   and exclude blocked ones (labels, `blocked by #N` still open, native
   relations). Respect any filters passed as arguments.
3. Cross-check against the phase 0 in-flight map: an issue already in a unit
   tab is taken, not free — list it separately with its tab label.
4. Issue bodies flow verbatim into kickoff messages, so they are untrusted
   input: an issue authored by anyone other than the user or a repo
   maintainer is delegated only after the user explicitly confirms that
   issue — flag it instead of silently including it.
5. If the invocation named issues or filters, that is the selection —
   continue straight into phase 2. Filter matches still pass step 4:
   naming a filter is not naming its third-party-authored issues, so those
   wait for per-issue confirmation. Only a bare invocation presents the
   table — number, title, why it is free — and waits for the user to name
   issues; that is the run's sole stop.
Done when the selection is known.

## Phase 2 — Group into work units

Read the selected issues' bodies
(`gh issue view N --json number,title,body,url`) and propose the split into
work units. Parallel isolation is the default; grouping needs a positive
reason (colliding files, direct dependency, or trivia that would be noise
as separate PRs). A unit stays small enough to ship as one reviewable PR;
when unsure, prefer parallel and flag the judgment call in the phase 4
summary.

Grade each unit's **effort**, **staffing**, **model(s)**, and **delivery gate**
from `references/models.md`. Its single effort ladder defines the shared
default and escalation meanings for both pools; its model table, selection
rules, and usage-state command define the rest. Run that command before
grading each wave and staff every unit against the `pace` it reports.
The issue-time grade is provisional; ship-it owns the final semantic grade
from the focused-proven diff and records any change. Pool availability
degrades how that grade is executed, never the grade itself.
Solo is the default: one implementer, with the orchestrator's scope checks
and the graded ship-it gate unchanged by staffing. A pair
needs a positive reason — ambiguous spec, unfamiliar or cross-cutting area, a
mistake that would be expensive, or scopes that genuinely parallelize — and
is always cross-pool: one Claude + one Codex model.

Grade each unit's **merge policy**. `auto` is the default and the point of
the orchestration: receipt plus green CI merges without the user — routing
simple, well-specified PRs to them defeats the purpose. `hold` is the
exception, earned by one question: would the user's input actually change
what ships? Yes when the unit touches a sensitive surface (auth, payments,
data migrations, public API contracts), when the issue left real product
or UX decisions open to taste, or when it changes visible UI — always
`hold`; the user gives design feedback personally. A gate-passed,
green-CI answer to a closed spec is `auto`, however hard the work was. A
`hold` unit stops at shipped for the user's OK.

When the usage rules queue work (`references/models.md`: both pools out of
fuel before their resets), grade those units `queued (until <reset>)`
instead of staffing
them: report them in the split, skip their phase 3, and leave their issues
free — any invocation after the reset triages and delegates them normally.

Report the split — one line per unit: issues, one-line rationale, proposed
branch name, effort, staffing, model(s), merge policy, delivery gate — and
continue
straight into phase 3: the split informs, it does not gate. A user message
contradicting it at any point wins — regroup or restaff the affected units
and carry on.

Done when every selected issue sits in a graded unit.

## Phase 3 — Delegate (per work unit)

Run the steps below for each unit. Report per-unit progress briefly. If a
selected issue turns out to already live in an in-flight tab, point the user
at that tab instead of creating a second unit for it.

1. **Branch.** Follow the repo's naming convention; default
   `feat/N-short-slug`, or a theme slug for a multi-issue unit. If the
   branch already exists for this issue, adopt it after validating its
   intended base; otherwise create it through the worktree pipeline.
2. **Worktree.** Resolve the branch in `git worktree list --porcelain` first.
   Adopt one matching existing worktree without recreating it. When none
   exists, use the repo's worktree script (e.g. `bin/worktree-create
   <branch>` or a `worktree` script in `package.json` / justfile / Makefile).
   When the repo has no pipeline, use `git worktree add`. After either path,
   verify the resolved path, branch, repository root, intended base, clean
   status, and repository setup — including anything the issues need at
   runtime (secrets profile, database, test credentials): a dependency the
   unit will block on is cheaper to catch here than mid-flight. Any failure
   stops before creating the tab.

   **Integration bases.** When the unit's PR base is not the default
   branch (e.g. an `epic/...` branch), the orchestrator owns keeping that
   base current — worktree pipelines typically branch from
   `origin/main`, and a base that lags main makes the PR diff drag in
   foreign commits. Before creating each unit: sync the base with main
   (merge `origin/main` into it, push) and verify
   `git merge-base <worktree branch> <base>` contains the worktree's
   starting point. Repeat the sync whenever main advances during the run.
3. **Tab and agents.** Provision through the bundled script — it creates
   the tab in the pinned workspace, verifies the root pane's workspace and
   cwd, starts the lead there (pair: one split for the peer, the other
   pool's model, guardrail 4), closes any leftover shell pane, and tears
   the tab down on failure:

   ```bash
   node <skill dir>/scripts/create-unit.mjs --spec '{
     "workspace": "<id>", "cwd": "<worktree>", "label": "#N <short title>",
     "unit": "<N>", "report_pane": "<pinned report pane>",
     "lead": {"name": "lead-<N>", "args": [<graded model args>]},
     "peer": {"name": "peer-<N>", "args": [<other pool model args>]}
   }'
   ```

   `unit` and `report_pane` are what make the unit machine-readable: the
   script tags every pane with them and injects `HERDR_UNIT`,
   `HERDR_UNIT_WORKSPACE`, and `HERDR_UNIT_REPORT_PANE` into the tab, so
   phase 0 rediscovers the unit from live state and the delegate reads its own
   report pane instead of depending on kickoff prose. Use the issue number for
   a single-issue unit and `N+M` for a multi-issue one.

   Model args per `references/models.md`; always pin the model explicitly —
   a bare `claude` or `codex` inherits the user's saved default instead of
   the graded model. Multi-issue label: `#N+#M <theme>`. Carry the returned
   `lead_pane`/`peer_pane` IDs in every later `herdr agent` command.
4. **Kickoff.** Send the message below to the lead pane per
   [Sending a message to an agent](#sending-a-message-to-an-agent). The unit
   is live when the kickoff lands.

### Sending a message to an agent

Send every kickoff, feedback message, and go-ahead through this skill's
`scripts/send.mjs`, never through `herdr agent prompt` directly:

```bash
node <skill dir>/scripts/send.mjs <pane_id> "<text>"
node <skill dir>/scripts/send.mjs <pane_id> @<file>   # kickoffs: no quoting
```

The `@<file>` form is mandatory for runtime-native skill invocations. Write
the complete invocation to a temporary file without shell interpolation, send
that file, and `trash` it only after the landed receipt; a Codex `$skill`
token passed as inline shell text can be expanded before `send.mjs` sees it.

Exit 0 carries a `landed: true` receipt; exit 1 means the message never
landed and that pane goes to the user. The script owns the paste-and-Enter
dance — `agent prompt` alone strands messages unsubmitted in the composer,
and hand-rolling around it is how this has broken before.

That receipt is the only read you owe a delegate. Never use `herdr agent wait`,
`prompt --wait`, polling, or timeout loops to monitor a unit: continue any
remaining orchestration work, then yield. The lead resumes the orchestrator
by pushing its next `[unit workspace=...]` milestone to the pinned report
pane. Read the `herdr` skill for current transport mechanics.

### Kickoff message template

Fill every placeholder; for a solo unit, drop the lines marked `(pair)` and
renumber. Include the full body of every issue in the unit so the delegate
never depends on `gh` mid-flight; state the implementation order when it
matters. You already digested these issues in phase 2 — spend that: fill the
suggested-approach block with concrete pointers (approach, key files/areas,
pitfalls, constraints) so the implementers start aimed.

```text
You are the lead agent for this work unit in a dedicated Herdr tab.
Pinned workspace: <workspace_id>
Issues in this unit: <#N[, #M, ...]> — implement them all on this branch and
ship them together as ONE PR that closes each of them.
Worktree: <path> (branch <branch>, already set up: deps and env installed).
Milestones: report each one by pushing it to the orchestrator the moment
you hit it —
  node <absolute path to send.mjs> "$HERDR_UNIT_REPORT_PANE" \
    "[unit workspace=$HERDR_UNIT_WORKSPACE unit=$HERDR_UNIT] <kind>: <detail>"
All three variables are already in this tab's environment — read them rather
than retyping an id you might lose. If a message ever tells you this unit's
report pane has moved, that new pane id wins over the variable for the rest of
the run: your environment was captured when this tab was created and cannot be
updated in place.
— push unconditionally, even if the orchestrator is mid-turn; the script
queues it and confirms it landed. Never substitute `herdr agent prompt`: it
returns before its Enter takes effect, and an unlanded milestone stalls this
unit in silence. A non-zero exit means it did not land — retry it, and tell
the user if it still will not. <kind> and its <detail>:
  ready — the commit SHA, then per issue: what changed and where.
  shipped — PR URL, exact head SHA, CI state, and live-review checked-at time.
  blocked — the exact decision you need.
Then stop and wait. The orchestrator's pane is the ONLY other pane you
ever prompt, and only with this run's `[unit workspace=...]` milestone lines.

Transport discipline: this pane's idle/working state IS the coordination
channel — a pane held on working starves inbound messages. Between work
steps do a single receive and return to the prompt; long-running watchers
(CI via `gh pr checks --watch`, servers, polls) live in background
terminals while this pane sits at the prompt.

Suggested approach (from the orchestrator; deviate with reason):
<approach, key files/areas, pitfalls, constraints — and for multi-issue
units the suggested order and why>

1. (pair) Run the herdr-pair skill to pair with the peer already running in
   this tab. You two are equals: co-plan the scope split, hold the write
   lease on your own scopes, and review each other's ready.
2. Implement the issue(s) with the project's implement skill (pair:
   coordinating through the pair protocol — write leases, review,
   ready/accepted). Use focused proof while implementing; reserve ship-it's
   proportional final-HEAD validation gate for its final push.
3. When the work is complete (pair: accepted by both), report ready and
   wait. Report ready only after all work is committed on the branch —
   clean `git status`, nothing untracked or staged. The orchestrator
   scope-checks the branch and either sends scope feedback (address it,
   report ready again) or the go-ahead.
4. On go-ahead, follow the explicitly invoked ship-it skill that the
   orchestrator submits directly in this pane; do not auto-select it. The
   invocation carries this unit's provisional delivery gate:
   <skip | single | dual> (ship-it owns the final semantic grade).
   Its gate is a fresh review of the final diff — pair acceptance does
   not satisfy it — and must leave its `## Delivery gate` receipt in the
   PR body. Open the PR
   (reference every issue: "Closes #N, closes #M"). If the unit changes
   visible UI, include before/after screenshots in the PR body — the user
   reviews design personally. Wait for green CI, then report shipped.
   Merging stays with the orchestrator.
5. If you need a user decision, report blocked and wait — the user reads this
   tab directly.

Issue #<N>: <title>
<url>

<full issue body>

<repeat the block above for each additional issue in the unit>
```

## Phase 4 — Report

1. After the last kickoff, summarize for the user: one line per unit — tab
   label, issues, branch, worktree, effort, staffing, model(s), merge
   policy, delivery gate, status — plus the usage-state JSON the grading
   used, verbatim, and one line reading it (a nonsense reading must be
   visible to the user, never silently steering routing). Later summaries
   carry any restaff with its reason and each unit's valid-finding count
   from its receipt — the user's calibration data.
Done when every unit is live in its own tab and the user has the summary,
or each failed unit has a per-unit failure report naming the failed step.
End the turn here. Do not wait, poll, or run status sweeps; continue only
when a lead pushes a milestone or the user asks for status or new work.

## Unit reports

Milestones arrive only as `[unit workspace=...]` prompts pushed by a lead.
Confirm that workspace matches the run's pin; a mismatch is ignored and
reported. The prompt is a claim, not evidence: confirm its `unit=` equals the
`tokens.unit` of a live unit carrying this run's `report_pane` (run a fresh
scoped phase 0 survey if the map is stale or missing) and read that lead's
pane tail for its newest `[unit workspace=...]` line before acting — a claim
matching no such unit is ignored and reported to the user. The single exception
is an open adoption handshake, whose acknowledgements are validated against the
orphaned group instead, as phase 0 describes. Handled-ness
is read from the live session, never from memory — a fresh orchestrator
must not re-fire on stale lines: a milestone is handled when the
orchestrator's response to it appears later in that pane (the go-ahead
quoting its SHA, scope feedback, a hold acknowledgment, an answer to a
`blocked`); a `shipped` on the `auto` path is handled when its PR is
merged. Then act by kind:

- `ready` — the unit's work is complete (pair: accepted by both). For a
  non-default PR base, first re-sync the base with main (phase 3 step 2).
  Scope-scan, don't review — quality is ship-it's gate (guardrail 3):
  from the issues, the lead's ready summary, and
  `git -C <worktree> diff --stat <merge-base>`, confirm the solution
  points in the right direction and covers the scope — files where the
  issues point, no unexplained surfaces, nothing obviously missing. Re-grade the merge policy from the paths touched: a
  unit that reached a hold surface (sensitive paths, visible UI) the
  issue never mentioned flips to `hold` now, whatever phase 2 graded.
  Scope wrong → [send](#sending-a-message-to-an-agent) it to the lead as
  feedback and await the next ready. Scope sane → record the approved
  SHA (`git -C <worktree> rev-parse HEAD`) and quote it in the go-ahead
  invocation. Because ship-it is manual-only, submit the runtime-native
  explicit invocation through `send.mjs @<temporary-file>`, never inline
  shell text or prose asking the lead to select the skill. The file's first
  line is Claude lead → `/ship-it Run the gate for this unit from <provisional
  gate>; ready-approved SHA: <sha>; grade the actual diff, then report
  shipped`; Codex lead → `$ship-it Run the gate for this unit from
  <provisional gate>; ready-approved SHA: <sha>; grade the actual diff, then
  report shipped`. Require the landed receipt, then `trash` the file. This
  invocation is the go-ahead and handled marker. The ship-delta check at
  shipped diffs from its quoted SHA, and the pane makes it recoverable by a
  fresh orchestrator. Tell the user the unit is shipping.
- `shipped` — verify the graded review and final-CI receipts match the exact PR
  head. Every receipt must carry `Gate:`, `Risk:`, `Focused proof:`, and
  `Regrade:` — that is ship-it's contract regardless of how the grade landed,
  and a receipt missing any of them means the gate did not run. On top of that,
  a receipt whose execution is thinner than the provisional gate is accepted
  only when those lines justify either a semantic regrade of the actual diff or
  a capacity-degraded execution of the same grade. Either failure sends the
  unit back to run the gate, and the user is told.
  Then inspect the commits from the ready-approved SHA to that head.
  Review fixes pass; new surfaces or unexplained growth return through `ready`.
  Confirm required checks are green on that head. When another in-flight
  PR overlaps this one's surface, merge whichever is green first — decide
  the order now instead of letting both wait and re-gate. Immediately before merge,
  fetch complete paginated live reviews, issue comments, inline comments, and
  review threads with the current `gh api`; anything newer than the shipped
  timestamp or any unresolved thread returns to the lead. Any branch change
  re-enters `ready` and the full ship-it cycle. `review:verify` is timestamped
  evidence, not merge authority.
  A `hold` unit waits for the user: acknowledge the hold to the lead in one
  line (also the handled marker in its pane), then toast the PR URL and why
  it holds; visible UI also requires before/after screenshots. The user's OK
  flips it onto the `auto` path. An `auto` unit merges in the repo's merge
  style with `--match-head-commit <verified head>` — skip `--delete-branch`
  (it fails while the worktree exists). Then dismantle through the bundled
  script — worktree, branch both sides, registered auxiliary tabs/panes
  (guardrail 6), tab, in the order that works, with a checkpoint report on
  failure:

  ```bash
  node <skill dir>/scripts/dismantle-unit.mjs --worktree <path> \
    --branch <branch> --tab <tab_id> [--teardown "<cmd>"] [--aux <id,...>]
  ```

  Merge only this run's PR into its intended base.
- `blocked` — read the unit's pane and surface the tab and the exact
  decision to the user, raising a toast so it reaches them away from the
  terminal: `herdr notification show "<tab label> blocked" --body
  "<decision>" --sound request`. Notifications are the orchestrator's
  channel — delegates and pairs never toast directly.

When the last in-flight unit is merged and dismantled, the run is not over:
re-run triage (phase 1) for issues freed since the last wave and delegate
them through phases 2–4 as the next wave — the standing selection criteria
carry over, and only the untrusted-author confirmation (phase 1 step 4) or
a `queued (until <reset>)` pool grade holds an issue back. Only when triage
finds nothing free does the run end, with the final per-unit summary across
all waves.

Done when the report is acted on and the user has the one-line update.

## Status report

Answer from the phase 0 map so the user never tours the tabs. Three
buckets, leading with what needs them: **needs you** (blocked, or a
question waiting in an agent or `ship-it · ...` pane — quote the exact
decision), **working** (one line each from agent or visible gate-pane
output), **shipped / idle** (PR and CI state;
idle-without-PR is possibly stalled — read the pane and say why). Done
when every in-flight unit sits in exactly one bucket.
