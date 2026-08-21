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
- **Pool**: use the pool that has headroom and the CLI the user chose. Pool
  balance breaks a tie; it does not override risk or context.
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

The seats are the first read for staffing after risk and context set the bar.
The dimension scores rank only models that meet that bar. The live catalogs
remain authoritative for model IDs.

### Seats por papel

| Papel | Seat | Harness | Effort | Fallback |
|---|---|---|---|---|
| Planear / orquestrar | `claude-fable-5` | claude | **medium** for normal work; **high** only on the opening planning prompt of a large orchestration; never max because short tasks show an overthinking regression | `gpt-5.6-sol` high |
| Execução de alta qualidade (back-end e geral) | `gpt-5.6-sol` | codex | **high**; `ultra` is a subagent mode, not an effort value | `grok-4.6` high |
| Execução rápida | `grok-4.6` | grok | **high** (CLI default) | `ox-alpha` high |
| Execução barata em volume | `gpt-5.6-luna` | codex | **xhigh/max** with Sol planning and review; never for UI work; verbose at max | `ox-alpha` |
| Executor grátis (enquanto durar) | `ox-alpha` (`opencode/x-preview-f-free`) | opencode | variant high | — expires ~2026-08-28 |
| UI / design (taste) | `kimi-k3` **e** `claude-opus-5` | cursor / claude | `kimi-k3-high` (`-max` for hard work); Opus high for design review and medium for UI diffs | one covers the other |
| Image gen (UI ideas, imagens, app logos, qualquer coisa que precise de imagem) | **Image Gen 2 with `gpt-5.6`** | the `gpt-5.6` surface that exposes Image Gen 2 | — | — |
| Cyber (defensivo) | `gpt-daybreak-blue-latest` | codex | low; raise on need | — |
| Research live web/X | `grok-4.6` | grok | high (CLI default) | claude + WebSearch |

Opus's primary seat is UI/design. Its legitimate secondary use is execution
under a stronger supervisor such as Fable. Its strong benchmark aggregates,
including SWE-V 96, diverge from Henrique's daily-use experience outside UI;
his experience governs. The open question is whether `kimi-k3` will replace
Opus for UI entirely. Evaluate that question over the next design tasks. During
the initial design-planning phase, pair the UI/design seat with Claude Code's
`/design` command.

Grok is a fast, good execution seat as well as the live-research seat. Ox Alpha
is a real executor while it is free, not only a burst option.

`composer-2.5` has one niche: fast in-Cursor iteration under an external plan,
as in "Grok plans, Composer builds". It is much faster in wall-clock time than
`grok-4.6`, but it is less capable: CursorBench scores are 56.1 and 69.9. It is
not a headline seat.

### Dimension scores

Scores are Henrique's editable seeds. His daily-use experience governs them;
benchmark aggregates inform them. They are provisional and can change when he
gets new evidence. Inteligência and Taste use a 0–10 scale; `?` marks low
confidence. Velocidade uses only `lento`, `médio`, or `rápido`. More reasoning
effort makes a run slower. Custo uses only `barato`, `médio`, or `caro`, based
on the subscription consumed and how constrained its pool is; it never uses
API prices. Each row carries its last `Updated` date. Apply these rules to every
seed:

- Staff only the latest generation of each model family in each harness. The
  live catalogs decide current IDs.
- Scores rank models that already meet the risk and context bar. A score never
  lowers that bar or the required proof.
- Prefer a native harness over a Cursor duplicate. Cursor rows cover models
  that Cursor uniquely hosts.
- Before Cursor owns implementation, apply the machine-specific headless
  Cursor caveat in
  [`staffing.md`](../../orchestrate/references/staffing.md).

| Model | Inteligência | Taste | Velocidade | Custo | Key evidence | Updated |
|---|---:|---:|---:|---|---|---|
| `claude-fable-5` | 9.5 | 9 | lento | caro | Artificial Analysis Intelligence leader; premium pool | 2026-08-21 |
| `gpt-5.6-sol` | 9 | 8 | médio | médio | Artificial Analysis Coding Agent #1; top back-end executor confirmed by Henrique | 2026-08-21 |
| `gpt-daybreak-blue` | 9 | n/a | médio | médio | equal to Sol; defensive-only | 2026-08-21 |
| `grok-4.6` | 8.5 | 6 | rápido | barato | deep quota on SuperGrok; fast quality executor confirmed by Henrique | 2026-08-21 |
| `kimi-k3` | 8 | 10 | lento | médio | DesignArena #1; inside the $200 Cursor subscription | 2026-08-21 |
| `ox-alpha` | 7 | 8 | rápido | barato | community praise for its design taste; likely GLM-5.x; free week, then a cheap OpenCode plan | 2026-08-21 |
| `claude-opus-5` | 8 | 9 | médio | médio | benchmarks say far more (SWE-V 96), but daily use puts it below Sol; UI/design or work supervised by Fable | 2026-08-21 |
| `gpt-5.6-luna` | 7 | 5 | rápido | barato | volume executor at xhigh/max | 2026-08-21 |
| `composer-2.5` | 7 | 6 | rápido | barato | niche: fast in-Cursor iteration under an external plan | 2026-08-21 |

Promo IDs belong only in roster data, never in scripts.

### Pace and fallback

Before staffing, read the Claude and Codex pools with:

```bash
node "$SKILL_DIR/../orchestrate/scripts/usage-state.mjs"
```

Cursor, Grok, and OpenCode have no local usage source. A refusal or rate limit
is their headroom signal. If the primary pool has `used_percent >= 90`, refuses
the request, or returns a rate limit, staff the seat's fallback. Keep the same
risk and context bar.

Cursor is the deliberate universal fallback harness. It hosts Anthropic,
OpenAI, xAI, and other providers, so any seat can use Cursor when its native
pool is exhausted. Prefer the native harness. Name Cursor as the exception in
the staffing reason when it is the fallback.

Balance equal-bar work across subscriptions during a wave. This protects the
week's headroom in every harness. Grok 4.6 "unlimited" has a quota in practice;
treat it as a deep pool, not an infinite pool.

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
- Cursor extras `gemini-3.7-flash`, `gemini-3.1-pro`, `glm-5.2`, and
  `cursor-grok-4.6` are unscored. Add rows only after Henrique scores them.
- `grok-build-0.1` is superseded.
- `claude-haiku-4-5`, `gpt-5.6-terra`, and `claude-sonnet-5` are removed by
  decision. Harness sub-agents already delegate to cheap and mid-tier models;
  this roster gives the orchestrator frontier choices.

The OpenCode account is unpaid. Ox Alpha is its only roster entry. Re-verify
the preview ID with `opencode models --refresh`. Its replies can have malformed
protocol headers, so judge the receipt and diff, not the header.
