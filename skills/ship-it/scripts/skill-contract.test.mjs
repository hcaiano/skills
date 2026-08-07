import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const shipIt = readFileSync(join(here, "../SKILL.md"), "utf8");
const reviewGate = readFileSync(join(here, "../../review-gate/SKILL.md"), "utf8");
const orchestrate = readFileSync(
  join(here, "../../herdr-orchestrate/SKILL.md"),
  "utf8",
);
const models = readFileSync(
  join(here, "../../herdr-orchestrate/references/models.md"),
  "utf8",
);
const openai = readFileSync(join(here, "../agents/openai.yaml"), "utf8");

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

test("ship-it delegates the graded gate instead of reimplementing it", () => {
  assert.match(shipIt, /\[review gate\]\(\.\.\/review-gate\/SKILL\.md\)/u);
  assert.match(
    shipIt,
    /Read and execute\s+\[review-gate\]\(\.\.\/review-gate\/SKILL\.md\) over the focused-proven diff/u,
  );
  assert.match(
    shipIt,
    /this skill\s+never regrades its result, reruns its reviews, or substitutes its own\s+reading of the diff for them/u,
  );
  assert.match(shipIt, /A gate that stops for user direction stops the\s+delivery too/u);
  // The gate's own rules must live in exactly one place. If any of these come
  // back to ship-it, the extraction has started to grow a second copy.
  for (const gateRule of [
    /Name one concrete structural target/u,
    /size alone is not a target/u,
    /Simplify is independent of reviewer count/u,
    /A `single` reviewer promotes the gate/u,
    /Two reviews from the same harness do not satisfy/u,
    /`dual` — auth, permissions, security/u,
    /headless-claude\.mjs/u,
    /headless-codex\.mjs/u,
    /run-transport\.mjs/u,
  ]) {
    assert.doesNotMatch(shipIt, gateRule, `gate rule leaked back into ship-it: ${gateRule}`);
  }
});

test("ship-it keeps final validation after the gate", () => {
  const steps = [
    "2. **Finish the implementation and proportional focused proof.**",
    "3. **Run the graded review gate.**",
    "4. **Validate the final HEAD, then push it.**",
    "5. **Open or update the PR and verify its receipt.**",
  ].map((heading) => shipIt.indexOf(heading));

  assert.ok(steps.every((index) => index >= 0), "every delivery step must exist");
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b));
  assert.match(
    shipIt.slice(steps[0], steps[1]),
    /every mapped local check passes, and each platform-delegated check\s+is explicit/u,
  );
  // Validation runs on the head that ships, after the gate — never before it.
  assert.match(
    shipIt.slice(steps[2], steps[3]),
    /On the clean final HEAD, rerun\s+step 2's proportional validation map/u,
  );
  assert.match(
    orchestrate,
    /reserve ship-it's\s+proportional final-HEAD validation gate for its final push/u,
  );
});

test("every step cross-reference resolves after the renumbering", () => {
  const headings = [...shipIt.matchAll(/^(\d+)\. /gmu)].map((match) => Number(match[1]));
  assert.deepEqual(headings, [1, 2, 3, 4, 5, 6, 7, 8]);
  const highest = Math.max(...headings);
  for (const match of shipIt.matchAll(/steps? (\d+)(?:[–-](\d+))?/gu)) {
    for (const referenced of [match[1], match[2]].filter(Boolean).map(Number)) {
      assert.ok(
        referenced >= 1 && referenced <= highest,
        `ship-it references step ${referenced}, which does not exist`,
      );
    }
  }
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
    /every native-CI delegation is named for step 6/u,
  );
  assert.match(
    shipIt,
    /Delegated checks are delivery-required even when branch protection does not\s+mark them required/u,
  );
  assert.match(
    shipIt,
    /Missing\s+native coverage for an applicable risk blocks delivery/u,
  );
  assert.doesNotMatch(shipIt, /step 7 owns the complete\s+repository local-CI gate/u);
});

test("the receipt embeds the gate's block and adds only delivery's own fields", () => {
  assert.match(shipIt, /Leave a `## Delivery gate` receipt/u);
  assert.match(
    shipIt,
    /It embeds the gate's\s+`## Review gate` block verbatim/u,
  );
  assert.match(shipIt, /`Focused proof:`/u);
  assert.match(shipIt, /`Final validated HEAD: <40-character pushed SHA>`/u);
  assert.match(
    shipIt,
    /`Reviewed HEAD`, `Gate HEAD`, and `Final validated HEAD` are the delivery's\s+chain of custody/u,
  );
  assert.match(
    shipIt,
    /reviewed at this ancestor, fixed in these SHAs, validated\s+on the head that ships/u,
  );
  // The gate defines these; ship-it must not fork them.
  assert.doesNotMatch(shipIt, /`Regrade:` \(/u);
  assert.doesNotMatch(shipIt, /`Simplify:`\s*\n?\s*\(`applied in/u);
  assert.match(reviewGate, /Leave a `## Review gate` receipt/u);
  assert.doesNotMatch(shipIt, /review:verify/u);
  assert.doesNotMatch(orchestrate, /review:verify/u);
});

test("herdr-orchestrate points grading at the gate and delivery at ship-it", () => {
  assert.match(models, /\[review gate\]\(\.\.\/\.\.\/review-gate\/SKILL\.md\)/u);
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
    models,
    /An explicit user request overrides every eligibility skip at any grade,\s+including `skip`/u,
  );
  assert.doesNotMatch(models, /`skip` spends neither review pool and runs no simplify/u);
});
