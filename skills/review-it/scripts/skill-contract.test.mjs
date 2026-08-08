import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const reviewIt = readFileSync(join(here, "../SKILL.md"), "utf8");
const processTransport = readFileSync(
  join(here, "../references/visible-herdr-runs.md"),
  "utf8",
);
const openai = readFileSync(join(here, "../agents/openai.yaml"), "utf8");

test("review-it stays manual-only across model runtimes", () => {
  assert.match(reviewIt, /^description: "Manual-only /mu);
  assert.match(reviewIt, /^disable-model-invocation: true$/mu);
  assert.match(openai, /^  allow_implicit_invocation: false$/mu);
});

test("the skill is named review-it, and only the identifier was renamed", () => {
  // The identifier is what a user types and what ship-it links to. "review
  // gate" as domain prose — the receipt heading, `Gate HEAD`, the thing this
  // skill *is* — is a separate contract and deliberately survives.
  assert.match(reviewIt, /^name: review-it$/mu);
  assert.match(reviewIt, /the user explicitly names review-it/u);
  assert.match(reviewIt, /Run it only when the user invokes review-it or/u);
  assert.match(openai, /\$review-it to grade, simplify, and review/u);
  assert.match(openai, /display_name: "Review It"/u);
  for (const [label, text] of [["SKILL.md", reviewIt], ["the transport doc", processTransport], ["openai.yaml", openai]]) {
    assert.doesNotMatch(text, /review-gate/u, `the old identifier survives in ${label}`);
  }
  assert.match(reviewIt, /Leave a `## Review gate` receipt/u, "the receipt heading is a contract, not the skill name");
  assert.match(processTransport, /--label "review-it · /u);
});

test("every script path the docs name exists after the move", () => {
  // A rename that leaves the prose pointing at the old directory fails here
  // rather than at the first real gate run.
  const named = new Set(
    [...`${reviewIt}\n${processTransport}`.matchAll(/(?:<skill dir>\/|this skill's `)?scripts\/([a-z-]+\.mjs)/gu)]
      .map((m) => m[1])
      // usage-state.mjs is herdr-orchestrate's, read from a sibling install.
      // Excluding it here is the boundary: this gate ships no capacity helper,
      // which is why a missing one has its own recorded behaviour.
      .filter((script) => script !== "usage-state.mjs"),
  );
  assert.ok(named.size >= 3, "the docs must still name their wrapper scripts");
  for (const script of named) {
    assert.ok(
      existsSync(join(here, script)),
      `the docs name scripts/${script}, which does not exist in this skill`,
    );
  }
  assert.equal(
    existsSync(join(here, "usage-state.mjs")),
    false,
    "the capacity helper belongs to herdr-orchestrate and must not be vendored here",
  );
});

test("the gate never delivers — that restraint is what makes it reusable", () => {
  assert.match(
    reviewIt,
    /never pushes, opens or updates a PR, waits on CI, merges,\s+or deploys/u,
  );
  assert.match(
    reviewIt,
    /safe to run against a branch whose PR already\s+exists/u,
  );
  assert.match(reviewIt, /reach a clean review\s+HEAD without pushing/u);
  assert.match(
    reviewIt,
    /Say plainly that\s+nothing was pushed and no PR was touched/u,
  );
});

test("the range is resolved once, from a fetched base", () => {
  assert.match(
    reviewIt,
    /a stale local target reviews another PR's commits/u,
  );
  assert.match(reviewIt, /an explicit commit, when re-reviewing one landed change/u);
  assert.match(reviewIt, /the uncommitted working tree, when nothing is committed yet/u);
  assert.match(reviewIt, /A gate over\s+an unproven range reviews a moving target/u);
});

test("grading is risk-adaptive and auditable", () => {
  assert.match(
    reviewIt,
    /`skip` — a non-runtime change, or a mechanical low-risk runtime change/u,
  );
  assert.match(reviewIt, /It runs no simplify and no LLM review/u);
  assert.match(
    reviewIt,
    /`single` — a normal runtime change contained within one subsystem/u,
  );
  assert.match(
    reviewIt,
    /`dual` — auth, permissions, security, payments, migrations, destructive data,\s+infrastructure, concurrency, public contracts, cross-service or\s+multi-subsystem changes/u,
  );
  assert.match(
    reviewIt,
    /Any uncertainty about satisfying `skip` promotes to `single`; any\s+uncertainty about subsystem containment, requirements, or blast radius promotes\s+to `dual`/u,
  );
  assert.match(
    reviewIt,
    /Staffing, implementing model, and use of a pair never choose the grade or number\s+of reviews/u,
  );
  assert.match(reviewIt, /capacity changes execution,\s+not the semantic grade/u);
  assert.doesNotMatch(reviewIt, /regrades to the other harness/u);
});

test("simplify keeps its named target and its user override", () => {
  assert.match(reviewIt, /Name one concrete structural target/u);
  assert.match(reviewIt, /size alone is not a target/u);
  assert.match(reviewIt, /Simplify is independent of reviewer count/u);
  assert.match(
    reviewIt,
    /A user-requested simplify pass overrides every one of those eligibility\s+skips, at any grade including `skip`/u,
  );
  assert.match(reviewIt, /A failed or aborted\s+attempt is not success/u);
  assert.match(reviewIt, /Reapply step 1's risk grade/u);
});

test("review promotion and degradation survive", () => {
  assert.match(reviewIt, /A `single` reviewer promotes the gate/u);
  assert.match(
    reviewIt,
    /A `dual` review that cannot complete preserves its semantic grade\s+and records degraded execution/u,
  );
  assert.match(
    reviewIt,
    /Two reviews from the same harness do not satisfy\s+`dual`/u,
  );
  assert.match(
    reviewIt,
    /a refusal, rate-limit notice, or empty payload is\s+a failed review even with exit zero/u,
  );
  assert.match(reviewIt, /Fable is advisor-only/u);
});

test("Codex review selects the diff mechanically", () => {
  assert.match(
    reviewIt,
    /`node <skill dir>\/scripts\/headless-codex\.mjs "<axis prompt>" --base\s+origin\/<target-branch>` wrapper/u,
  );
  assert.match(
    reviewIt,
    /wrapper resolves\s+the merge base before the review starts, pins that range in the prompt, and\s+records the resolved SHA in its receipt/u,
  );
  assert.match(
    reviewIt,
    /the reviewed range is a fact\s+rather than an instruction the model may skip/u,
  );
  assert.match(
    reviewIt,
    /`codex exec`\s+with a freeform prompt does not satisfy this gate/u,
  );
  assert.doesNotMatch(
    reviewIt,
    /git diff "\$\(git merge-base HEAD origin\/<target-branch>\)"/u,
  );
  assert.match(
    reviewIt,
    /Name\s+the assigned axis in the reviewer's prompt, include its applicable sources, and\s+require read-only findings output/u,
  );
});

test("external gate commands select and record an honest transport", () => {
  assert.match(
    reviewIt,
    /records whether it ran in a\s+visible Herdr pane or as a local background process/u,
  );
  assert.doesNotMatch(reviewIt, /blocked outside Herdr/u);
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
  assert.match(reviewIt, /Leave a `## Review gate` receipt/u);
  assert.match(
    reviewIt,
    /A caller that delivers this change embeds the\s+block verbatim rather than restating it/u,
  );
  for (const field of ["Gate:", "Risk:", "Regrade:", "Simplify:", "Reviewed HEAD:", "Gate HEAD:"]) {
    assert.match(reviewIt, new RegExp(`\`${field}\``, "u"), `receipt must define ${field}`);
  }
  assert.match(
    reviewIt,
    /an ancestor of the\s+final HEAD whenever the gate found anything/u,
  );
  assert.match(
    reviewIt,
    /`Reviewed HEAD` and `Gate HEAD` are the gate's chain of custody[\s\S]*so a corrected gate is expected to carry\s+two different HEADs/u,
  );
  // Delivery fields belong to the caller; restating them here would fork the
  // single source of truth for what ships.
  assert.doesNotMatch(reviewIt, /Final validated HEAD:/u);
});

test("the extracted gate stands on its own", () => {
  // Naming ship-it as a known caller is correct and stays. What must not
  // survive the extraction is the gate resolving paths relative to a skill its
  // caller may never have invoked, or deferring to rules it now owns itself —
  // a standalone install has no ship-it to look beside or defer to.
  assert.match(reviewIt, /or ship-it delegates its graded\s+gate/u);
  assert.doesNotMatch(processTransport, /beside ship-it/u);
  assert.doesNotMatch(processTransport, /ship-it's content rules/u);
  assert.doesNotMatch(processTransport, /every ship-it simplify/u);
  // herdr-orchestrate finds this gate's panes by this exact label. A pane
  // labelled for ship-it is read there as a delivery in progress, which a
  // standalone or orchestrator-invoked gate run is not.
  assert.match(processTransport, /--label "review-it · /u);
  assert.doesNotMatch(processTransport, /--label "ship-it · /u);

  // Both sibling skills are dependencies, not bundles. Absence must have a
  // defined outcome, or a standalone install has no runnable path.
  assert.match(
    reviewIt,
    /pool state unread \(usage-state\.mjs not installed\)[\s\S]*leaves\s+the semantic grade, the reviewer count, and simplify exactly as graded/u,
  );
  // The two environments resolve a missing herdr-pair differently, because
  // run-transport.mjs hard-stops an incomplete pin under HERDR_ENV=1 rather
  // than demoting a hosted run to an invisible one. A single "falls back to
  // local" rule would promise a run that cannot start.
  assert.match(
    reviewIt,
    /Outside `HERDR_ENV=1` the\s+transport selects `local`/u,
  );
  assert.match(
    reviewIt,
    /Inside `HERDR_ENV=1` a missing\s+proof stops the gate/u,
  );
});

test("the gate's end state matches the range it was given", () => {
  // An uncommitted range cannot reach a clean committed HEAD without
  // committing work the gate never touched, so steps 5, 6 and Report each
  // carry the branch/uncommitted split — not step 3 alone.
  assert.match(
    reviewIt,
    /on a branch range,\s+commit all corrections and reach a clean final HEAD; on an uncommitted range,\s+leave the corrections in the working tree/u,
  );
  assert.match(reviewIt, /the gate's end state matches its range/u);
  assert.match(
    reviewIt,
    /On an\s+uncommitted range, the unchanged SHA the reviewed tree sits on, written\s+`<sha> — uncommitted`/u,
  );
  assert.match(
    reviewIt,
    /naming\s+the uncommitted corrections still in the working tree when the range was one/u,
  );
});

test("the gate commits its own corrections, never the user's work", () => {
  // The gate promises it changes only the working tree and the local history
  // its corrections require. An unconditional commit instruction over an
  // uncommitted-tree range would break exactly that promise.
  assert.match(reviewIt, /the uncommitted working tree, when nothing is committed yet/u);
  assert.match(
    reviewIt,
    /commit nothing the gate did not itself\s+produce — a `skip` grade over uncommitted work commits nothing at all/u,
  );
  assert.match(reviewIt, /reach a clean review\s+HEAD without pushing/u);
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
  ].map((heading) => reviewIt.indexOf(heading));
  assert.ok(steps.every((index) => index >= 0), "every gate step must exist");
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b));
  // Simplify must precede review so reviewers see the resulting diff.
  assert.match(reviewIt, /before review so reviewers see the resulting diff/u);
});
