import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const skill = readFileSync(join(here, "../SKILL.md"), "utf8");

test("every unit starts with one checkable contract", () => {
  const contract = skill.slice(
    skill.indexOf("Unit contract:"),
    skill.indexOf("Milestones: report each one"),
  );
  assert.ok(contract.length > 0, "the kickoff template must carry a unit contract");
  for (const field of ["Outcome:", "Write scope:", "Read-only scope:", "Verification:"]) {
    assert.match(contract, new RegExp(field), `unit contract needs ${field}`);
  }
  assert.match(contract, /Outcome: <one sentence naming the finished behavior>/u);
  assert.match(contract, /Read-only scope: <adjacent paths or surfaces this unit may inspect but not change>/u);
  assert.match(contract, /Verification: <commands and observable evidence that prove the outcome>/u);
});
