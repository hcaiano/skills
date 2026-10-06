# Review brief

Review the pinned range read-only: inspect, then report. Report material
findings on the changed code and its consumers; style and automated checks
belong to their tools.

## Standards

Check correctness, security, data integrity, repository conventions and test
value, assessing changed tests with `test-audit`. Report exposed credentials by
location only.

Look for structural simplifications: misplaced logic, needless indirection,
duplicated behavior, special cases, speculative defenses, and types or
fallbacks that hide broken contracts. Flag files pushed from below 1000 lines
to above it. Propose the simpler structure for each structural finding.
Documented repo standards win over general taste.

## Spec

Check the intent and acceptance criteria for missing requirements, wrong
behavior and scope creep, quoting the requirement.

## Output

Order findings by impact. Each has a severity (`blocker`, `should-fix` or
`judgement`), `file:line`, the supporting code or rule, and a short
explanation of the trigger, consequence and fix. State missing evidence that
limits the review. With no findings, one sentence is enough.
