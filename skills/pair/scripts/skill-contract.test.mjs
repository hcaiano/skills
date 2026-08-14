import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const here = new URL(".", import.meta.url).pathname;
const read = (path) => readFileSync(join(here, path), "utf8");
const skill = read("../SKILL.md");
const herdrBackend = read("../references/herdr.md");
const headlessBackend = read("../references/headless.md");
const helper = read("herdr-pair.mjs");
const headlessHelper = read("pair-headless.mjs");

const receiptTokens = (text) =>
  [...new Set([...text.matchAll(/receipt=([a-z][a-z-]+)/gu)].map((match) => match[1]))].sort();

test("the skill routes to exactly one backend", () => {
  assert.match(skill, /^name: pair$/mu);
  assert.match(skill, /`HERDR_ENV=1` → \[Herdr backend\]\(references\/herdr\.md\)/u);
  // A Herdr environment missing the CLI must stop in herdr.md's preconditions,
  // never fall through to a hidden headless session.
  assert.match(skill, /stops there\s+instead of falling through to a hidden headless session/u);
  assert.match(skill, /Otherwise → \[Headless backend\]\(references\/headless\.md\)/u);
  assert.match(
    skill,
    /An inbound `\[agent \.\.\.\]` or `\[herdr-pair control \.\.\.\]` line always means the\s+Herdr backend/u,
  );
});

test("the description carries every trigger", () => {
  const description = skill.match(/^description: "(.+)"$/mu)[1];
  for (const trigger of [
    /live peer work/u,
    /workflows requesting a pair/u,
    /`\[agent \.\.\.\]` \/ `\[herdr-pair control \.\.\.\]` line/u,
    /after context compaction/u,
    /when Herdr is absent/u,
  ]) {
    assert.match(description, trigger);
  }
});

test("protocol, kinds, and write leases stay backend-neutral", () => {
  assert.match(skill, /\[agent <from> -> <to> kind=<kind> sid=<sid>\]/u);
  for (const kind of ["task", "review", "question", "ready", "accepted", "blocked", "stalemate", "handoff"]) {
    assert.match(skill, new RegExp(`^- \`${kind}\`:`, "mu"));
  }
  assert.match(
    skill,
    /one agent the write lease for each file scope: owner, target files,\s+forbidden changes, validation, and stop point\. The partner stays read-only on\s+that scope until handoff/u,
  );
});

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
    herdrBackend,
    /Measured on Herdr 0\.8\.0[\s\S]*multi-line prompt to Codex still needs Enter[\s\S]*partner is still working,[\s\S]*sends exactly one `agent prompt`[\s\S]*runs the harmless Enter loop[\s\S]*skips the visible-arrival check and\s+the full resend/u,
  );
  assert.match(
    herdrBackend,
    /receipt=unproven-working-inspect-that-pane-then-reconcile[\s\S]*cannot distinguish a queued prompt from a silent\s+drop/u,
  );
  assert.match(
    herdrBackend,
    /For an idle partner, the helper proves landing from the composer[\s\S]*sends Enter until the composer releases the\s+text, performs one full resend, and fails loudly/u,
  );
});

test("code and prose expose the same delivery receipts", () => {
  const codeReceipts = receiptTokens(helper);
  const documentedReceipts = receiptTokens(herdrBackend);
  assert.ok(codeReceipts.length >= 4, "the helper must expose every delivery outcome as a receipt token");
  assert.deepEqual(documentedReceipts, codeReceipts);
});

test("the Herdr backend keeps its pane mechanics and its own pointers", () => {
  for (const mechanic of [
    /\[Caller pane proof\]\(caller-pane-resolution\.md\)/u,
    /\[`workbench-tab\.md`\]\(workbench-tab\.md\)/u,
    /scripts\/herdr-pair\.mjs/u,
    /node "\$PAIR_SCRIPT" discover/u,
    /node "\$PAIR_SCRIPT" init/u,
    /--clear-pending true/u,
    /--stale true/u,
  ]) {
    assert.match(herdrBackend, mechanic);
  }
});

test("the headless backend documents every send status the helper emits", () => {
  const documented = [...new Set([...headlessBackend.matchAll(/`status=([a-z-]+)`/gu)].map((m) => m[1]))].sort();
  assert.deepEqual(documented, ["empty-reply", "failed", "hang-killed", "replied"]);
  for (const status of documented) {
    assert.match(headlessHelper, new RegExp(`status: "${status}"`, "u"));
  }
});

test("the headless backend documents the helper's whole command surface", () => {
  for (const command of ["init", "send", "status", "clear", "end"]) {
    assert.match(headlessBackend, new RegExp(`\\$PAIR_SCRIPT" ${command} --repo`, "u"));
    assert.match(headlessHelper, new RegExp(`${command}: run`, "u"));
  }
  assert.match(headlessBackend, /scripts\/pair-headless\.mjs/u);
  assert.match(headlessBackend, /half-duplex/u);
  assert.match(headlessBackend, /`<git-dir>\/pair\/session\.json`/u);
  assert.match(headlessBackend, /refuses to pair a\s+model with itself/u);
});

test("the headless backend states what each guarantee is actually worth", () => {
  // One pair per worktree, not per repository: the state lives in the
  // worktree's git dir, so a linked worktree carries its own.
  assert.match(headlessBackend, /a worktree holds one pair and a linked\s+worktree gets its own/u);
  // A permission mode is not an OS sandbox, and the reader must not read it as one.
  assert.match(
    headlessBackend,
    /Codex turn is held by a\s+filesystem sandbox[\s\S]*Claude turn is held by a permission mode[\s\S]*without being an OS sandbox/u,
  );
  // An empty reply may still have consumed the prompt, so resending can duplicate work.
  assert.match(
    headlessBackend,
    /`status=empty-reply`[\s\S]*Read\s+`transcript` first[\s\S]*may have consumed the prompt[\s\S]*inspect `git status` before resending/u,
  );
  // session_known is evidence of loss, never proof of health.
  assert.match(
    headlessBackend,
    /`session_known` reports a positive absence only[\s\S]*never proof of health/u,
  );
  // The lock is a file, and the prose has to name the file the reader will find
  // and the one command that removes it — a send never removes one itself.
  assert.match(
    headlessBackend,
    /takes a lock\s+by creating `<git-dir>\/pair\/in-flight\.json`[\s\S]*refuses over any existing marker/u,
  );
  assert.match(headlessBackend, /`clear` refuses while any recorded process is alive/u);
  assert.match(headlessHelper, /join\(stateDir, "in-flight\.json"\)/u);
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
