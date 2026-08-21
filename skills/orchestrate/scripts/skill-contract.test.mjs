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
  assert.match(skill, /manifest-owned task file is authoritative/u);
  assert.match(skill, /resumes `creating`, `setting-up`,\s+`initializing-pair`, or `starting`/u);
  assert.match(skill, /recoverable Cursor record that stores a separate effort/u);
  assert.match(unit, /resumed_from/u);
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
  assert.match(staffing, /pool headroom first and speed second/u);
  assert.match(staffing, /current orchestrator CLI is not a legal partner/u);
  assert.match(staffing, /Haiku; Fable is advisor-only/u);
  assert.match(staffing, /Luna/u);
  assert.match(staffing, /OpenCode/u);
  assert.match(staffing, /opencode models/u);
  assert.match(staffing, /one-line reason/u);
  assert.match(staffing, /effort-specific name exactly as the live catalog prints/u);
  assert.match(staffing, /omit `--effort`/u);
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

test("cleanup proves merge and binds force to one exact unit", () => {
  assert.match(skill, /Normal cleanup proves the unit PR is merged/u);
  assert.match(skill, /--force <id>/u);
  assert.match(unit, /--force must equal the exact unit id/u);
  assert.match(unit, /has no proved merged PR/u);
  assert.match(skill, /removes the manifest last/u);
});
