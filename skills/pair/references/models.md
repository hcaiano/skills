# Model choices

Read this reference when choosing a partner model, effort, account, or pool. It
is a decision reference; the CLIs and their live catalogs remain the source of
truth for names and accepted values. Last calibrated 2026-09-07.

## Rubric

Choose in this order:

- **Risk**: use a stronger model and effort for irreversible decisions,
  cross-layer changes, unfamiliar code, or a failure whose recovery is costly.
- **Context**: use a model and context window that can hold the repository,
  protocol history, and required evidence. Split the task when the context
  would otherwise become a hidden constraint.
- **Roster**: after risk and context set the bar, apply the family seats in the
  Roster section. The seat decides the family; the live catalog decides the ID.
- **Pool**: use an account whose pace is sustainable. A pool with `pace > 1` is
  protected because its projected spend reaches 100% before reset. Use a
  protected pool only after the user explicitly chooses it with that state in
  view. Pool balance never overrides risk or context.
- **Speed**: use a faster model or lower effort for a closed, mechanical task
  with a short proof. Speed never lowers the proof required for the task.

`CLI default` is valid for staffing only when it resolves to an eligible
latest-generation choice. Do not infer quality, safety, or speed from a vendor
label. Use the model's live catalog when the user wants options:

```bash
cursor-agent --list-models
grok models
opencode models
```

Use `opencode models --refresh` when the local OpenCode catalog needs a fresh
models.dev snapshot. Codex has no listing command; the headless helper reads
its catalog through `codex app-server` (`model/list`) when a family is
requested.

Name a model when the user chooses one or the task requires a documented model
setting.

## Roster

The roster names **families**, not IDs. A family is the stable part of a
vendor name — `sol` in `gpt-5.6-sol`, `fable` in `claude-fable-5-1` — and a
seat is a family in a role. The live catalog decides which member of the family
is current, so a stale ID never lives in this file. Model IDs appear below only
as dated evidence of what a family resolved to.

### Families

Request a family with `--model latest:<family>`. The headless helper resolves it
before the session is created and records the exact pick as `model_resolved`
with its `model_source` and `resolved_at`; the requested form stays in `model`.
Resolution matches the family token exactly and orders members by numeric
version — `5.10` is newer than `5.6`, `6` is newer than `5.6` — and it never
substitutes a neighbouring family, never picks a hidden or promo entry, and
fails when two members tie at the newest version. An exact ID from the live
catalog is always accepted instead. A session keeps the model it started with;
change a model by ending the pair, never mid-session.

| Family | Harness | Resolution | Evidence (2026-09-07) |
|---|---|---|---|
| `fable` | claude | `latest:fable` passes the documented alias `fable`; the init stream's `system.init.model` reports the exact ID, and every resumed turn pins it | `claude-fable-5-1` |
| `astra` | codex | `latest:astra` from `model/list` | `gpt-6-astra` |
| `sol` | codex | `latest:sol` from `model/list` | `gpt-5.6-sol` |
| `luna` | codex | `latest:luna` from `model/list` | `gpt-5.6-luna` |
| `opus` | claude | `latest:opus` as `fable` above | `claude-opus-5` |
| `sonnet` | claude | `latest:sonnet` as `fable` above | `claude-sonnet-5` |
| `grok` | grok | `latest:grok` from `grok models` | `grok-4.6` |
| `kimi` | cursor | `latest:kimi --effort <level>` from `cursor-agent --list-models`; the ID carries the effort | `kimi-k3-high` |

Cursor resolves a family in the same way only when its IDs have the shape
`<vendor>-<version>-<family>-<effort>` or `<vendor>-<family>-<version>-<effort>`
with an effort token: always with `--effort`, always the newest plain version
(a version that lacks the effort refuses rather than downgrades), and never a
`thinking` or `-fast` variant, which are chosen only by exact ID. An ID with no
effort token — `composer-2.5` — is outside the parser and is named exactly.
Cursor had no Astra on 2026-09-07. OpenCode has no family
resolution; name an exact ID from `opencode models`. The Codex catalog is read
through the binary `init` verified (`CODEX_BIN` or `codex` on `PATH`) and
recorded in the session; an older install that lacks a family refuses and
names itself rather than answering from another install.

A family appears only when its native harness or the live Cursor catalog
exposes it. Recheck both sources before adding a family; omit it while neither
source has it. Prefer a native harness over a Cursor duplicate when role and
pool are equal; Cursor remains eligible when it uniquely exposes the family or
has the sustainable pool. Before Cursor owns implementation, apply the
machine-specific headless Cursor caveat in
[`staffing.md`](../../orchestrate/references/staffing.md). Promo IDs belong
only in roster data, never in scripts.

### Seats por papel

Henrique's current policy sets these seats. It replaces the earlier tier list;
a benchmark or a vendor label never reorders it.

| Papel | Seat | Harness | Effort | Fallback |
|---|---|---|---|---|
| Planear / orquestrar | `fable` **and** `astra`, always both: each writes an independent proposal after the one user interview, then the lead synthesises | claude + codex | Fable **medium** for normal work, **high** on the opening planning prompt of a large orchestration, never max; Astra **high**, **xhigh** for hard analysis | none — planning without both seats is reported, not substituted |
| Execução limitada (implementação, testes, lookup) | `luna` | codex | **max** | `grok` high for simple bounded tasks |
| Inspeção rápida | `sol` | codex | **low** | `luna` high |
| Review / segurança | `sol` | codex | **high** | `opus` high when Claude is the delegated harness |
| Análise difícil | `sol` | codex | **xhigh** | `astra` xhigh |
| Execução delegada em Claude, limitada | `sonnet` | claude | **medium** or **high** | `luna` max |
| Execução delegada em Claude, transversal ou review | `opus` | claude | **high** | `sol` high |
| Tarefas simples e research live web/X | `grok` | grok | **high** (CLI default) | claude + WebSearch |
| UI / design (taste) | `kimi` | cursor | `kimi-k3-high` (`-max` for hard work) | `fable` medium/high → `opus` high for design review or medium for UI diffs |
| Image gen (UI ideas, imagens, app logos, qualquer coisa que precise de imagem) | the image-generation product surface, not a pair seat | whichever GPT surface currently exposes it | — | — |
| Cyber (defensivo) | `daybreak-blue`, by exact ID from the catalog (`gpt-daybreak-blue-latest` on 2026-09-07; unversioned, so `latest:` cannot resolve it) | codex | low; raise on need | — |

Sol `max` or `ultra` needs Henrique's explicit request. `terra` has no seat.
`haiku` has no seat. Grok is eligible for simple bounded tasks in its own right:
staff it when the task bar allows instead of queueing behind a busy or
expensive pool. Staff it knowing its headless recovery ladder: a cancelled turn
is a failed receipt, two consecutive proved cancellations schedule a session
fork (the headless backend reference owns the fork command), and a cancellation
on the fresh forked session is a proved capability miss — restaff the unit.
The 2026-08-22 wp-917 wave climbed the whole ladder before writable turns
carried `--always-approve`.

During initial design planning, pair the selected UI/design seat with
Claude Code's `/design` command when Claude is available.

`composer` has one niche: fast in-Cursor iteration under an external plan,
as in "Grok plans, Composer builds". It is much faster in wall-clock time than
Grok, but it is less capable; it is not a headline seat. Its Cursor IDs carry
no effort token, so it is named exactly from `cursor-agent --list-models`.

An explicit choice is final. When the user names the partner, model, effort, or
role, or an orchestrate unit arrives with approved staffing, start with those
values and do not ask again. Ask only for a material choice that is missing in
a standalone pairing.

### Accounts and pace

An **identity** is the account a partner CLI runs as. Codex keeps one login per
`CODEX_HOME`: `default` is `~/.codex` and a named identity is
`~/.codex-profiles/<name>`. Pass `--identity <name>` to the headless helper; it
pins the canonical home in session state and every init, send, status, and
resume uses that recorded home, never the caller's environment. The other CLIs
have one account on this machine, so only `default` is accepted for them. Two
Codex processes on different homes are supported; the same home is refused
by the transport. The Herdr backend has no identity support: a pane runs the tab's
own login, and a named identity there is refused. The helper also records the
Codex binary it verified, so a machine with several installs runs the pair on
the one whose catalog staffed it.

Before staffing, read the Claude, Codex, and Cursor pools with:

```bash
node "$SKILL_DIR/../orchestrate/scripts/usage-state.mjs"
```

The helper reads Cursor's native `/usage` command through the logged-in CLI. It
reports two monthly Cursor pools: `cursor.cursor_models` for Cursor Grok,
Composer, and Auto; and `cursor.other_models` for the other hosted models. A
model being present in `cursor-agent models` does not mean its Cursor pool is
cool. Codex pools are per identity; a live reading of one account comes from
`codex app-server` (`account/rateLimits/read`) through the helper in
`scripts/codex-rpc.mjs`, which reads and never starts a turn. Grok outside
Cursor and OpenCode have no local usage source; a refusal or rate limit is
their headroom signal.

Account capacity is read after the task bar is set, never before. Classify
every measured pool before a new pair, unit, simplify pass, or review:

- **available** — `pace <= 1`, or `pace` is null and `used_percent < 90`;
- **protected** — `pace > 1`; projected use reaches 100% before reset;
- **unavailable** — `used_percent >= 90`, refusal, or rate limit.

A stale snapshot is a floor: a stale protected or unavailable reading remains
actionable, while a stale available reading does not prove current headroom.
Automatic staffing first uses a same-bar fallback for protected and unavailable
pools — the other Codex identity for a Codex seat, then the seat's listed
fallback. If none exists, apply only the active workflow's explicit capacity
path, such as skipping an optional pass or reducing redundant reviewers, and
record the reduction. Stop for the user only when that workflow has no
permitted path left. An explicit user choice may spend a protected pool after
you state its use, pace, and reset; it never turns a refusal into capacity.

Cursor is the deliberate universal fallback harness for every eligible family
that its live catalog exposes. Choose the hosted model and its pool together.
Prefer `cursor.cursor_models` while it is available; use
`cursor.other_models` only while that separate pool is available. Name Cursor
and the pool in the staffing reason.

When several available pools meet the same bar, prefer lower `pace`, then lower
`used_percent`, then speed. Balance equal-bar work across subscriptions and
across the two Codex identities during a wave. Grok 4.6 "unlimited" has a quota
in practice; treat it as a deep pool, not an infinite pool.

### Effort

The per-seat guidance in Seats por papel overrides these generic ladders.
Effort describes the reasoning budget, not the model's identity:

- **Claude**: Claude Code accepts
  `--effort low|medium|high|xhigh|max`. Use low for mechanical work, medium for
  normal work, high for broad or risky work, and xhigh for very hard work.
  Use max only after an xhigh attempt still meets the same very-hard criterion.
- **Codex**: roster models accept `low|medium|high|xhigh|max`. Use low for
  mechanical work, medium for normal work, high for thinking or risky work,
  xhigh for very hard work, and max for exceptional work. Defaults are
  model-specific: Sol uses low, and Luna uses medium. A Codex pair spawn always sets
  effort explicitly, including medium. A `latest:<family>` request is checked
  against the catalog's effort list for the resolved model and refused when the
  effort is not offered.
- **Cursor**: effort is encoded in the model ID, such as `kimi-k3-high`. Use an
  effort-specific live-catalog ID when one exists. Cursor also accepts
  `--model '<id>[effort=…]'`. Record the complete ID as the model and omit a
  separate pair effort.
- **Grok**: Grok 4.6 accepts `low|medium|high|xhigh` with
  `--reasoning-effort` and defaults to high. Use low for mechanical work,
  medium for normal work, high for broad or risky work, and xhigh only when
  risk or context requires it.
- **OpenCode**: use a variant advertised by the selected model. Headless turns
  pass `--variant` on every `opencode run`; the variant is a model/run setting,
  not a session flag. The OpenCode Herdr TUI does not expose it. Use low for
  mechanical work, high for broad or risky work, and max for very hard work
  when the selected model offers those values.

Four seat caveats override the ladders:

- Sol `ultra` is an in-weights multi-subagent delegation mode, not an effort
  value. Never set it by default.
- Fable max has an overthinking regression on short tasks.
- Opus high is suitable for design review; use medium for UI diffs.
- Luna `max` is the setting for bounded execution under external planning and
  review.

Leave effort unset only when the user explicitly selects the CLI default.
Cursor records effort inside its model ID. The OpenCode Herdr TUI omits effort
because it cannot express a variant. The pair records each expressible choice
in session state and passes it through the backend's per-CLI mapping.

### Specialists and excluded

These entries are not general staffing seats:

- `gpt-5.6-cyber`, also called "Daybreak Red," is the real
  offensive-capable specialist. It is gated and unavailable.
- `claude-mythos-5` is Glasswing-gated.
- `gpt-reserve` and `codex-auto-review` are internal SKUs.
- `terra` (`gpt-5.6-terra`) is excluded by Henrique's decision; the catalog
  lists it, and it is never staffed.
- `haiku` is removed by decision. Harness sub-agents already delegate to cheap
  and mid-tier models; this roster gives the orchestrator frontier choices.
- `gemini` families are excluded through every harness, including Cursor.
- `cursor-grok-4.6` uses the Grok 4.6 evidence when Cursor is selected.
- `grok-build-0.1` is superseded.
- `ox-alpha` (`opencode/x-preview-f-free`) is removed by Henrique's decision
  (2026-08-22): weak in real execution. OpenCode has no roster seat until he
  scores a new one.
