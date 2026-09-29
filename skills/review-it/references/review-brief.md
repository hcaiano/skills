# Review brief

Paste the applicable axis sections into every reviewer prompt. The reviewer has
no other access to them. Always include the pinned range (merge-base SHA and
HEAD), the commit list, and the source documents named below.

## Rules for every reviewer

- Review the pinned range only. Read any file you need, but report findings on
  the change and the code it touches.
- Work read-only. Do not invoke `/code-review`, `review-it`, or any other review
  skill, and do not spawn sub-agents: perform this review directly.
- Every finding cites its evidence: `file:line` plus the rule, smell, or spec
  line it breaks. A finding without a citation is not a finding.
- Rank by impact. Prefer a few high-conviction findings to a long list. Skip
  what linters, formatters, or type checkers already enforce. Skip style nits.
- Mark each finding `blocker`, `should-fix`, or `judgement`.

## Standards axis

Is the change built right? Check, in this order:

1. **Correctness.** Bugs, broken edge cases, regressions, race conditions,
   security and data-integrity problems, missing error handling at real
   boundaries, and tests that do not prove the behavior they claim.
2. **Repository standards.** Read the repo's instructions and documented
   conventions (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, coding-standards
   files). A documented breach can be a `blocker`; cite the file and rule.
3. **Structure.** Look for the move that deletes complexity instead of
   rearranging it: a reframing that makes branches, modes, helpers, or layers
   disappear. Flag:
   - a file that the change pushes from under 1000 lines to over 1000 lines;
   - new ad-hoc conditionals, one-off flags, or special cases bolted onto an
     existing flow instead of a model or dispatcher that owns them;
   - thin wrappers, pass-through helpers, and abstractions that add indirection
     without clarity;
   - casts, `any`, `unknown`, or needless optionality that hide the real
     contract, and silent fallbacks that paper over an unclear invariant;
   - logic in the wrong layer, and bespoke helpers that duplicate a canonical
     one;
   - independent work serialized for no reason, and updates that can leave
     state half-applied.
4. **AI code slop.** Flag in the changed hunks:
   - comments a maintainer would not write: narration, syntax explanation, or
     prose that restates the code;
   - defensive checks or `try`/`catch` blocks that guard only imagined states
     or are unusual for the surrounding module;
   - one-use variables or helpers that add no domain meaning;
   - compatibility shims, aliases, retries, and fallbacks without a named
     shipped contract that needs them;
   - naming, imports, and control flow that do not match the surrounding file.
5. **Smell baseline.** These apply even when the repo documents nothing, and
   are always `judgement`. A documented repo standard overrides them.
   - Mysterious Name → rename; no honest name means the design is murky.
   - Duplicated Code → extract the shared shape.
   - Feature Envy → move the method onto the data it uses.
   - Data Clumps → bundle fields that travel together into one type.
   - Primitive Obsession → give the domain concept its own small type.
   - Repeated Switches → one map or polymorphism shared by both sites.
   - Shotgun Surgery → gather what changes together into one module.
   - Divergent Change → split a module edited for unrelated reasons.
   - Speculative Generality → delete hooks the spec does not need.
   - Message Chains → hide the walk behind one method.
   - Middle Man → call the real target directly.
   - Refused Bequest → prefer composition to ignored inheritance.

For each structural finding, name the simpler shape, not only the problem.

## Spec axis

Does the change do what was asked? Read the source: the issue or ticket linked
from the commits or branch, a spec path the caller supplied, or the plan the
caller names. Report:

1. requirements that are missing or partial;
2. behavior in the diff that nobody asked for (scope creep);
3. requirements that look implemented but behave wrongly.

Quote the spec line for each finding. With no spec available, say so and review
only against the caller's stated intent.

## Output

Return findings grouped under `## Standards` and `## Spec` (only the assigned
axes), each as: severity, `file:line`, citation, problem, and the fix in one or
two sentences. End with the count per axis and the worst finding per axis. Do
not merge or rerank across axes.
