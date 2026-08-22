# Model choices

Read this reference when choosing a partner model, effort, or pool. It is a
decision reference; the CLIs and their live catalogs remain the source of truth
for names and accepted values.

## Rubric

Choose in this order:

- **Risk**: use a stronger model and effort for irreversible decisions,
  cross-layer changes, unfamiliar code, or a failure whose recovery is costly.
- **Context**: use a model and context window that can hold the repository,
  protocol history, and required evidence. Split the task when the context
  would otherwise become a hidden constraint.
- **Roster**: after risk and context set the bar, apply the preference rules and
  current seats in the Roster section.
- **Pool**: use a pool whose pace is sustainable. A pool with `pace > 1` is
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
models.dev snapshot.

Name a model when the user chooses one or the task requires a documented model
setting.

## Roster

The preference table is the first read for staffing after risk and context set
the bar. `Tier` is Henrique's general quality judgment. `Automatic use` turns
that judgment into a staffing rule. A specialist role may override the general
tier only where the table says so. The live catalogs remain authoritative for
model IDs and availability.

### Operational preferences

This table applies Henrique's 2026-08-22 tier-list image to staffing. It is not
a copy for display. A model appears only when its native harness or the live
Cursor catalog exposes it. Recheck both sources before adding a model; omit it
while neither source has it. Within a tier, rows keep the image's left-to-right
order; the eligible role and required proof still decide whether that order
applies. Taste uses a 0–10 scale. Speed uses `lento`, `médio`, or `rápido`.
Cost uses `barato`, `médio`, or `caro` for subscription pressure, never API
price. `?` means the image ranks general quality but other operating evidence
is absent.

| Model | Tier | Taste | Speed | Cost | Automatic use | Evidence / condition | Updated |
|---|---:|---:|---|---|---|---|---|
| `claude-fable-5` | S+ | 9 | lento | caro | planning and orchestration | strongest general preference; premium Claude or Cursor other-models pool | 2026-08-23 |
| `gpt-5.6-sol` | A | 8 | médio | médio | high-quality general execution and review | preferred back-end and general executor | 2026-08-23 |
| `kimi-k3` | B | 10 | lento | médio | UI and design | specialist taste seat; use a live Cursor ID | 2026-08-23 |
| `gpt-5.6-luna` | B | 5 | rápido | barato | general fallback and volume execution | first general fallback below Sol; never the UI seat | 2026-08-23 |
| `grok-4.6` | C | 6 | rápido | barato | fast fallback and live research | use after eligible B-tier general choices; deep but finite Grok pool | 2026-08-23 |
| `claude-opus-5` | D | 9 | médio | médio | UI/design fallback only | specialist taste can justify it after Kimi and Fable; never a general fallback | 2026-08-23 |
| `composer-2.5` | D | 6 | rápido | barato | externally planned Cursor iteration only | provisional `?` placement in Henrique's image; not a headline seat | 2026-08-23 |
| `gpt-5.6-terra` | D | ? | ? | ? | no seat | available IDs do not overcome Henrique's D-tier judgment | 2026-08-23 |
| `claude-sonnet-5` | D | ? | ? | ? | no seat | available IDs do not overcome Henrique's D-tier judgment | 2026-08-23 |
| `gemini-3.7-flash` | excluded | ? | ? | ? | never | Henrique's Google exclusion applies through every harness | 2026-08-23 |
| `gemini-3.1-pro` | excluded | ? | ? | ? | never | Henrique's Google exclusion applies through every harness | 2026-08-23 |
| `gpt-daybreak-blue-latest` | specialist | n/a | médio | médio | defensive cyber only | Sol-equivalent specialist; not part of the general tier order | 2026-08-23 |

Apply every row as follows:

- Staff only the latest generation of each model family in each harness. The
  live catalogs decide current IDs.
- Tier ranks models that already meet the risk, context, role, and proof bar.
  It never lowers that bar.
- Prefer a native harness over a Cursor duplicate when tier, role, and pool are
  equal. Cursor remains eligible when it uniquely exposes the preferred model
  or has the sustainable pool.
- Before Cursor owns implementation, apply the machine-specific headless
  Cursor caveat in
  [`staffing.md`](../../orchestrate/references/staffing.md).
- Promo IDs belong only in roster data, never in scripts.

### Seats por papel

| Papel | Seat | Harness | Effort | Fallback |
|---|---|---|---|---|
| Planear / orquestrar | `claude-fable-5` | claude | **medium** for normal work; **high** only on the opening planning prompt of a large orchestration; never max because short tasks show an overthinking regression | `gpt-5.6-sol` high |
| Execução de alta qualidade (back-end e geral) | `gpt-5.6-sol` | codex | **high**; `ultra` is a subagent mode, not an effort value | `gpt-5.6-luna` high/xhigh → `grok-4.6` high |
| Execução rápida | `gpt-5.6-luna` | codex | **high** or a live fast ID | `grok-4.6` high |
| Execução barata em volume | `gpt-5.6-luna` | codex | **xhigh/max** with Sol planning and review; never for UI work; verbose at max | `grok-4.6` high |
| UI / design (taste) | `kimi-k3` | cursor | `kimi-k3-high` (`-max` for hard work) | `claude-fable-5` medium/high → `claude-opus-5` high for design review or medium for UI diffs |
| Image gen (UI ideas, imagens, app logos, qualquer coisa que precise de imagem) | **Image Gen 2 with `gpt-5.6`** | the `gpt-5.6` surface that exposes Image Gen 2 | — | — |
| Cyber (defensivo) | `gpt-daybreak-blue-latest` | codex | low; raise on need | — |
| Research live web/X | `grok-4.6` | grok | high (CLI default) | claude + WebSearch |

Kimi is the primary UI/design seat. Fable is the stronger fallback when its pool
is sustainable. Opus is D-tier in general work and remains eligible only as the
last UI/design specialist fallback. Its benchmark aggregates do not override
Henrique's daily-use judgment. During initial design planning, pair the selected
UI/design seat with Claude Code's `/design` command when Claude is available.

Grok is the C-tier fast fallback after eligible B-tier general models and keeps
the specialist live-research seat. Staff it knowing its headless recovery
ladder: a cancelled turn is a failed receipt, two
consecutive proved cancellations schedule a session fork (the headless backend
reference owns the fork command), and a cancellation on the fresh forked
session is a proved capability miss — restaff the unit. The 2026-08-22 wp-917
wave climbed the whole ladder before writable turns carried
`--always-approve`.

`composer-2.5` has one niche: fast in-Cursor iteration under an external plan,
as in "Grok plans, Composer builds". It is much faster in wall-clock time than
`grok-4.6`, but it is less capable: CursorBench scores are 56.1 and 69.9. It is
not a headline seat.

### Pace and fallback

Before staffing, read the Claude, Codex, and Cursor pools with:

```bash
node "$SKILL_DIR/../orchestrate/scripts/usage-state.mjs"
```

The helper reads Cursor's native `/usage` command through the logged-in CLI. It
reports two monthly Cursor pools: `cursor.cursor_models` for Cursor Grok,
Composer, and Auto; and `cursor.other_models` for the other hosted models. A
model being present in `cursor-agent models` does not mean its Cursor pool is
cool. Grok outside Cursor and OpenCode have no local usage source; a refusal or
rate limit is their headroom signal.

Classify every measured pool before a new pair, unit, simplify pass, or review:

- **available** — `pace <= 1`, or `pace` is null and `used_percent < 90`;
- **protected** — `pace > 1`; projected use reaches 100% before reset;
- **unavailable** — `used_percent >= 90`, refusal, or rate limit.

A stale snapshot is a floor: a stale protected or unavailable reading remains
actionable, while a stale available reading does not prove current headroom.
Automatic staffing first uses a same-bar fallback for protected and unavailable
pools. If none exists, apply only the active workflow's explicit capacity path,
such as skipping an optional pass or reducing redundant reviewers, and record
the reduction. Stop for the user only when that workflow has no permitted path
left. An explicit user choice may spend a protected pool after you state its
use, pace, and reset; it never turns a refusal into capacity.

Cursor is the deliberate universal fallback harness for every eligible model
that its live catalog exposes. Choose the hosted model and its pool together.
Prefer `cursor.cursor_models` while it is available; use
`cursor.other_models` only while that separate pool is available. Name Cursor
and the pool in the staffing reason.

When several available pools meet the same bar, prefer lower `pace`, then lower
`used_percent`, then speed. Balance equal-bar work across subscriptions during a
wave. Grok 4.6 "unlimited" has a quota in practice; treat it as a deep pool,
not an infinite pool.

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
  effort explicitly, including medium.
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
- Luna's hidden `max` is a valid setting for volume execution under external
  planning and review.

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
- Rows marked `no seat`, `excluded from automatic staffing`, or `never` in the
  operational table are not staffing seats. Add a seat only after its harness,
  role, and controls are known. `cursor-grok-4.6` uses the Grok 4.6 evidence
  when Cursor is selected.
- `grok-build-0.1` is superseded.
- `claude-haiku-4-5` is removed by decision. Harness sub-agents already
  delegate to cheap and mid-tier models; this roster gives the orchestrator
  frontier choices.
- `ox-alpha` (`opencode/x-preview-f-free`) is removed by Henrique's decision
  (2026-08-22): weak in real execution. OpenCode has no roster seat until he
  scores a new one.
