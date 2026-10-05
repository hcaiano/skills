# Review brief

Paste the applicable axis sections into every reviewer prompt. The reviewer has
no other access to them. Always include the pinned range (merge-base SHA and
HEAD), the commit list, and the source documents named below.

## Rules for every reviewer

- Review the pinned range only. Read any file you need, but report findings on
  the change and the code it touches.
- Perform this review yourself, read-only, with no sub-agents. `test-audit` is
  the one skill you may invoke; another review skill would recurse this gate.
- Every finding cites its evidence: `file:line` plus the rule, smell, or spec
  line it breaks. A finding without a citation is not a finding.
- Rank by impact. Prefer a few high-conviction findings to a long list. Skip
  what linters, formatters, or type checkers already enforce. Skip style nits.
- Mark each finding `blocker`, `should-fix`, or `judgement`.

## Standards axis

Is the change built right? Check, in this order:

1. **Correctness.** Bugs, broken edge cases, regressions, race conditions,
   security and data-integrity problems, missing error handling at real
   boundaries, and tests that do not prove the behavior they claim. Check
   every added or changed test against the junk patterns in the `test-audit`
   skill. A real credential in the diff is a `blocker`; name its location,
   never its value.
2. **Repository standards.** Read the repo's instructions and documented
   conventions (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, coding-standards
   files). A documented breach can be a `blocker`; cite the file and rule.
3. **Structure.** Look for the move that deletes complexity instead of
   rearranging it: a reframing that makes branches, modes, helpers, or layers
   disappear. Flag:
   - a file that the change pushes from under 1000 lines to over 1000 lines;
   - new ad-hoc conditionals, one-off flags, or special cases bolted onto an
     existing flow instead of a model or dispatcher that owns them;
   - thin wrappers, pass-through or one-use helpers and variables, and
     abstractions that add indirection without domain meaning;
   - casts, `any`, `unknown`, or needless optionality that hide the real
     contract, and silent fallbacks, shims, aliases, or retries that no named
     shipped contract needs;
   - logic in the wrong layer, and bespoke helpers that duplicate a canonical
     one;
   - independent work serialized for no reason, and updates that can leave
     state half-applied.
4. **AI code slop.** Flag in the changed hunks:
   - comments a maintainer would not write: narration, syntax explanation, or
     prose that restates the code;
   - defensive checks or `try`/`catch` blocks that guard only imagined states
     or are unusual for the surrounding module;
   - naming, imports, and control flow that do not match the surrounding file.
5. **Code smells.** Fowler's smells apply even when the repo documents
   nothing, and are always `judgement`. A documented repo standard overrides
   them.

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

Return only actionable findings, ordered by impact within the assigned axes.
For each, give severity, `file:line`, and one or two sentences covering the
trigger, consequence, evidence, and suggested fix. Group by axis only when
reviewing both. State any missing evidence that limits the review. If there
are no findings, say so in one sentence. Omit praise, walkthroughs, repeated
summaries, and counts that the caller can derive from the findings.
