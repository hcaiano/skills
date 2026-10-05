# Model choices

Read this reference when choosing who does a piece of work: a model, effort,
account, or pool. It owns routing, families, seats, effort, and pool rules;
other skills name a seat and link here. The CLIs and their live catalogs stay
the source of truth for exact IDs. Last calibrated 2026-09-30.

## Route the work

1. **Set the bar before reading quota.** Risk and context decide what the
   task needs: a stronger model and effort for irreversible decisions,
   cross-layer changes, unfamiliar code, or a costly failure; a model and
   window that hold the repository and evidence, splitting the task when
   context would become a hidden constraint. Among models that clear the bar,
   the [pools](#pools) choose. A scarce pool moves work sideways, as from Opus
   to Astra or Sol; it never lowers the bar.
2. **The lead keeps** work that needs this conversation's context or judgement,
   a tight loop with the user, design, or a short investigation, and work that
   costs as much to brief as to do. The lead is often Opus, the strongest
   model: it implements as well as plans.
3. **Delegate** a task whose scope, proof, and stop point fit in one brief: one
   task to a pair on the [Executor seat](#executor-seat), several independent
   units to `orchestrate`. Delegate bounded work even while the lead's pool has
   room, so every subscription carries work each week. A Claude subagent
   (Claude Code's Agent tool) draws on the lead's own Claude pool: it saves
   context, not quota.
4. **Staff the deeper pool.** Henrique holds two Codex subscriptions and one
   Claude subscription. When a Codex seat and a Claude seat clear the same
   bar, staff Codex, on the identity with the lower `pace`.
5. **Protect a scarce pool from substitutable work.** A `protected` pool takes
   only work its model does better than every available alternative; that
   work needs no approval. The helper's `alerts` name a pool projected to
   empty more than a day before its reset: tell Henrique once per session,
   and recommend leading from Codex (Sol, Astra for planning) for the work
   that can be led there.
6. **Spend expiring headroom on depth.** Within 48 hours of reset, a pool that
   clears the bar with `pace` under 0.8 and at least 20% left buys a second
   independent review, a hard analysis pass, or one effort step on a genuinely
   hard task. It never buys invented work or a repeated passing check.

The user's explicit partner, model, or effort replaces a seat. `CLI default`
is valid only when it resolves to an eligible newest-generation model.

## Seats

A seat is a family in a role, at an effort, with a fallback. Local results
set the seats; a benchmark or vendor label nominates a trial, never a default.

| Seat | Default | Also | Fallback |
|---|---|---|---|
| [Planning](#planning-seat) | `opus` high **and** `astra` high | — | Astra → `sol` high |
| [Executor](#executor-seat) | `sol` high, medium if mechanical | `opus` high, `sonnet` high, `grok` high | other Codex identity |
| [Review](#review-seat) | `astra` high | `opus` high on a `dual` | `sol` high, then Cursor `kimi` or `grok` high |
| [Inspection](#inspection-seat) | `sol` low | — | `grok` low |
| [Analysis](#analysis-seat) | `astra` high, xhigh per the ladder | `opus` high, xhigh per the ladder | — |
| [Peer](#peer-seat) | `sol` high for a Claude lead | `opus` high for a Codex lead | other Codex identity |
| [Research](#research-seat) | `grok` high | `astra` high for deep research | Claude with WebSearch |
| [Design](#design-seat) | `opus` high, medium for UI diffs | Cursor `kimi` high as second opinion | — |
| [Security](#security-seat) | `grok` high | — | — |

Fable is a second opinion: an oracle consult or the user's request, never a
seat or an automatic fallback. Sol `max` or `ultra` needs the user's explicit
request.

### Planning seat

Consequential work gets two independent proposals after the one user
interview, and the lead synthesises; a routine task gets the lead's plan and
one critique from the other seat, scoped to assumptions and acceptance proof.
`orchestrate` defines consequential. When Astra is at capacity on every Codex
identity, `sol` takes its place; report the swap.

### Executor seat

`opus` executes when the task needs it and Claude has room; `sonnet` at high
takes bounded Claude work that needs less judgement, never at lower effort,
where its quality drops sharply. `grok` takes simple bounded tasks instead of
queueing behind a busy pool. Grok-built changes always get a cross-vendor
review: September's each drew several material findings.

### Review seat

Review a change from the vendor that did not write it when that pool allows:
Astra reviews Claude's work, Opus reviews Codex's and Grok's. On a `dual`,
Astra takes Standards, where its precision is highest, and Opus takes Spec,
where its recall is. Cursor fallbacks never run a GPT family. Fable reviews
only on the user's request.

### Inspection seat

Quick read-only lookups and checks.

### Analysis seat

Hard analysis and second opinions before a consequential call. Fable leads on
long, hard tasks: offer it through an oracle consult for an irreversible
decision.

### Peer seat

A live pair of equals, on the Codex identity with the lower `pace`.

### Research seat

Grok reaches live X and web sources. A headless Grok turn can cancel; the
headless backend's fork ladder ends in a proved capability miss, which means
restaff.

### Design seat

Kimi and `spark`, which leads the public design arenas but is untested here,
give taste second opinions; Fable only on request.

### Security seat

Vulnerability reproduction, exploit analysis, and patch checks. Grok ties
first on independent cyber benchmarks and refuses least; Opus, Astra, and Sol
refuse most exploit reproduction. Secure-code review stays on the Review seat.
Infra and DevOps go to `opus` or `sol`: Grok failed every Kubernetes deploy in
the one public test.

## Families

A new pair or orchestrate batch starts with a read-only catalog check;
`$SKILL_DIR` is the `pair` skill directory:

```bash
node "$SKILL_DIR/scripts/models-catalog.mjs"
```

For an `outdated` CLI, run its reported `update` command before staffing it
when no turn of that CLI is in flight on this machine. If a turn is in flight,
staff with its current catalog and tell Henrique. Tell Henrique once about
each `unknown_families` entry or `stale_examples` row: a new family needs a
seat decision; a stale example needs roster recalibration. A source `error`
means its result is unknown. The newest-version choice still comes from
`latest:` or `resolve` at staffing time.

A family is the stable part of a vendor ID, such as `sol` in `gpt-6.1-sol`.
Rules name families, never versions. Request one with
`--model latest:<family>` on the headless backend; Herdr panes take exact IDs
only. The helper resolves the family against the partner's live catalog at
`init`, or with no session through
[`resolve`](headless.md#resolve-a-model), and refuses rather than guesses:
an unknown family, a tie at the newest version, a hidden or promo entry, or
an effort the model does not offer.

| Family | Harness | Example ID |
|---|---|---|
| `opus` | claude, cursor | `claude-opus-5-5` |
| `sonnet` | claude, cursor | `claude-sonnet-5-5` |
| `fable` | claude, cursor | `claude-fable-5-1` |
| `astra` | codex | `gpt-6-astra` |
| `sol` | codex | `gpt-6.1-sol` |
| `luna` | codex | `gpt-6-luna` |
| `grok` | grok, cursor | `grok-4.7` |
| `kimi` | cursor | `kimi-k3-high` |
| `spark` | cursor | `muse-spark-1.3-high` |
| `glm` | cursor | `glm-5.2-high` |

Examples come from the live catalogs on 2026-09-30. Scripts carry no model
IDs; IDs live only in this table.

Staff only a family's newest version. An exact ID is for a variant `latest:`
cannot express, such as a `-fast` or `build-fast` speed tier, or an ID with no
effort token such as Composer's, and it still carries the newest version:
`cursor-grok-4.5-high` or a Cursor `gpt-5.6-sol-high` is stale, never a
fallback. Claude families resolve through the CLI's own aliases; a Cursor
family resolves only together with `--effort`. List the live catalogs when
the user wants options:

```bash
cursor-agent --list-models
grok models
opencode models   # add --refresh for a fresh models.dev snapshot
```

Codex has no listing command; the helper reads `model/list` from
`codex app-server`.

Prefer a native harness over a Cursor duplicate when role and pool are equal.
Cursor stays eligible when it uniquely exposes a family or has the
sustainable pool: Opus on Cursor bills Cursor, not the Claude subscription.
GPT families run only through Codex; Cursor's GPT entries are stale. Before
Cursor owns implementation, apply the headless Cursor caveat in
[`staffing.md`](../../orchestrate/references/staffing.md). Add a family only
after its native harness or the live Cursor catalog shows it.

Outside the seats:

- `composer` (Cursor): fast iteration under an external plan, as in "Grok
  plans, Composer builds". Much faster than Grok and less capable.
- `luna` and `glm`, only on the user's request: Luna has no completed run at
  its current version, and Cursor's GLM trails the vendor's newest.
- `gpt-daybreak-blue-latest`, only on request: an alias of an older Sol with
  fewer refusals.
- OpenCode: an exact ID from `opencode models`, only when the user asks for
  OpenCode.
- Never staffed: `terra` and `haiku` (harness sub-agents cover the cheap
  tiers), `gemini`, and the gated or internal entries: Daybreak Red, `mythos`,
  `gpt-reserve`, and `codex-auto-review`.

## Effort

A seat's effort overrides this ladder; leave effort unset only when the user
picks the CLI default.

- **low**: read-only lookup, or a mechanical edit with direct proof.
- **medium**: routine bounded work.
- **high**: unfamiliar behavior, broad changes, and material review.
- **xhigh**: after a high attempt fails to resolve a hard question, or for a
  consequential design decision. Astra xhigh turns ran 35 to 115 minutes in
  September: never by default.
- **max**: only after xhigh proved insufficient.

Each CLI spells it differently:

- **Claude**: `--effort low|medium|high|xhigh|max`.
- **Codex**: `low|medium|high|xhigh|max`, plus `ultra` where the catalog
  offers it. Defaults differ by model, so a Codex spawn always sets effort. A
  `latest:<family>` request is refused when the resolved model lacks it.
- **Cursor**: part of the model ID, as in `kimi-k3-high`, or
  `--model '<id>[effort=…]'`; record the complete ID and no separate effort.
- **Grok**: `--reasoning-effort low|medium|high|xhigh`, default high.
- **OpenCode**: a variant the model advertises, passed as `--variant` on every
  headless run; the OpenCode Herdr TUI runs without one.

## Pools

Read capacity after the bar is set, before every new pair, unit, work cycle,
or review. `$SKILL_DIR` is the `pair` skill directory:

```bash
node "$SKILL_DIR/scripts/usage-state.mjs"
```

It reads every account live and read-only: Claude's usage endpoint with
Claude Code's stored login, each Codex home's quota, and Cursor's `/usage`.
`--offline` reads only local snapshots, which go stale for hours; a Codex
profile sharing its `sessions` folder with another home proves no account
offline.

Use `states` (`claude`, `codex`, `cursor_models`, `other_models`),
`codex_identities.<name>.state` for each Codex account, and `alerts`.
`cursor_models` bills Grok, Composer, and Auto on Cursor; `other_models` bills
every other Cursor-hosted model. Grok outside Cursor and OpenCode have no
usage source: a refusal, rate limit, or Grok's `402` "balance exhausted" is
their only signal.

- **available**: staff it. Among available pools that clear the same bar,
  prefer lower `pace`, then lower `used_percent`, then speed, and balance a
  wave across subscriptions and Codex identities; `recommended_codex_identity`
  ranks the Codex accounts.
- **protected** (`pace > 1`: spend reaches 100% before reset): only work its
  model does better than every available alternative, as
  [routing rule 5](#route-the-work) says.
- **unavailable** (90% of the window or the burst window used): take a
  fallback. A refusal, rate limit, or `402` makes any pool unavailable,
  whatever the helper reported.
- **unknown** (no reading, a failed live read, or a snapshot older than 15
  minutes): it proves no headroom.

A fallback is the other Codex identity for a Codex seat, then the seat's
listed fallback, then the same family on Cursor while its pool is available
(GPT families excepted). Choose a Cursor model and its pool together,
preferring `cursor_models`. With no fallback left, apply only the active
workflow's explicit capacity path, such as skipping an optional pass or
reducing redundant reviewers, and record the reduction. Stop for the user only
when that workflow has no permitted path left. Grok's "unlimited" plan has a
quota in practice: a deep pool, not an infinite one.
