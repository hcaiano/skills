import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const skill = readFileSync(join(here, "../SKILL.md"), "utf8");
const staffing = readFileSync(join(here, "../references/staffing.md"), "utf8");
const delivery = readFileSync(join(here, "../references/delivery.md"), "utf8");
const unit = readFileSync(join(here, "unit.mjs"), "utf8");

test("orchestrate is manual-only and supports recorded pair backends", () => {
  assert.match(skill, /^name: orchestrate$/mu);
  assert.match(skill, /^disable-model-invocation: true$/mu);
  assert.match(skill, /--backend headless\|herdr/u);
  assert.match(unit, /HERDR_ENV/u);
  assert.match(unit, /backend: "herdr"/u);
});

test("one durable record owns the complete unit atom", () => {
  assert.match(skill, /one\s+worktree, branch, pair backend, and pull request/u);
  assert.match(skill, /<git-common-dir>\/orchestrate\/units\/<unit-id>\.json/u);
  assert.match(unit, /git-common-dir/u);
  assert.match(unit, /lifecycle: "creating"/u);
  assert.match(unit, /partner arena must differ from the orchestrator harness/u);
  assert.match(skill, /orchestrator session must run rooted in `REPO`/u);
  assert.match(skill, /caller\s+pane proof binds the live lead process to that repository/u);
  assert.match(skill, /manifest-owned task file is authoritative/u);
  assert.match(skill, /resumes `creating`, `setting-up`,\s+`initializing-pair`, or `starting`/u);
  assert.match(skill, /recoverable Cursor record that stores a separate effort/u);
  assert.match(skill, /## Addendum — <UTC timestamp>/u);
  assert.match(skill, /executor rereads the complete file[^]*again after every restaff/u);
  assert.match(unit, /resumed_from/u);
});

test("unit creation protects the PR body handoff", () => {
  assert.match(skill, /adds `\/PR_BODY\.md` once to the repository's Git\s+exclude file/u);
  assert.match(unit, /"rev-parse", "--git-path", "info\/exclude"/u);
  assert.match(unit, /const pattern = "\/PR_BODY\.md"/u);
  assert.match(unit, /delivery_setup\.pr_body_exclude/u);
});

test("the unit helper exposes one tested lifecycle surface", () => {
  for (const command of ["create", "list", "status", "restaff", "dismantle"]) {
    assert.match(skill, new RegExp(`node "\\$UNIT" ${command}`, "u"));
    assert.match(unit, new RegExp(`command === "${command}"`, "u"));
  }
  assert.ok(existsSync(join(here, "unit.mjs")));
  assert.ok(existsSync(join(here, "usage-state.mjs")));
  assert.equal(existsSync(join(here, "send.mjs")), false);
});

test("pair is the only unit transport", () => {
  assert.match(skill, /pair receipts and transcripts are the only transport/iu);
  assert.match(skill, /pair-headless\.mjs/u);
  assert.match(skill, /reconciles its sequence ACKs/u);
  assert.match(skill, /--background/u);
  assert.match(skill, /--timeout-min 1/u);
  assert.doesNotMatch(skill, /report_pane|pane tokens|orphan adoption/u);
});

test("staffing matches difficulty and records its evidence", () => {
  assert.match(staffing, /Match model intelligence to task difficulty/u);
  assert.match(staffing, /models\.md[\s\S]*owns the model-choice rubric and\s+the Roster subsections Seats por papel, Dimension scores, Pace and fallback,\s+and Effort/u);
  assert.match(staffing, /This file owns arena\s+floors, capacity evidence, and the\s+orchestration\s+decision record/u);
  assert.match(staffing, /Apply the roster before these\s+arena floors/u);
  assert.match(staffing, /Roster's Seats por papel and Effort subsections/u);
  assert.match(staffing, /use its Taste score/u);
  assert.match(staffing, /pool headroom first and speed second/u);
  assert.match(staffing, /current\s+orchestrator\s+CLI\s+is\s+not\s+a legal partner/iu);
  assert.match(staffing, /Claude \| `claude-opus-5` for UI\/design units; general\/back-end units prefer the Codex or Grok arenas per the Roster \| `claude-opus-5` for UI\/design units; general\/back-end units prefer the Codex or Grok arenas per the Roster[\s\S]*`claude-fable-5`[\s\S]*it plans, it does not run units/u);
  assert.match(staffing, /Codex \| `gpt-5\.6-sol` \| `gpt-5\.6-sol`[\s\S]*`gpt-5\.6-luna`[\s\S]*legal only for a volume or mechanical unit with Sol-reviewed delivery, otherwise excluded/u);
  for (const arena of ["Cursor", "Grok", "OpenCode"]) {
    assert.match(staffing, new RegExp(`\\| ${arena} \\| a current Roster seat with evidence for the task`, "u"));
  }
  assert.doesNotMatch(staffing, /haiku|terra|sonnet/iu);
  assert.match(staffing, /floor table restricts orchestration roles[\s\S]*does not create another\s+roster/u);
  assert.match(staffing, /one-line reason/u);
  assert.match(staffing, /compared roster Taste scores when a score breaks the tie/u);
  assert.doesNotMatch(staffing, /Quality evidence|x-preview-f-free|SWE-Pro|AA Coding Agent Index/u);
  assert.match(
    staffing,
    /headless `cursor-agent` run proves that shell commands are\s+rejected[^]*consult and read-only review arena/u,
  );
  assert.match(staffing, /Cursor pane on the Herdr backend keeps its own permission plumbing/u);
  assert.doesNotMatch(staffing, /frontier by default|least expensive/u);
});

test("restaff preserves evidence and normal feedback stays bounded", () => {
  assert.match(skill, /checkpoints the HEAD, worktree status and\s+diff, and newest receipt or Herdr ACK state/u);
  assert.match(skill, /Normal scope\s+feedback and one bounded correction stay on the current pair/u);
  assert.match(skill, /matching retry resumes\s+`restaffing` or `restaff-failed`/u);
  assert.match(unit, /staffing\.history\.push/u);
  assert.match(unit, /pending_staffing/u);
});

test("delivery keeps the exact-head chain of custody", () => {
  assert.match(delivery, /scope-approved SHA/u);
  assert.match(delivery, /`Final validated HEAD` equals the exact PR head/u);
  for (const field of ["Gate:", "Risk:", "Regrade:", "Focused proof:"]) {
    assert.match(delivery, new RegExp(field, "u"));
  }
  assert.match(delivery, /reviews, issue comments, inline comments, and review\s+threads/u);
  assert.match(delivery, /--match-head-commit <verified-head>/u);
  assert.match(delivery, /before and\s+after screenshots/u);
  assert.match(delivery, /merged, never rebased or force-pushed/u);
});

test("delivery owns review fan-out, Git mechanics, push auth, and literal holds", () => {
  assert.match(delivery, /Use \*\*executor delivery\*\* by default/u);
  assert.match(delivery, /Use \*\*orchestrator-owned Git mechanics\*\* only after the executor proves/u);
  assert.match(delivery, /create a checkpoint commit without editing them/u);
  assert.match(delivery, /CLI and model family must differ from the\s+executor's/u);
  assert.match(delivery, /same single correction round/u);
  assert.match(delivery, /Prefer an existing\s+SSH push URL or SSH remote/u);
  assert.match(delivery, /gh auth refresh -s workflow/u);
  // Every unit PR waits for Henrique's own review before merge (decision
  // 2026-08-22) — a recorded `auto` policy no longer bypasses him.
  assert.match(delivery, /Every unit PR is held for Henrique's own review before merge/u);
  assert.match(delivery, /base is an epic branch/u);
  assert.match(delivery, /a recorded `auto` merge policy waits for the same review/u);
  assert.match(delivery, /never merges a\s+PR he has not reviewed, including with admin rights/u);
  // The other half of the guarantee: delegation downward is not authority.
  // The executor's ship-it run stops at merge-ready, and the ladder still
  // runs the full delivery before the hold.
  assert.match(delivery, /Ship-it delegation carries no merge authority[\s\S]*stops at merge-ready/u);
  assert.match(delivery, /The hold\s+comes after all of it, never instead of it/u);
  assert.match(delivery, /His feedback on the held PR returns to the executor\s+as a correction round/u);
  assert.match(skill, /held for Henrique's review — or, only after his approval of that exact\s+head, merged/u);
  // --merge-policy is removed: nothing on the create surface may reintroduce a
  // pre-authorized merge.
  assert.doesNotMatch(skill, /--merge-policy/u);
  assert.match(unit, /--merge-policy is removed/u);
  assert.match(delivery, /Dependent units wait when\s+this rule serializes them/u);
  // The delivery task budget: local CI alone can eat the old 60-minute default.
  assert.match(delivery, /Size that send's\s+`--total-min` to the repository's full local-CI entrypoint/u);
});

test("cleanup proves merge and binds force to one exact unit", () => {
  assert.match(skill, /Normal cleanup proves the unit PR is merged/u);
  assert.match(skill, /--force <id>/u);
  assert.match(unit, /--force must equal the exact unit id/u);
  assert.match(unit, /has no proved merged PR/u);
  assert.match(skill, /removes the manifest last/u);
});
