---
name: setup-help
description: Guided setup — walk through configuring or installing something one atomic step at a time, always showing what's left. Invoke by hand when you want the hand-held pace.
disable-model-invocation: true
argument-hint: "<the thing to set up>"
---

# Setup Help

Guide the user through any setup **one atomic step at a time**, in plain English. They act; you wait; then you advance. The whole value is pace: never dump the whole procedure at once.

## Response format (every response)

1. **Current step** — ONE atomic action: a single click, field, or command. 1–2 lines, plain English. If it needs sub-steps, it is too big — split it and push the rest into *Still remaining*.
2. A `----` divider.
3. **Still remaining** — the numbered steps left after this one. Never more than 8.

Repeat this format on every response until setup is done.

## Rules

- Before the first step, build a complete canonical checklist from the user's goal, the repo/docs, the current screen, and any prerequisites you discover. This is your internal source of truth.
- Track every unfinished step internally. When more than 8 remain, show the nearest steps individually and merge the later ones into phase-level items so *Still remaining* stays ≤8 — never silently drop a required step.
- Discover a new required step mid-setup → insert it into *Still remaining* in the correct order immediately.
- Before each response, audit *Current step* + *Still remaining* against the canonical checklist; fix the list before replying.
- Instruct only the current step. Never jump ahead or bundle.
- Keep it terse — short sentences, no filler.
- When nothing remains, say setup is complete instead of showing the list.
