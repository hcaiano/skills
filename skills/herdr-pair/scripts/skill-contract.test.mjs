import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const skill = readFileSync(join(here, "../SKILL.md"), "utf8");

test("a deliberate broken checkout is visible to both partners", () => {
  assert.match(
    skill,
    /Announce every deliberate broken-checkout window[\s\S]*send a `task` naming the affected paths and\s+stop condition; send `ready` after the tree is restored and verified/u,
  );
  assert.match(
    skill,
    /Do not\s+wait for `accepted`: the notices are the protection/u,
  );
  assert.match(
    skill,
    /open window treats that checkout's test results as unusable until the\s+close notice arrives, and asks rather than reports/u,
  );
  assert.match(
    skill,
    /cannot be announced, or that lasts more than a few minutes, in a separate\s+worktree/u,
  );
});

test("busy and idle partners keep distinct delivery proofs", () => {
  assert.match(
    skill,
    /Measured on Herdr 0\.8\.0[\s\S]*multi-line prompt to Codex still needs Enter[\s\S]*partner is still working,[\s\S]*sends exactly one `agent prompt`[\s\S]*runs the harmless Enter loop[\s\S]*skips the visible-arrival check and\s+the full resend/u,
  );
  assert.match(
    skill,
    /receipt=unproven-working-inspect-that-pane-then-reconcile[\s\S]*cannot distinguish a queued prompt from a silent\s+drop/u,
  );
  assert.match(
    skill,
    /For an idle partner, the helper proves landing from the composer[\s\S]*sends Enter until the composer releases the\s+text, performs one full resend, and fails loudly/u,
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
