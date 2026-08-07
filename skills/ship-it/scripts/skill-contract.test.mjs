import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const shipIt = readFileSync(join(here, "../SKILL.md"), "utf8");
const orchestrate = readFileSync(
  join(here, "../../herdr-orchestrate/SKILL.md"),
  "utf8",
);
const models = readFileSync(
  join(here, "../../herdr-orchestrate/references/models.md"),
  "utf8",
);
const openai = readFileSync(join(here, "../agents/openai.yaml"), "utf8");
const processTransport = readFileSync(
  join(here, "../references/visible-herdr-runs.md"),
  "utf8",
);

test("ship-it stays manual-only across model runtimes", () => {
  assert.match(shipIt, /^description: "Manual-only /mu);
  assert.match(shipIt, /^disable-model-invocation: true$/mu);
  assert.match(openai, /^  allow_implicit_invocation: false$/mu);
  assert.match(
    orchestrate,
    /Because ship-it is manual-only, submit the runtime-native\s+explicit invocation through `send\.mjs @<temporary-file>`/u,
  );
  assert.match(
    orchestrate,
    /The `@<file>` form is mandatory for runtime-native skill invocations/u,
  );
  assert.match(orchestrate, /Claude lead → `\/ship-it Run the gate/u);
  assert.match(orchestrate, /Codex lead → `\$ship-it Run the gate/u);
});

test("ship-it keeps final validation after simplify and every review phase", () => {
  const steps = [
    "2. **Finish the implementation and proportional focused proof.**",
    "3. **Grade, then simplify**",
    "4. **Finalize the initial review HEAD.**",
    "5. **Review Standards and Spec**",
    "6. **Correct material findings in one batch.**",
    "7. **Validate the final HEAD, then push it.**",
  ].map((heading) => shipIt.indexOf(heading));

  assert.ok(steps.every((index) => index >= 0), "every gate step must exist");
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b));
  assert.match(
    shipIt.slice(steps[0], steps[1]),
    /every mapped local check passes, and each platform-delegated check\s+is explicit/u,
  );
  assert.match(
    shipIt.slice(steps[4], steps[5]),
    /reach a clean final\s+HEAD/u,
  );
  assert.match(
    orchestrate,
    /reserve ship-it's\s+proportional final-HEAD validation gate for its final push/u,
  );
});

test("final proof stays proportional and delegates native-platform coverage", () => {
  assert.match(
    shipIt,
    /A changed direct consumer is a path in the\s+final diff that imports, calls, builds against, or relies on the changed\s+contract/u,
  );
  assert.match(
    shipIt,
    /Treat path migrations as a focused branch: prove applicable old references\s+are gone, new paths resolve, moved artifacts preserve their invariants/u,
  );
  assert.match(
    shipIt,
    /When the local platform blocks a focused command, make one focused attempt/u,
  );
  assert.match(
    shipIt,
    /an unrelated passing suite does not compensate for missing\s+platform proof/u,
  );
  assert.match(
    shipIt,
    /run the complete local-CI entrypoint only when repository\s+instructions or branch policy name it as the delivery authority/u,
  );
  assert.doesNotMatch(shipIt, /or when no\s+native PR CI covers an applicable risk/u);
  assert.match(
    shipIt,
    /every native-CI delegation is named for step 9/u,
  );
  assert.match(
    shipIt,
    /Delegated checks are delivery-required even when branch protection does not\s+mark them required/u,
  );
  assert.match(
    shipIt,
    /Missing native\s+coverage for an applicable risk blocks delivery/u,
  );
  assert.doesNotMatch(shipIt, /step 7 owns the complete\s+repository local-CI gate/u);
});

test("review and simplify decisions are risk-adaptive and auditable", () => {
  assert.match(
    shipIt,
    /`skip` — a non-runtime change, or a mechanical low-risk runtime change/u,
  );
  assert.match(
    shipIt,
    /focused proof covers every\s+altered behavior\. It runs no simplify and no LLM review, proceeding only\s+through exact final-HEAD validation, required and delegated CI, PR receipt\s+verification, and live-review surfaces/u,
  );
  assert.match(
    shipIt,
    /`single` — a normal runtime change contained within one subsystem/u,
  );
  assert.match(
    shipIt,
    /`dual` — auth, permissions, security, payments, migrations, destructive\s+data, infrastructure, concurrency, public contracts, cross-service or\s+multi-subsystem changes/u,
  );
  assert.match(
    shipIt,
    /Any uncertainty about satisfying\s+`skip` promotes to `single`; any uncertainty about subsystem containment,\s+requirements, or blast radius promotes to `dual`/u,
  );
  assert.match(
    shipIt,
    /Staffing, implementing model, and use of a pair never choose the grade or\s+number of reviews/u,
  );
  assert.match(shipIt, /capacity changes execution, not\s+the semantic grade/u);
  assert.match(shipIt, /Name one concrete\s+structural target/u);
  assert.match(shipIt, /size alone is not a target/u);
  assert.match(shipIt, /Simplify is independent of reviewer count/u);
  assert.match(shipIt, /Reapply step 3's risk grade/u);
  assert.match(shipIt, /A `single` reviewer promotes the gate/u);
  assert.match(
    shipIt,
    /A `dual` review that cannot complete preserves its semantic\s+grade and records degraded execution/u,
  );
  assert.doesNotMatch(shipIt, /regrades to the other harness/u);
  assert.match(
    shipIt,
    /Leave a `## Delivery gate` receipt/u,
  );
  assert.match(
    shipIt,
    /`Risk:`.*`Focused\s+proof:`.*`Regrade:`/su,
  );
  assert.match(
    shipIt,
    /an ancestor of the\s+final HEAD whenever the gate found anything/u,
  );
  assert.match(
    shipIt,
    /Those three fields are the delivery's chain of custody[\s\S]*so a\s+corrected delivery is expected to carry two different HEADs/u,
  );
  assert.doesNotMatch(shipIt, /report that repository-contract blocker/u);
  assert.doesNotMatch(shipIt, /review:verify/u);
  assert.doesNotMatch(orchestrate, /review:verify/u);
  assert.match(
    models,
    /\[delivery gate\]\(\.\.\/\.\.\/ship-it\/SKILL\.md\)/u,
  );
  assert.match(
    models,
    /Name the\s+final grade\s+in the `shipped` milestone/u,
  );
  assert.match(
    models,
    /Name the\s+provisional grade\s+in the kickoff and the\s+phase 4 summary/u,
  );
  assert.doesNotMatch(models, /final grade in the phase 4 summary/u);
  assert.doesNotMatch(models, /`dual` \(default\)/u);
  assert.match(
    models,
    /Staffing, implementing model, pair use, and pool\s+selection never determine `skip`, `single`, `dual`, or the number of reviews/u,
  );
  assert.match(models, /the\s+semantic grade remains `dual`/u);
  assert.match(
    models,
    /Simplify is independent of staffing, model, pair use, and reviewer count/u,
  );
  assert.match(
    shipIt,
    /A user-requested simplify pass\s+overrides every one of those eligibility skips, at any grade including\s+`skip`/u,
  );
  assert.match(
    models,
    /An explicit user request overrides every eligibility skip at any grade,\s+including `skip`/u,
  );
  assert.doesNotMatch(models, /`skip` spends neither review pool and runs no simplify/u);
});

test("external gate commands select and record an honest transport", () => {
  assert.match(
    shipIt,
    /Every external command uses the transport helper, which selects a visible,\s+user-interruptible Herdr pane when the caller proof succeeds and otherwise\s+a local background process/u,
  );
  assert.match(shipIt, /completion receipt records the selected\s+transport/u);
  assert.doesNotMatch(shipIt, /blocked outside Herdr/u);
  assert.match(processTransport, /scripts\/run-transport\.mjs/u);
  assert.match(
    processTransport,
    /selects `herdr` only when\s+`HERDR_ENV=1` and the caller proof succeeds; otherwise it selects `local`/u,
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
  assert.match(
    shipIt,
    /For every external process, record `Transport: herdr\|local`/u,
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

test("Codex review selects the diff mechanically", () => {
  assert.match(
    shipIt,
    /`headless-codex\.mjs --base\s+origin\/<target-branch> "<axis prompt>"` wrapper/u,
  );
  assert.match(
    shipIt,
    /wrapper resolves the merge base before starting the\s+review, pins that range in the prompt, and records the resolved SHA in\s+its receipt/u,
  );
  assert.match(
    shipIt,
    /`codex exec` with a freeform prompt does not\s+satisfy this\s+gate/u,
  );
  assert.doesNotMatch(
    shipIt,
    /git diff "\$\(git merge-base HEAD origin\/<target-branch>\)"/u,
  );
  assert.match(
    shipIt,
    /Name the assigned axis in the wrapper prompt, include its applicable\s+sources, and require read-only findings output/u,
  );
});
