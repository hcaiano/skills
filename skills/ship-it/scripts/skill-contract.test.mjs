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
  assert.match(shipIt, /`single` — the default for a runtime change/u);
  assert.match(shipIt, /Uncertainty selects `dual`/u);
  assert.match(shipIt, /Name one concrete\s+structural target/u);
  assert.match(shipIt, /size alone is not a target/u);
  assert.match(shipIt, /Reapply step 3's risk grade/u);
  assert.match(shipIt, /A `single` reviewer promotes the gate/u);
  assert.match(
    shipIt,
    /`skip — <reason>` \/ `single — <reviewer>; <reason>` \/ `dual`/u,
  );
  assert.match(
    models,
    /\[risk-adaptive gate\]\(\.\.\/\.\.\/ship-it\/SKILL\.md\)/u,
  );
  assert.match(
    models,
    /Name the final grade in the `shipped` milestone/u,
  );
  assert.match(
    models,
    /Name the provisional grade in the kickoff and the\s+phase 4 summary/u,
  );
  assert.doesNotMatch(models, /final grade in the phase 4 summary/u);
  assert.doesNotMatch(models, /`dual` \(default\)/u);
});
