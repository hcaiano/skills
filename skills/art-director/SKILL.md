---
name: art-director
description: "Explore and choose a visual direction before implementation."
disable-model-invocation: true
---

# Art Director

Explore visual directions, curate them with the user, and converge on one
defensible choice. The deliverable is the chosen direction; implementation
starts after this skill ends.

## Image generation

In Codex, use the built-in `imagegen` skill: its generation, editing,
validation, and save-path rules own the image work. Anywhere else, open a
[`pair`](../pair/SKILL.md) with a `codex` partner rooted at this workspace and
hand it each generation brief; it generates with `imagegen`, saves the images in the workspace, and
returns their paths and exact prompts.

Run intake as a grilling conversation: investigate facts yourself, ask
decisions one at a time with your recommended answer, and wait for the user's
reply.

## Workflow

1. **Inspect.** Determine whether this is blank-slate or constrained by an
   existing brand. Read available references, product context, design tokens,
   and existing surfaces before asking questions.
2. **Intake.** Resolve the audience, surface, communication goal, required
   content, format, references, anti-references, hard brand constraints, and
   decision deadline. Ask only what materially changes the exploration.
3. **Frame directions.** Name three to five concrete visual premises. Each
   direction needs a different underlying rule for composition, hierarchy,
   imagery, and mood. "More options" is not a direction.
4. **Generate breadth.** Generate one image per direction. Keep the
   functional content and format constant so the visual ideas are comparable.
   Preserve an established identity; for blank-slate work, explore a genuine
   range. Keep the exact prompt for every output.
5. **Curate.** Inspect every image. Identify it by filename or stable ID and
   explain what works, what fails, and which reusable trait it contributes.
   Maintain a shortlist and a rejected-pattern list. Ask the user for the next
   decision one question at a time.
6. **Refine.** Generate two or three variants of the strongest direction.
   Change one named trait at a time instead of remixing everything.
7. **Prove the system.** Stress-test the winner on an adjacent page, state, or
   asset. For identity work, generate one coherent system board from the
   selected direction: mark, palette, type, and one applied surface.
8. **Hand off.** Return the selected asset paths, exact prompts, visual rules,
   rejected patterns, and remaining trade-offs. Save project-bound outputs in
   the workspace according to `imagegen`; preview-only outputs may remain
   inline.

## Stop condition

Stop when the user has selected a direction and it survives one relevant system
proof. Do not start an unattended loop, create arbitrary batches of dozens of
images, or create persistent `BRIEF.md` or curation files unless the user asks
for them or the exploration belongs in the project.
