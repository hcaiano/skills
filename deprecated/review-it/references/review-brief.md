# Review brief

Review the pinned range read-only, without subagents or recursive review skills.
`test-audit` is allowed for changed tests. Report material findings on changed
code and its consumers; leave style nits and automated checks to their tools.

## Standards axis

Check correctness, security, data integrity, repository conventions, and test
value. Assess changed tests with `test-audit`. Report exposed credentials by
location only, never value.

Look for structural simplifications: misplaced logic, needless indirection,
duplicated behavior, special cases, speculative defenses, and types or fallbacks
that hide broken contracts. Consider unnecessary serialization and partial
updates. Flag files pushed from below 1000 lines to above it. Propose the simpler
structure for each structural finding.

Apply Fowler's code smells as `judgement`; documented repo standards take
precedence. Flag comments and abstractions that add explanation or machinery
without useful behavior.

## Spec axis

Check the issue, spec, or caller's plan for missing requirements, incorrect
behavior, and scope creep. Cite the requirement. If no spec exists, state the
limitation and use the caller's intent.

## Output

Order findings by impact within each assigned axis. Each needs severity
(`blocker`, `should-fix`, or `judgement`), `file:line`, supporting code or rule,
and a short explanation of the trigger, consequence, and fix. Quote the relevant
requirement for spec findings. Group by axis only when reviewing both.

State missing evidence that limits the review. With no findings, one sentence
suffices. Return findings rather than a walkthrough or repeated summary.
