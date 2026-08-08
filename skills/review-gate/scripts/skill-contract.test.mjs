import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const reviewGate = readFileSync(join(here, "../SKILL.md"), "utf8");
const processTransport = readFileSync(
  join(here, "../references/visible-herdr-runs.md"),
  "utf8",
);
const openai = readFileSync(join(here, "../agents/openai.yaml"), "utf8");

test("review-gate stays manual-only across model runtimes", () => {
  assert.match(reviewGate, /^description: "Manual-only /mu);
  assert.match(reviewGate, /^disable-model-invocation: true$/mu);
  assert.match(openai, /^  allow_implicit_invocation: false$/mu);
});

test("the gate never delivers — that restraint is what makes it reusable", () => {
  assert.match(
    reviewGate,
    /never pushes, opens or updates a PR, waits on CI, merges,\s+or deploys/u,
  );
  assert.match(
    reviewGate,
    /safe to run against a branch whose PR already\s+exists/u,
  );
  assert.match(reviewGate, /reach a clean review\s+HEAD without pushing/u);
  assert.match(
    reviewGate,
    /Say plainly that\s+nothing was pushed and no PR was touched/u,
  );
});

test("the range is resolved once, from a fetched base", () => {
  assert.match(
    reviewGate,
    /a stale local target reviews another PR's commits/u,
  );
  assert.match(reviewGate, /an explicit commit, when re-reviewing one landed change/u);
  assert.match(reviewGate, /the uncommitted working tree, when nothing is committed yet/u);
  assert.match(reviewGate, /A gate over\s+an unproven range reviews a moving target/u);
});

test("grading is risk-adaptive and auditable", () => {
  assert.match(
    reviewGate,
    /`skip` — a non-runtime change, or a mechanical low-risk runtime change/u,
  );
  assert.match(reviewGate, /It runs no simplify and no LLM review/u);
  assert.match(
    reviewGate,
    /`single` — a normal runtime change contained within one subsystem/u,
  );
  assert.match(
    reviewGate,
    /`dual` — auth, permissions, security, payments, migrations, destructive data,\s+infrastructure, concurrency, public contracts, cross-service or\s+multi-subsystem changes/u,
  );
  assert.match(
    reviewGate,
    /Any uncertainty about satisfying `skip` promotes to `single`; any\s+uncertainty about subsystem containment, requirements, or blast radius promotes\s+to `dual`/u,
  );
  assert.match(
    reviewGate,
    /Staffing, implementing model, and use of a pair never choose the grade or number\s+of reviews/u,
  );
  assert.match(reviewGate, /capacity changes execution,\s+not the semantic grade/u);
  assert.doesNotMatch(reviewGate, /regrades to the other harness/u);
});

test("simplify keeps its named target and its user override", () => {
  assert.match(reviewGate, /Name one concrete structural target/u);
  assert.match(reviewGate, /size alone is not a target/u);
  assert.match(reviewGate, /Simplify is independent of reviewer count/u);
  assert.match(
    reviewGate,
    /A user-requested simplify pass overrides every one of those eligibility\s+skips, at any grade including `skip`/u,
  );
  assert.match(reviewGate, /A failed or aborted\s+attempt is not success/u);
  assert.match(reviewGate, /Reapply step 1's risk grade/u);
});

test("review promotion and degradation survive", () => {
  assert.match(reviewGate, /A `single` reviewer promotes the gate/u);
  assert.match(
    reviewGate,
    /A `dual` review that cannot complete preserves its semantic grade\s+and records degraded execution/u,
  );
  assert.match(
    reviewGate,
    /Two reviews from the same harness do not satisfy\s+`dual`/u,
  );
  assert.match(
    reviewGate,
    /a refusal, rate-limit notice, or empty payload is\s+a failed review even with exit zero/u,
  );
  assert.match(reviewGate, /Fable is advisor-only/u);
});

test("Codex review selects the diff mechanically", () => {
  assert.match(
    reviewGate,
    /`node <skill dir>\/scripts\/headless-codex\.mjs "<axis prompt>" --base\s+origin\/<target-branch>` wrapper/u,
  );
  assert.match(
    reviewGate,
    /wrapper resolves\s+the merge base before the review starts, pins that range in the prompt, and\s+records the resolved SHA in its receipt/u,
  );
  assert.match(
    reviewGate,
    /the reviewed range is a fact\s+rather than an instruction the model may skip/u,
  );
  assert.match(
    reviewGate,
    /`codex exec`\s+with a freeform prompt does not satisfy this gate/u,
  );
  assert.doesNotMatch(
    reviewGate,
    /git diff "\$\(git merge-base HEAD origin\/<target-branch>\)"/u,
  );
  assert.match(
    reviewGate,
    /Name\s+the assigned axis in the reviewer's prompt, include its applicable sources, and\s+require read-only findings output/u,
  );
});

test("external gate commands select and record an honest transport", () => {
  assert.match(
    reviewGate,
    /records whether it ran in a\s+visible Herdr pane or as a local background process/u,
  );
  assert.doesNotMatch(reviewGate, /blocked outside Herdr/u);
  assert.match(processTransport, /scripts\/run-transport\.mjs/u);
  assert.match(
    processTransport,
    /Outside Herdr, omit `PAIR_ID`; the helper selects `local`\. With `HERDR_ENV=1`,\s+the caller proof must be complete for `herdr` selection/u,
  );
  assert.match(
    processTransport,
    /same launch\s+and receipt shape, but different operator control/u,
  );
  assert.match(
    processTransport,
    /a local run has no live surface for\s+observation or interjection/u,
  );
  assert.match(
    processTransport,
    /completion receipt's token and `transport` to match the run file/u,
  );
});

test("transport preserves wrapper liveness and Herdr pane proof", () => {
  assert.match(
    processTransport,
    /transport owns observation:[\s\S]*receipt polling for local/u,
  );
  assert.match(
    processTransport,
    /wrappers\s+own both backends' idle and total deadlines, PID-scoped termination, and content\s+validation/u,
  );
  assert.match(
    processTransport,
    /Herdr backend retains every visible-run invariant: `pane_id` and `marker`\s+must be non-null/u,
  );
  assert.match(
    processTransport,
    /completion\s+receipt's pane and token must match the launch/u,
  );
  assert.match(
    processTransport,
    /lead closes it with `herdr pane close\s+<pane_id>`/u,
  );
  assert.match(
    processTransport,
    /Close only panes created by this gate, never the caller or\s+another unit pane/u,
  );
});

test("the receipt carries the gate's own chain of custody", () => {
  assert.match(reviewGate, /Leave a `## Review gate` receipt/u);
  assert.match(
    reviewGate,
    /A caller that delivers this change embeds the\s+block verbatim rather than restating it/u,
  );
  for (const field of ["Gate:", "Risk:", "Regrade:", "Simplify:", "Reviewed HEAD:", "Gate HEAD:"]) {
    assert.match(reviewGate, new RegExp(`\`${field}\``, "u"), `receipt must define ${field}`);
  }
  assert.match(
    reviewGate,
    /an ancestor of the\s+final HEAD whenever the gate found anything/u,
  );
  assert.match(
    reviewGate,
    /`Reviewed HEAD` and `Gate HEAD` are the gate's chain of custody[\s\S]*so a corrected gate is expected to carry\s+two different HEADs/u,
  );
  // Delivery fields belong to the caller; restating them here would fork the
  // single source of truth for what ships.
  assert.doesNotMatch(reviewGate, /Final validated HEAD:/u);
});

test("the extracted gate stands on its own", () => {
  // Naming ship-it as a known caller is correct and stays. What must not
  // survive the extraction is the gate resolving paths relative to a skill its
  // caller may never have invoked, or deferring to rules it now owns itself —
  // a standalone install has no ship-it to look beside or defer to.
  assert.match(reviewGate, /or ship-it delegates its graded\s+gate/u);
  assert.doesNotMatch(processTransport, /beside ship-it/u);
  assert.doesNotMatch(processTransport, /ship-it's content rules/u);
  assert.doesNotMatch(processTransport, /every ship-it simplify/u);
  // herdr-orchestrate finds this gate's panes by this exact label. A pane
  // labelled for ship-it is read there as a delivery in progress, which a
  // standalone or orchestrator-invoked gate run is not.
  assert.match(processTransport, /--label "review-gate · /u);
  assert.doesNotMatch(processTransport, /--label "ship-it · /u);

  // Both sibling skills are dependencies, not bundles. Absence must have a
  // defined outcome, or a standalone install has no runnable path.
  assert.match(
    reviewGate,
    /pool state unread \(usage-state\.mjs not installed\)[\s\S]*leaves\s+the semantic grade, the reviewer count, and simplify exactly as graded/u,
  );
  // The two environments resolve a missing herdr-pair differently, because
  // run-transport.mjs hard-stops an incomplete pin under HERDR_ENV=1 rather
  // than demoting a hosted run to an invisible one. A single "falls back to
  // local" rule would promise a run that cannot start.
  assert.match(
    reviewGate,
    /Outside `HERDR_ENV=1` the\s+transport selects `local`/u,
  );
  assert.match(
    reviewGate,
    /Inside `HERDR_ENV=1` a missing\s+proof stops the gate/u,
  );
});

test("the gate's end state matches the range it was given", () => {
  // An uncommitted range cannot reach a clean committed HEAD without
  // committing work the gate never touched, so steps 5, 6 and Report each
  // carry the branch/uncommitted split — not step 3 alone.
  assert.match(
    reviewGate,
    /on a branch range,\s+commit all corrections and reach a clean final HEAD; on an uncommitted range,\s+leave the corrections in the working tree/u,
  );
  assert.match(reviewGate, /the gate's end state matches its range/u);
  assert.match(
    reviewGate,
    /On an\s+uncommitted range, the unchanged SHA the reviewed tree sits on, written\s+`<sha> — uncommitted`/u,
  );
  assert.match(
    reviewGate,
    /naming\s+the uncommitted corrections still in the working tree when the range was one/u,
  );
});

test("the gate commits its own corrections, never the user's work", () => {
  // The gate promises it changes only the working tree and the local history
  // its corrections require. An unconditional commit instruction over an
  // uncommitted-tree range would break exactly that promise.
  assert.match(reviewGate, /the uncommitted working tree, when nothing is committed yet/u);
  assert.match(
    reviewGate,
    /commit nothing the gate did not itself\s+produce — a `skip` grade over uncommitted work commits nothing at all/u,
  );
  assert.match(reviewGate, /reach a clean review\s+HEAD without pushing/u);
});

test("the transport doc can perform the pane reuse it mandates", () => {
  // The reuse rule survived an earlier edit that dropped the invocation
  // showing how, leaving an agent told to reuse a pane with only `start`
  // documented — so it opens a new pane per command instead.
  assert.match(processTransport, /Reuse its pane only for an already-planned/u);
  for (const flag of [/--target-pane "<pane_id>"/u, /--prior-receipt "/u, /--prior-token "/u]) {
    assert.match(processTransport, flag, `the reuse rule needs ${flag} documented`);
  }
  assert.match(processTransport, /the local backend has no\s+panes and rejects them/u);
});

test("the gate steps stay in order", () => {
  const steps = [
    "## 1. Grade",
    "## 2. Simplify",
    "## 3. Finalize the review HEAD",
    "## 4. Review Standards and Spec",
    "## 5. Correct material findings in one batch",
    "## 6. Write the receipt",
  ].map((heading) => reviewGate.indexOf(heading));
  assert.ok(steps.every((index) => index >= 0), "every gate step must exist");
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b));
  // Simplify must precede review so reviewers see the resulting diff.
  assert.match(reviewGate, /before review so reviewers see the resulting diff/u);
});
