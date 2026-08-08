import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const skill = readFileSync(join(here, "../SKILL.md"), "utf8");

test("a deliberate broken checkout is visible to both partners", () => {
  assert.match(
    skill,
    /Give every deliberate broken-checkout experiment a visible window[\s\S]*send a `task` naming its\s+affected paths and stop condition, then wait for `accepted`[\s\S]*After clean\s+restoration, send `ready` and wait for `accepted` before the partner reads\s+or tests that checkout/u,
  );
  assert.match(
    skill,
    /Run an experiment that cannot hold that window in a\s+separate worktree/u,
  );
});

test("facts get proof before judgment reaches stalemate", () => {
  assert.match(
    skill,
    /Settle a factual disagreement with one direct proof or\s+focused test before it can become a stalemate/u,
  );
  assert.match(skill, /same\s+judgment call repeats twice without movement/u);
});

test("the user handoff reports the live resources", () => {
  assert.match(
    skill,
    /local handoff naming the result, verification evidence, unresolved issues, and\s+every pair pane, worktree, or watcher still active/u,
  );
});
