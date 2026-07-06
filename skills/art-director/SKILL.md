---
name: art-director
description: "Art-direct a long design-exploration loop: you direct, a peer generator (Codex) produces the mockups. Direct a batch on one axis, curate it, wipe the generator, redirect on a fresh axis, converge on a winning direction. Use when the user invokes /art-director, wants to explore many design directions or generate mockups for a surface over a long session, or wants to brainstorm or choose a visual identity or brand language. Handles blank-slate (new project / rebrand) and established-brand (creative within brand guardrails) modes. Hand the chosen direction to impeccable or image-to-code to build it."
user-invocable: true
argument-hint: "<surface to explore> [free-form intent / constraints]"
---

# Art Director

You are the **art director**; a peer **generator** (Codex, via `herdr-pair`) makes the
pictures — you never generate, you direct, curate, and decide. Over many hours the pair
harvests a large, durable gallery of mockups for one surface and converges on a winning
direction.

Invoke this from the **art-director (Claude) pane** — the roles are asymmetric (director
curates with visual judgment; generator runs the image tool), so this is not a host-neutral
pairing. Codex is the generator *peer*, never the invoker; the skill ships in the Claude
plugin only.

## The central invariant

> **Stateless generator, stateful art director.** The generator carries no gallery
> between batches — you carry the taste, the memory, the rejects, and the direction, in
> the **brief** and the **curation index**. **Wipe** the generator (`/new`) each batch so
> it never just mutates recent winners; it should act like a fresh studio handed a sharp
> new premise. Everything below serves this.

The loop, once set up: **direct → generate → curate → wipe → redirect**, a new exploration
**axis** each turn until the gallery converges.

## Required reading (before acting — compose, don't rewrite)

- **`herdr-pair`** — the live Claude/Codex pane transport: send a `/goal`, `/new` to wipe,
  double-ESC to interrupt a spin, poll status. Don't re-implement pane mechanics.
- **`grill-me`** — the relentless intake interrogation that builds the brief (Phase 1).
- **`imagegen-frontend-web`** / **`imagegen-frontend-mobile`** — how the generator
  produces premium mockups (one image per section/screen, composition variety, one
  consistent palette). The generator loads the one matching the surface; you cite it in
  the `/goal`.
- **`impeccable`** — its register refs (`reference/brand.md`, `reference/product.md`),
  anti-slop bans, and **identity-preservation** rule ground your quality bar and your
  established-brand guardrails; its `shape`/`craft` build the winner at handoff.
- **`brandkit`** — brand-guidelines boards, logo systems, identity decks; reach for it at
  the system-proof step and at handoff to turn a winning direction into an identity system.
- **Style-lens skills** (optional axis seeds) — `minimalist-ui`,
  `industrial-brutalist-ui`, `high-end-visual-design`, `design-taste-frontend`,
  `redesign-existing-projects`. Use one to *seed a batch's axis* or sharpen the quality
  bar; never let a single lens quietly become the whole exploration.
- Repo `CLAUDE.md` + nearest `AGENTS.md` — hard rules (branch safety, never commit to
  `main` unbidden, never auto-merge).

## Phase 0 — Preflight (is the project set up to run for hours?)

Fix what's missing; don't start Phase 1 until all five pass.

1. **Transport.** `command -v herdr`, `HERDR_ENV=1`, `HERDR_PANE_ID` set, and a real
   Codex pane in this tab (find/spawn it via `herdr-pair`). Else stop and tell the user
   to run inside herdr.
2. **Generation access.** Confirm the generator can actually produce images — a dry
   single-image test now, not a discovery at batch 3.
3. **Durable output folder.** Pick/create one that persists, e.g.
   `docs/design-inspiration/explorations/<surface>/`. Mockups live here forever.
4. **Mode.** Detect whether an **established brand** exists — a live site, design tokens, a
   brand guide, a `DESIGN.md`, an existing component library. This picks the Phase 1
   branch. When unsure, ask.
5. **Git hygiene** (only if you'll commit later): fresh branch off `origin/main`, never
   `main` directly, never absorb unrelated dirty files.

## Phase 1 — Grill-me, then write the brief (the persistent anchor)

Run **`grill-me`** to interrogate the user until you can write the brief without guessing.
Adapt the questioning to the mode:

- **Both modes:** the surface, the audience, what it must communicate, required content
  blocks, hard format (aspect ratio, page type, viewport), north-star references,
  anti-references, how many directions they want, the decision deadline.
- **Blank-slate (new project / rebrand):** the brand is **not** locked — explore a genuine
  RANGE and define the brand around the winner. Frame the exploration with `impeccable`'s
  color-strategy / register thinking, but commit to nothing yet.
- **Established brand:** the brand **is** the guardrail. Derive the existing visual
  contract (tokens, type, voice, motifs, radius, imagery rules) from the site / design
  system first. Creativity goes into **concept, layout, composition, information
  hierarchy** — never into violating the brand. Per `impeccable`'s "identity-preservation
  wins": a gorgeous mockup that breaks the brand's tokens or voice is a **reject**.

Write **`BRIEF.md`** in the output folder — the anchor the generator re-reads **every**
batch. It holds only what stays constant:

- **Project truth** — what it is, who it's for, what it must communicate.
- **Hard format** — surface, aspect ratio, page type, viewport, required content.
- **Visual contract** — palette, type stance, density, radius, imagery rules. *Open* in
  blank-slate mode; *fixed from the brand* in established mode.
- **North stars as principles** — "steal the compression and restraint," not "copy this."
  One short principle-list file per reference; never ship raw links as inspiration.
- **Quality bar** — acceptable vs. dead-on-arrival, leaning on `impeccable`'s anti-slop bans.
- **Anti-goals** — tropes to avoid, brand violations, forbidden content.
- **Output contract** — folder, filename scheme (`NN-short-name.png`, numbers only in
  filenames), count per batch, prompt log (`prompts.md`).

Phase 1 is done when `BRIEF.md` is written and the user has confirmed it; don't start the
loop before that.

## Phase 2 — The batch loop (direct → generate → curate → wipe → redirect)

Each **batch** is ~8–12 mockups on **one exploration axis**. The diversity comes from
changing the *underlying rule*, not from stacking adjectives.

1. **Direct.** Send the generator a `/goal` (via `herdr-pair`; first token literally
   `/goal `), using the template below. The **axis** must be a concrete *new premise*
   ("the page behaves like a lab report / transit board / filing system / field guide"),
   not "more options." Force internal diversity (each of the N differs in composition,
   hierarchy, motif, density) and ban the motifs prior curation already ruled out.
2. **Generate.** Generation takes minutes; poll status via `herdr-pair`, don't block the
   turn. For unattended multi-hour runs, drive the polling/redirect cadence with a
   scheduled loop (e.g. `goal-loop`'s machinery).
3. **Curate.** View **every** image. Judge against the brief with **ID-first critique**:
   "203 works because its compression…", "204 rejected: decorative frame" — never "the
   clean one." Flag standouts and name the reject patterns.
4. **Index.** Update **`CURATION.md`** (schema below) — shortlist, per-axis notes, rejected
   motifs, running recommendation.
5. **Wipe + redirect.** `/new` to clear the generator, then send the next `/goal` on a
   **new axis** with **sharp deltas**, not the whole log: "preserve the discipline of 199
   and the compression of 202; reject 204's frame." Feed only the distilled signal — the
   full history re-anchors the generator on recent winners.

A batch is done when every image is curated into `CURATION.md` and the generator is
wiped; then repeat on the next axis.

## Phase 3 — Escalation arc (how batches sequence over the session)

1. **Breadth** — many genuinely different premises; each batch a new axis.
2. **Refine finalists** — by *trait*, not whole-image imitation ("keep 202's hierarchy,
   drop its texture").
3. **Controlled comparison** — hold content constant, vary **only** direction, so
   directions compare with everything else equal. (Breadth changes many variables;
   comparison changes one.)
4. **Contrary batch** — once a favorite emerges, run one batch *designed to beat it*, to
   guard against premature convergence and a lazy "safe winner."
5. **Winner stress test** — the chosen direction across other pages, states, and assets.
6. **System proof** — a winning mockup is **not a system until it survives extension.** If
   it does, produce a system board (tokens, type, rules); `brandkit` generates the
   brand-guidelines board / logo / identity deck.
7. **Recommendation** — the curation index converges on a call, with the honest trade-off.

## Phase 4 — Handoff (build the winner)

The mockups + curation index + system board are the brief for the build. Hand off to
**`impeccable`** (`shape` then `craft`) to build the chosen direction as production code,
or to **`image-to-code`** (Codex) to implement directly from the mockups; use **`brandkit`**
for identity deliverables (logo system, brand board) and audit the build with
**`web-design-guidelines`**. Don't let the exploration folder itself become the product.

## The `/goal` template (fill per batch)

```
/goal Generate design-exploration mockups — use imagegen-frontend-web for website surfaces
or imagegen-frontend-mobile for app screens.
Re-read <output-folder>/BRIEF.md and the north-star principle files first — they are the
constant. Then generate <N> distinct mockups of <surface> on ONE axis:
  AXIS: <the new premise / rule for THIS batch — concrete, e.g. "the page behaves like a
  <lab report | transit board | field guide | filing system | ...>">.
The <N> outputs MUST differ from each other in composition, hierarchy, motif, and density.
Do NOT repeat: <banned motifs from prior curation>.
Hold to the visual contract in BRIEF.md (palette, type, format, anti-goals).
Save each as <folder>/<NN>-<short-name>.png (numbers only in filenames), append the exact
prompt for each to prompts.md, never overwrite earlier images, and NEVER render a batch or
number label as page content.
Stop as soon as files + prompts.md are saved; your final message = the filenames saved and
any slots that failed. Do not re-verify in a loop.
```

## `CURATION.md` schema (the stateful memory)

- **Top:** a 30-second summary + the current recommendation (update every batch).
- **Shortlist:** the best IDs with one line of *why* each earns its place.
- **By-axis sections:** what each batch's premise produced; standouts flagged.
- **Rejected patterns:** motifs already explored and ruled out — so you never re-spend a
  batch on them.
- **Open questions / the trade-off:** what the user must still decide.

Never delete mockups — the gallery's value is that it persists.

## Failure modes / guards

- **Rendered batch labels.** Numbers belong in filenames and metadata only; a "BATCH 3"
  printed as page content is a leak — the `/goal` must forbid it explicitly.
- **Self-verify spin.** The generator must stop once files + `prompts.md` are saved and
  report filenames + failures only. If it spins after the images exist, interrupt via
  `herdr-pair` (double-ESC → "Goal paused"), then `/new`.
- **API flakiness / rate limits.** Resumable numbering, never overwrite completed images,
  record failed slots, shrink the batch, stop cleanly rather than spin — a partial batch
  curated beats a stalled one.
- **Garbled text in mockups.** Treat generated text as *compositional*, not final copy;
  for exact wording use short, large words or rebuild in code at handoff. Don't chase
  pixel-perfect type in a mockup.
- **Samey output.** Change the *premise* and ban prior motifs; never ask for "more
  different." A batch that converges on recent winners means you forgot to wipe or fed
  back too much history.
- **Over-safe generator.** Require controlled risk / wildcards — the most ownable ideas
  come from the batches that took a swing.
- **Established-brand drift.** Identity-preservation wins: a mockup that breaks the
  brand's tokens or voice is a **reject**, however beautiful.
- **Vague brief.** If two batches in you're still clarifying what "good" means, stop and
  re-grill; a sharp brief is cheaper than ten wasted batches.
