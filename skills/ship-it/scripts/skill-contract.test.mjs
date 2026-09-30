import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const skillDir = join(here, "..");
const shipIt = readFileSync(join(skillDir, "SKILL.md"), "utf8");
const openai = readFileSync(join(skillDir, "agents/openai.yaml"), "utf8");
const delivery = readFileSync(join(skillDir, "../orchestrate/references/delivery.md"), "utf8");

test("ship-it is user-invoked in every runtime", () => {
  assert.match(shipIt, /^name: ship-it$/mu);
  assert.match(shipIt, /^description: ".+"$/mu);
  assert.match(shipIt, /^disable-model-invocation: true$/mu);
  assert.match(openai, /^  allow_implicit_invocation: false$/mu);
});

test("every relative link resolves", () => {
  for (const [, target] of shipIt.matchAll(/\]\((?!https?:)([^)#]+)\)/gu)) {
    assert.ok(existsSync(join(skillDir, target)), `SKILL.md links to missing ${target}`);
  }
});

test("the delivery receipt carries the fields that orchestrate's delivery verifies", () => {
  for (const field of ["## Delivery gate", "Focused proof:", "Final validated HEAD:"]) {
    assert.ok(shipIt.includes(field), `delivery receipt is missing ${field}`);
    assert.ok(delivery.includes(field.replace(/:$/u, "")), `orchestrate delivery no longer checks ${field}`);
  }
});
