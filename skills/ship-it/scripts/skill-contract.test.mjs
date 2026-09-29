import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const skillDir = join(here, "..");
const shipIt = readFileSync(join(skillDir, "SKILL.md"), "utf8");
const openai = readFileSync(join(skillDir, "agents/openai.yaml"), "utf8");
const delivery = readFileSync(join(skillDir, "../orchestrate/references/delivery.md"), "utf8");

test("ship-it stays manual-only across model runtimes", () => {
  assert.match(shipIt, /^name: ship-it$/mu);
  assert.match(shipIt, /^description: "Manual-only /mu);
  assert.match(shipIt, /^disable-model-invocation: true$/mu);
  assert.match(openai, /^  allow_implicit_invocation: false$/mu);
});

test("every relative link resolves", () => {
  for (const [, target] of shipIt.matchAll(/\]\((?!https?:)([^)#]+)\)/gu)) {
    assert.ok(existsSync(join(skillDir, target)), `SKILL.md links to missing ${target}`);
  }
});

test("ship-it delegates review to review-it instead of copying it", () => {
  assert.match(shipIt, /\[review-it\]\(\.\.\/review-it\/SKILL\.md\)/u);
  for (const gateDetail of [/headless-(claude|codex|cursor)\.mjs/u, /run-transport\.mjs/u, /review-brief\.md/u]) {
    assert.doesNotMatch(shipIt, gateDetail, `review-it detail leaked into ship-it: ${gateDetail}`);
  }
});

test("the delivery receipt carries the fields that orchestrate's delivery verifies", () => {
  for (const field of ["## Delivery gate", "Focused proof:", "Final validated HEAD:"]) {
    assert.ok(shipIt.includes(field), `delivery receipt is missing ${field}`);
    assert.ok(delivery.includes(field.replace(/:$/u, "")), `orchestrate delivery no longer checks ${field}`);
  }
});
