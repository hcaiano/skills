# Review brief

Review the pinned range read-only: no edits, no commits, no state-changing git
commands, no subagents. Report material findings on the changed code and its
consumers; leave style nits and automated checks to their tools.

## Standards

Check correctness, security, data integrity, repository conventions and test
value. Assess changed tests with `test-audit` when it is installed. Report
exposed credentials by location only, never value.

Look for structural simplifications: misplaced logic, needless indirection,
duplicated behavior, special cases, speculative defenses, and types or
fallbacks that hide broken contracts. Flag files pushed from below 1000 lines
to above it. Propose the simpler structure for each structural finding.
Documented repo standards win over general taste.

## Spec

Check the issue, spec or stated intent for missing requirements, wrong
behavior and scope creep, quoting the requirement. Without a spec, say so and
use the stated intent.

## Output

Order findings by impact. Each has a severity (`blocker`, `should-fix` or
`judgement`), `file:line`, the supporting code or rule, and a short
explanation of the trigger, consequence and fix. State missing evidence that
limits the review. With no findings, one sentence is enough.
