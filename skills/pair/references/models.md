# Model choices

Read this reference when choosing a partner model, effort, account, or pool.
It owns families, seats, effort, and pool rules; other skills name a seat and
link here. The CLIs and their live catalogs stay the source of truth for exact
IDs. Last calibrated 2026-09-30.

## Rubric

Choose in this order:

- **Risk**: use a stronger model and effort for irreversible decisions,
  cross-layer changes, unfamiliar code, or a failure whose recovery is costly.
- **Context**: use a model and context window that can hold the repository,
  protocol history, and required evidence. Split the task when the context
  would otherwise become a hidden constraint.
- **Seat**: after risk and context set the bar, take the role's seat below.
  The seat decides the family; the live catalog decides the ID.
- **Pool**: take an account the [pool check](#pools) allows. Pool balance
  never overrides risk or context.
- **Speed**: use a faster model or lower effort for a closed, mechanical task
  with a short proof. Speed never lowers the proof required for the task.

Seats are the defaults; the user's explicit partner, model, or effort replaces
them. `CLI default` is valid for staffing only when it resolves to an eligible
latest-generation choice.

## Families

A family is the stable part of a vendor ID, such as `sol` in `gpt-6.1-sol`.
Rules name families, never versions. Request one with
`--model latest:<family>` on the headless backend; Herdr panes take exact IDs
only. The helper resolves the family against the partner's live catalog at
`init` and records the pick as `model_resolved`. It refuses rather than
guesses: an unknown family, a tie at the newest version, a hidden or promo
entry, or an effort the model does not offer stops before a session exists.

| Family | Harness | Example ID |
|---|---|---|
| `fable` | claude | `claude-fable-5-1` |
| `opus` | claude | `claude-opus-5-5` |
| `sonnet` | claude | `claude-sonnet-5-5` |
| `astra` | codex | `gpt-6-astra` |
| `sol` | codex | `gpt-6.1-sol` |
| `luna` | codex | `gpt-6-luna` |
| `grok` | grok, cursor | `grok-4.7` |
| `kimi` | cursor | `kimi-k3-high` |
| `glm` | cursor | `glm-5.2-high` |
| `spark` | cursor | `muse-spark-1.3-high` |

Examples come from the Codex and Grok model caches and Claude's session logs
on 2026-09-30; the Cursor-only rows from `cursor-agent --list-models` on
2026-09-29. Scripts carry no model IDs; IDs live only in this table.

Claude families resolve through the CLI's own aliases. A Cursor family
resolves only together with `--effort`, because Cursor encodes effort in the
ID; `thinking` and `-fast` variants, and IDs with no effort token such as
Composer's, are named exactly. OpenCode has no family resolution. List the
live catalogs when the user wants options:

```bash
cursor-agent --list-models
grok models
opencode models   # add --refresh for a fresh models.dev snapshot
```

Codex has no listing command; the headless helper reads `model/list` from
`codex app-server`.

Prefer a native harness over a Cursor duplicate when role and pool are equal;
Cursor stays eligible when it uniquely exposes the family or has the
sustainable pool. GPT families run only through Codex: OpenAI no longer serves
Cursor, so its GPT entries are stale. Before Cursor owns implementation, apply
the headless Cursor caveat in
[`staffing.md`](../../orchestrate/references/staffing.md). Add a family only
after its native harness or the live Cursor catalog shows it.

## Seats

A seat is a family in a role, at an effort, with a fallback. A benchmark or a
vendor label never reorders the seats. Fable and Astra are reserved: they
staff the Planning seat, an oracle consult, or an explicit user request, never
an automatic fallback. Sol `max` or `ultra` needs the user's explicit request
and support in the live catalog.

### Planning seat

`fable` **and** `astra`, always both: after the one user interview each writes
an independent proposal, and the lead synthesises. Fable at **medium**,
**high** on the opening prompt of a large orchestration, never max (it
overthinks short tasks); Astra at **high**, **xhigh** for hard analysis. No
fallback: planning without both seats is reported, not substituted.

### Executor seat

Bounded implementation, tests, and lookup under an external plan and review:
`luna` at **max**. When Claude executes: `sonnet` at **medium** or **high**
for bounded work, `opus` at **high** for cross-cutting work. Fallbacks:
`sonnet` to `luna` at **max**, `opus` to `sol` at **high**. `grok` at
**high** takes simple bounded tasks, as a fallback or in its own right instead
of queueing behind a busy or expensive pool.

### Review seat

Review and security: `sol` at **high**. When Claude reviews: `opus` at
**high**. Fallback: the newest `grok`, `kimi`, `glm`, or `spark` on Cursor at
**high**, never a GPT family there. Fable reviews only when the user asks.

### Inspection seat

Quick inspection: `sol` at **low**. Fallback: `luna` at **high**.

### Analysis seat

Hard analysis: `sol` at **xhigh**; when Claude analyses, `opus` at **xhigh**.
Escalate to Fable or Astra only through an oracle consult or the user's
request.

### Research seat

Simple tasks and live web or X research: `grok` at **high**, its CLI default.
Fallback: Claude with WebSearch. A headless Grok turn can cancel; the
headless backend's fork ladder ends in a proved capability miss, which means
restaff the unit.

### Design seat

UI and design taste: `kimi` on Cursor at **high**, **max** for hard work.
Fallback: `opus` at **high** for design review, **medium** for UI diffs.

### Cyber seat

Defensive security: `daybreak-blue` at **low**, raised on need. It is
unversioned, so name its exact Codex catalog ID (`gpt-daybreak-blue-latest`);
`latest:` cannot resolve it.

### Outside the seats

- `composer` (Cursor) fits one niche: fast iteration under an external plan,
  as in "Grok plans, Composer builds". It is much faster in wall-clock time
  than Grok and less capable. Name it by exact ID.
- OpenCode has no seat. Name an exact ID from `opencode models` only when the
  user asks for OpenCode.
- Never staffed: `terra` and `haiku` by Henrique's decision (harness
  sub-agents already cover the cheap tiers), `gemini` through any harness,
  and the gated or internal entries: Daybreak Red, `mythos`, `gpt-reserve`,
  and `codex-auto-review`.

## Effort

A seat's effort overrides these ladders. Leave effort unset only when the user
picks the CLI default.

- **Claude**: `--effort low|medium|high|xhigh|max`. Low for mechanical work,
  medium for normal work, high for broad or risky work, xhigh for very hard
  work; max only after an xhigh attempt still meets the same very-hard bar.
- **Codex**: `low|medium|high|xhigh|max`, plus `ultra` where the catalog
  offers it. Low for mechanical work, medium for normal work, high for risky
  work, xhigh for very hard work, max for exceptional work. Defaults differ by
  model, so a Codex spawn always sets effort, including medium. A
  `latest:<family>` request is refused when the resolved model does not offer
  the effort.
- **Cursor**: effort is part of the model ID, as in `kimi-k3-high`. Use an
  effort-specific catalog ID, or `--model '<id>[effort=…]'`; record the
  complete ID as the model and no separate effort.
- **Grok**: `--reasoning-effort low|medium|high|xhigh`, default high. Low for
  mechanical work, medium for normal work, high for broad or risky work, xhigh
  only when risk or context requires it.
- **OpenCode**: a variant the selected model advertises, passed as
  `--variant` on every headless run. Low for mechanical work, high for broad
  or risky work, max for very hard work. The OpenCode Herdr TUI cannot express
  a variant, so it runs without one.

## Pools

Read capacity after the task bar is set, before every new pair, unit, work
cycle, or review. `$SKILL_DIR` is the `pair` skill directory:

```bash
node "$SKILL_DIR/scripts/usage-state.mjs"          # snapshots and Cursor /usage
node "$SKILL_DIR/scripts/usage-state.mjs" --live   # plus a read-only Codex quota read per account
```

Use the helper's `states` (`claude`, `codex`, `cursor_models`,
`other_models`) and `codex_identities.<name>.state` for each Codex account.
`cursor_models` bills Grok, Composer, and Auto on Cursor; `other_models` bills
every other Cursor-hosted model. Grok outside Cursor and OpenCode have no
usage source: a refusal or rate limit is their only signal.

- **available**: staff it. Among available pools that meet the same bar,
  prefer lower `pace`, then lower `used_percent`, then speed, and balance a
  wave across subscriptions and Codex identities; `recommended_codex_identity`
  ranks the Codex accounts.
- **protected** (`pace > 1`, so spend reaches 100% before reset): take a
  same-bar fallback. Spend it only when the user chooses it after you state
  its use, pace, and reset.
- **unavailable** (90% of the window or the burst window used): take a
  same-bar fallback. A refusal or rate limit makes any pool unavailable,
  whatever the helper reported.
- **unknown** (no reading, or one older than 15 minutes): it proves no
  headroom. Refresh it (`--live` for Codex) when the choice depends on it.

A same-bar fallback is the other Codex identity for a Codex seat, then the
seat's listed fallback, then the same family on Cursor while its pool is
available (GPT families excepted). Choose a Cursor model and its pool
together, preferring `cursor_models`. With no fallback left, apply only the
active workflow's explicit capacity path, such as skipping an optional pass or
reducing redundant reviewers, and record the reduction. Stop for the user only
when that workflow has no permitted path left. Grok's "unlimited" plan has a
quota in practice: a deep pool, not an infinite one.
