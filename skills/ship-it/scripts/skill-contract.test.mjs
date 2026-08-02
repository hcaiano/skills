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

test("ship-it keeps final CI after simplify and every review phase", () => {
  const steps = [
    "2. **Finish the implementation and focused proof.**",
    "3. **Grade, then simplify**",
    "4. **Finalize the review HEAD.**",
    "5. **Review Standards and Spec**",
    "6. **Correct once and re-review once.**",
    "7. **Run final CI, then push the reviewed HEAD.**",
  ].map((heading) => shipIt.indexOf(heading));

  assert.ok(steps.every((index) => index >= 0), "every gate step must exist");
  assert.deepEqual(steps, [...steps].sort((a, b) => a - b));
  assert.match(
    shipIt.slice(steps[0], steps[1]),
    /complete repository CI first runs\s+in step 7 on the clean, reviewed final HEAD/u,
  );
  assert.match(
    shipIt.slice(steps[5], steps[5] + 600),
    /complete repository CI\s+starts here, after simplify, initial review, correction, and re-review/u,
  );
  assert.match(
    orchestrate,
    /reserve the complete\s+local-CI gate for ship-it's final push/u,
  );
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
  assert.doesNotMatch(models, /`dual` \(default\)/u);
});
