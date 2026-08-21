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

Apply these rules after the risk and context bar is fixed:

- Staff only the latest generation of each model family in each harness. Older
  generations are not staffing choices. The live catalogs decide current IDs.
- Taste scores rank models that already meet the task's risk and context bar.
  A score never lowers that bar or the proof required.
- API-priced rows use `barato`, `médio`, or `caro`. Claude and Codex use
  subscription pools, so their cost is `pool`; read their headroom from
  `usage-state.mjs`, not token prices.
- For Claude, GPT, or Grok models that Cursor also lists, prefer the native
  harness row. Cursor rows cover models that Cursor uniquely hosts.
- Before Cursor owns implementation, apply orchestrate's machine-specific
  headless Cursor caveat in
  [`staffing.md`](../../orchestrate/references/staffing.md).

Taste scores are Henrique's editable seed values. They are provisional and
can change as he gains evidence. `Updated` is the last update date for each
seed. Live catalogs remain authoritative for model IDs.

| Model | Harness | Taste | Cost | Quality evidence | Speed | Best for | Effort sweet spot | Updated |
|---|---|---:|---|---|---|---|---|---|
| `claude-fable-5` | claude | 9 | pool (premium) | S — SWE-V 95%, SWE-Pro 80.0 | slow-med | oracle/advisor and adversarial design review; not a volume executor | high (unstudied; escalate only on need) | 2026-08-21 |
| `claude-opus-5` | claude | 8.5 | pool | S — SWE-V 96% (near-saturated), SWE-Pro 79.2 | med-slow | deep architectural review and the hardest refactors | **medium** — high can regress (FrontierCode) | 2026-08-21 |
| `claude-sonnet-5` | claude | 7.5 | pool | A — SWE-V 85.2, T-Bench 80.4 | medium | default implementation workhorse | medium | 2026-08-21 |
| `claude-haiku-4-5` | claude | 5.5 | pool | B — SWE-V 73.3 | fast | mechanical edits, fan-out, and summaries | low, thinking off | 2026-08-21 |
| `gpt-5.6-sol` | codex | 8.5 | pool | S — AA Coding Agent Index #1 (80) | med-slow | hardest Codex agentic runs and long-horizon plans | **high** — xhigh/ultra rarely worth it | 2026-08-21 |
| `gpt-5.6-terra` | codex | 7.5 | pool | A — AA 77.4 | medium | balanced everyday Codex work | medium–high | 2026-08-21 |
| `gpt-5.6-luna` | codex | 6.5 | pool | B+ — AA 74.6 | fast | high-volume cheap execution, swarms, and tests | medium | 2026-08-21 |
| `grok-4.6` | grok | 8 | barato ($2/$6 below 200K) | S — SWE-bench (Vals) 95.6, AA #3 | med-fast | frontier coding and live web/X research at bargain price | high (CLI default); xhigh only on need | 2026-08-21 |
| `kimi-k3` | cursor | 7.5 | médio ($3/$15 flat 1M) | A — vendor: T-Bench 88.3, FrontierSWE 81.2 | medium | long-context repository review; proven excellent reviewer/consultant in the Mediavine run | ID `kimi-k3-high`; use `-max` for hard reviews | 2026-08-21 |
| `composer-2.5` | cursor | 6 | barato ($0.50/$2.50, about $0.07/task) | B+ — AA 62 | very fast | rapid cheap iteration inside Cursor | n/a (`std` versus `-fast`) | 2026-08-21 |
| `opencode/x-preview-f-free` ("Ox Alpha") | opencode | 7 (provisional) | **free for one week from 2026-08-21** | ~A/S, anecdotal only (DeepSWE community 80%, n=10) | fast (anecdotal) | free burst execution/evaluation during the preview week; no durable roles; re-verify the ID with `opencode models --refresh`; replies can have malformed protocol headers, so judge the receipt and diff, not the header | variants low/high/max; use high | 2026-08-21 |

Promo IDs belong only in roster data, never in scripts.

Specialists and excluded entries are not general staffing seats:

- `gpt-daybreak-blue-latest` (Codex) is a defensive-cybersecurity specialist.
  Use it only for security tasks, never as a general coding seat.
- `claude-mythos-5` is Glasswing-gated and unavailable.
- `gpt-reserve` and `codex-auto-review` are hidden/internal SKUs and are not
  staffed.
- Cursor also exposes `gemini-3.7-flash`, `gemini-3.1-pro`, `glm-5.2`, and
  `cursor-grok-4.6`. They are available but unscored; prefer `grok-4.6` in its
  native harness, and add rows only after Henrique scores them.
- `grok-build-0.1` is superseded by `grok-4.6` as the CLI default. It is a
  C-tier utility and is not staffed.
- The OpenCode account is unpaid. Ox Alpha is its only roster entry.

## Effort

Effort describes the reasoning budget, not the model's identity:

- **Claude**: `low` for mechanical work, `medium` for normal work, `high` for
  broad or risky work, `xhigh` for very hard work, and `max` only after an
  `xhigh` attempt still meets the same very-hard criterion. Claude Code accepts
  `--effort low|medium|high|xhigh|max`; this ladder is model-independent.
- **Codex**: all three roster models support
  `low|medium|high|xhigh|max`; Sol and Terra also support `ultra`. Use low for
  mechanical work, medium for normal work, high for thinking or risky work,
  xhigh for very hard work, and max only on exceptional work. Ultra is the
  final Sol/Terra step, not a default. Defaults are model-specific: Sol uses
  low; Terra and Luna use medium. A Codex pair spawn always sets effort
  explicitly, including medium.
- **Cursor**: effort is encoded in the model ID, such as `kimi-k3-high`; use an
  effort-specific live-catalog ID when one exists. Cursor also accepts the
  parameterized form `--model '<id>[effort=…]'`. Use low for mechanical work,
  medium for normal work, high for broad or risky work, and max only for hard
  reviews when that model offers it. Record the complete ID as the model and
  omit a separate pair effort.
- **Grok**: Grok 4.6 accepts `low|medium|high|xhigh` with
  `--reasoning-effort` and defaults to high. Use low for mechanical work,
  medium for normal work, high for broad or risky work, and xhigh only when
  risk or context requires it.
- **OpenCode**: use a variant advertised by the selected model. Headless
  turns pass `--variant` on every `opencode run`; the variant is a model/run
  setting, not a session flag. The OpenCode Herdr TUI does not expose it. Use
  low for mechanical work, high for broad or risky work, and max only for very
  hard work when the selected model offers those values.

Leave effort unset only for a CLI whose default the user explicitly chooses.
Codex pair spawns always set a supported value explicitly. Cursor records effort
inside its model ID; the OpenCode Herdr TUI omits effort because it cannot
express a variant. The pair records each expressible choice in session state
and passes it through the backend's per-CLI mapping.

## Optional usage evidence

When the sibling helper exists, usage evidence covers only the Claude and Codex
pools:

```bash
node "$SKILL_DIR/../orchestrate/scripts/usage-state.mjs"
```

Use its output as a tie-breaker. If the helper or either pool's source is
unavailable, omit usage evidence and continue with risk, context, roster, and
speed; pair startup stays quiet.
