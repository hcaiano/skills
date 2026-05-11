# Skill Audit — May 2026

Output of a `/coworkers` debate between Claude and Codex auditing the 4 active skills against `skill-creator`'s framework. Both agents reached consensus. No files were edited during the audit.

The deltas are organized as **additive changes (15)** plus **subtractive simplifications (5)**. Applied together, the active skills shrink by ~37% in total line count while gaining mode-split safety, bundled mechanics, project-portability, and clearer triggering.

## Recommended implementation order

1. **RPC1 + SI3** — mode-split for autonomous side effects + shared `references/pr-comment-loop.md`. Biggest safety win. Without this, `review-pr-comments` in `all` mode can push and merge `main` without confirmation.
2. **HP1** — bundle `herdr-pair` mechanics as scripts (`bootstrap.sh`, `send.sh`, `update-session.py`). Fixes the Enter-not-pressed bug at the source.
3. **SI2** — project-aware quality gate. Currently bun-only; breaks for any non-Gam3s repo using this via `npx skills`.
4. **DM2** — define `debug-mode`'s instrumentation contract. Currently promises infrastructure it doesn't specify.
5. **S1–S5** plus the remaining HP/SI/DM/RPC items — cleanup, progressive disclosure, simplifications.

## Projected line counts after all changes

| Skill | Now | After | Δ |
|---|---|---|---|
| herdr-pair | 259 | ~140 | **−46%** |
| ship-it | 124 | ~50 | **−60%** |
| review-pr-comments | 222 | ~130 | **−41%** |
| debug-mode | 28 | ~80 | +186% (appropriate — currently under-specified) |
| **Total** | **633** | **~400** | **−37%** |

## Operating principle

A line earns its place in a SKILL.md if removing it would change agent behavior in a way you'd regret. ALL-CAPS rules, recap sections, and historical context usually fail this test.

---

## herdr-pair — `skills/collaboration/herdr-pair/SKILL.md` (259 lines)

### HP1. Bundle mechanics as scripts

- Add `scripts/bootstrap.sh`, `scripts/send.sh`, `scripts/update-session.py`.
  - `bootstrap.sh` — resolve self, find partner, generate sid, write `session.json` atomically. Prints `<partner-pane> <sid>` on stdout.
  - `send.sh <partner-pane> <sid> <kind> <body-file>` — pre-send checks, heredoc send, post-send verify with one Enter retry, atomic session update. Returns 0 only on verified delivery.
  - `update-session.py <field-path> <value>` — atomic JSON updates for `round`, `last_status[*]`, `no_progress_count`.
- SKILL.md retains the protocol/policy doc; mechanics sections become "call this script" pointers.
- **Why:** skill-creator's "if every invocation reinvents the same script, bundle it" rule. Also fixes the Enter-not-pressed bug at the source — one canonical send-with-verify path instead of each agent's improvised bash.

### HP2. Move placeholder catalog to references

- Create `references/placeholder-strings.md` containing the literal host-CLI strings (`Try "..."`, `Summarize recent commits`, status lines, prompt glyphs).
- SKILL.md keeps the principle: "ignore empty-buffer UI hints; block only on user-authored queued/input text. When uncertain, prefer sending — placeholders are overwritten harmlessly."
- `send.sh` reads the reference file at runtime.
- **Why:** progressive disclosure. Host strings rot fastest; isolate them from the policy.

### HP3. Hard preflight gate at bootstrap start

- New bootstrap step 0: verify `command -v herdr` exists, `HERDR_ENV=1` is set, `HERDR_PANE_ID` is present.
- If missing → stop with a clear "this skill needs the herdr CLI and the `herdr` skill loaded" message.
- Don't try to prove the herdr skill body is loaded — prove the CLI/env are usable.
- **Why:** teammates installing only `herdr-pair` via `npx skills add hcaiano/skills -s herdr-pair` will hit a confusing `pane get: command not found` partway through bootstrap. Fail fast.

### S1. Drop "Why this isn't cmux-pair-2" section (lines 229–234)

- 6 lines of historical context for the maintainer; doesn't help an agent execute the skill.
- Move to git history or `CONTEXT.md` if the rationale matters.
- **Why:** the intro already explains what herdr-pair does; the comparison is nostalgia.

### S2. Drop "Failure handling cheatsheet" (lines 214–221)

- Duplicates failure modes already covered inline in their respective sections.
- **Why:** dual statements drift and contradict over time. One source per rule.

### S3. Move Workbench tab to `references/workbench-tab.md`

- 14 lines for a lazy/optional feature most sessions never use.
- Keep one sentence in SKILL.md pointing to the reference.
- **Why:** progressive disclosure. Pay context cost only when actually creating a workbench.

---

## ship-it — `skills/workflow/ship-it/SKILL.md` (124 lines)

### SI1. Soften ALL-CAPS rules into reasoning

- Lines 23–27 ("Quality Gate (MANDATORY — never skip)"), 115–119 ("`--no-verify` is FORBIDDEN", "Quality gate is MANDATORY").
- Keep the strict behavior; replace the imperative with the why. Example: "Run the quality gate before push. The same checks fail in CI 3–5 min later, costing a round-trip and losing context warmth. Local first is faster end-to-end."
- **Why:** skill-creator flags ALL-CAPS MUSTs as a yellow flag. Reasoning is more durable than rules.

### SI2. Project-aware quality gate

- Lines 24 and 95 currently hardcode `bun check && bun check-types && bun build`.
- Replace with detection: lockfile inspection (`bun.lock` → bun, `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `package-lock.json` → npm, `Cargo.toml` → cargo, `go.mod` → go), then read `package.json` scripts for `check`/`check-types`/`build` equivalents.
- Fallback: read repo instruction files (`CLAUDE.md`, `AGENTS.md`) for a documented quality-gate command; otherwise ask the user.
- Persist the chosen command in the PR summary or local cache so re-runs don't re-detect.
- Same fix applies to `review-pr-comments` final validation.
- **Why:** hcaiano-skills is shared via `npx skills`. Bun-only fails silently on most repos.

### SI3. Shared PR comment loop reference

- Create `references/pr-comment-loop.md` containing: fetch endpoints (REST + GraphQL for unresolved threads), classification categories, reply format, mode-split safety policy (see RPC1).
- ship-it Phase 4 collapses to "after push, run the PR comment loop per `references/pr-comment-loop.md`".
- `review-pr-comments` becomes the dedicated entrypoint loading the same reference.
- **Why:** same algorithm in two skills → drift. Single source, two entrypoints.

### SI4. Drop the 20-minute wall-clock budget

- Remove time-budget language from line 36 ("up to ~20 minutes") and line 113.
- Keep step 9's "two consecutive clean rechecks" as the success condition.
- Add a no-progress guard: stop only when checks/reviews show no change over N consecutive rechecks (analogous to herdr-pair's `no_progress_count`), or when auth/rate limits block inspection, or when a side effect needs user approval.
- **Why:** time is a poor proxy for progress. Same critique we just applied to herdr-pair's round cap.

### SI5. Repo-agnostic instruction file references

- Line 68 references `CLAUDE.md` only. Replace with "repo instruction files (`AGENTS.md`, `CLAUDE.md`, or project-local equivalent)".
- Same change in `review-pr-comments` lines 53/63/217 (also covered in RPC2).
- **Why:** these skills are meant for Codex and coworkers too.

### S4. Drop "Rules" section (lines 115–124)

- 10 lines that duplicate the Phase-level MUSTs. Once SI1 reframes them as in-line reasoning, the recap section is pure duplication.
- **Why:** less to maintain, no drift between Phase prose and Rules list.

---

## debug-mode — `skills/engineering/debug-mode/SKILL.md` (28 lines)

### DM1. Move triggers into the description; add exclusion

- Move trigger phrases from body lines 12–14 into the frontmatter description.
- Add the "do not use when root cause is already obvious" exclusion to the description.
- **Why:** skill-creator: "all 'when to use' info goes here" (frontmatter). The description is the primary triggering mechanism.

### DM2. Define the instrumentation contract

- Line 3 promises "structured HTTP logging to a local debug server" but the body never defines: server shape, log schema, port/lifecycle, cleanup, what to do when the app can't reach localhost.
- Add an "Instrumentation contract" section: fields `hypothesis_id`, `event`, `request_id` / `session_id`, observed values, timestamp. Server lifecycle: how it starts, how it shuts down, how the agent confirms it's listening.
- Consider bundling `scripts/debug-server.py` (or a template) since every invocation will re-invent it.
- **Why:** lack-of-surprise violation. The skill promises infrastructure; either define it precisely or don't claim it.

### DM3. Add output/report format and failure modes

- 28 lines is too thin for a hypothesis-driven debugging skill.
- Add a final-report template: symptoms, hypotheses tested, evidence collected, confirmed root cause, fix applied/not applied, instrumentation removed, residual risk.
- Add edge cases: cannot reproduce, auth-walled reproduction, user can't reproduce, logs disprove all hypotheses, instrumentation changes behavior.
- **Why:** consistent behavior. As-is, two invocations of debug-mode on the same bug could produce wildly different deliverables.

---

## review-pr-comments — `skills/workflow/review-pr-comments/SKILL.md` (222 lines)

### RPC1. Mode-split for autonomous side effects

- Currently Phase 3 says "Do NOT ask for confirmation" (lines 67–71), but Phase 4b creates follow-up branches/PRs (89–111), Phase 6 pushes and can merge main (144–172), and multi-PR mode asks confirmation (200–208).
- Split modes explicitly:
  - **Default single-PR mode**: may fix, comment, push to the same branch.
  - **Expanded mode** (creating follow-up PRs, processing `all`, touching out-of-scope files, modifying main): requires explicit user confirmation up front.
- This policy lives in `references/pr-comment-loop.md` (SI3) so ship-it inherits it.
- **Why:** lack-of-surprise. The Phase 3 "no confirmation" + Phase 6 "push and merge main" combo is genuinely dangerous when chained with `all` mode.

### RPC2. Preflight/dependency section before Phase 1

- Add a preflight: `gh auth status`, `gh repo view`, `git status`, current branch is not main (unless explicit), PR exists or argument supplied, identify package manager / quality-gate command, read repo instruction files (`AGENTS.md` and/or `CLAUDE.md`).
- Replace CLAUDE.md-only references at lines 53/63/217 with repo instruction files generally.
- **Why:** the skill currently assumes a lot of environment correctness and fails noisily later. Fail fast.

### RPC3. Progressive disclosure: split policy from mechanics

- At 222 lines the file mixes: policy loop, REST/GraphQL API endpoints, reply formatting, bot heuristics, final report template.
- Create `references/github-comment-fetching.md` for the API mechanics.
- Optionally bundle `scripts/fetch-pr-comments.sh` (or `.py`) returning normalized JSON.
- SKILL.md keeps the policy loop and points to the reference for endpoints.
- **Why:** drift resistance + testability with mocked gh fixtures.

### RPC4. Typo + casing fixes

- Line 55: `ultracite[bot]}` has a stray `}`.
- Line 10 (`Coderabbit`) vs line 53 (`CodeRabbit`) — pick one.
- **Why:** small, fold into another edit pass.

### S5. Collapse bot detection into one heuristic

- Replace the per-bot table with: "any `user.login` containing `'bot'` OR a known bot logname → bot; otherwise human (authoritative)."
- **Why:** new bots (Greptile, Korbit, etc.) come online frequently. A heuristic generalizes; a per-bot table goes stale.

---

## Cross-cutting

### EVAL1. Add 2–3 eval prompts per skill before any rewrite

- **debug-mode:** assertions on "produces hypotheses before fixes" + "root-cause evidence report present".
- **review-pr-comments:** mocked gh JSON fixtures, assertions on correct classification (fix / false-positive / out-of-scope / needs-discussion) without touching GitHub.
- **herdr-pair:** harder to eval mechanically; sanity-check via dry-run script that exercises bootstrap + send + receive without actually splitting panes.
- **ship-it:** eval the commit-grouping and quality-gate-detection steps against a fixture repo.
- **Why:** skill-creator's loop assumes eval-driven iteration. Without evals, changes are vibes-based and regressions are invisible.
