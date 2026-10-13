import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = join(dirname(fileURLToPath(import.meta.url)), "land-gate.mjs");

// A `gh` stand-in that answers from the fixture in $GH_FIXTURE and appends
// every call to $GH_LOG, so a test sees which merge command would have run.
const fakeGhDir = mkdtempSync(join(tmpdir(), "land-gate-gh-"));
writeFileSync(join(fakeGhDir, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
const fixture = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, 'utf8'));
if (args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify(fixture.pr));
else if (args[0] === 'pr' && args[1] === 'list') console.log(JSON.stringify(fixture.stackedOn ?? []));
else if (args[0] === 'api') console.log(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
  pageInfo: { hasNextPage: false },
  nodes: Array.from({ length: fixture.unresolved ?? 0 }, () => ({ isResolved: false })) } } } } }));
`);
chmodSync(join(fakeGhDir, "gh"), 0o755);

const green = [
  { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "StatusContext", context: "CodeRabbit", state: "SUCCESS" },
];
const body = (sha, receipt = `single by gpt-6.1-sol; 1 fixed, 0 rejected; reviewed \`${sha.slice(0, 7)}\``) =>
  `Fix the thing.\n\n**Merge danger.** Door: two-way. Blast radius: small.\n\n**Review.** ${receipt}\n`;
const pr = (head, overrides = {}) => ({
  number: 7, url: "https://github.com/acme/app/pull/7", state: "OPEN", isDraft: false,
  body: body(head), headRefOid: head, headRefName: "fix/thing", baseRefName: "main",
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "", statusCheckRollup: green, labels: [],
  ...overrides,
});

const gate = (fixture, { cwd = tmpdir(), merge = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "land-gate-case-"));
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture));
  writeFileSync(join(dir, "log"), "");
  const result = spawnSync("node", [script, "https://github.com/acme/app/pull/7", ...(merge ? ["--merge"] : [])], {
    cwd, encoding: "utf8",
    env: { ...process.env, PATH: `${fakeGhDir}:${process.env.PATH}`, GH_FIXTURE: join(dir, "fixture.json"), GH_LOG: join(dir, "log") },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(join(dir, "log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { ...JSON.parse(result.stdout), calls };
};

const sha = "0123456789abcdef0123456789abcdef01234567";

test("a reviewed, green, two-way PR is squashed at the reviewed head", () => {
  const out = gate({ pr: pr(sha) }, { merge: true });
  assert.equal(out.action, "merge");
  assert.deepEqual(out.reasons, []);
  assert.equal(out.acted, "merged");
  assert.deepEqual(out.calls.at(-1), ["pr", "merge", "7", "-R", "acme/app", "--squash", "--match-head-commit", sha]);
});

test("risk, disagreement and open review state each hold the PR", () => {
  const risky = pr(sha, {
    body: body(sha, `dual by claude-opus-5-5, gpt-6.1-sol; 0 fixed, 2 rejected; reviewed ${sha.slice(0, 7)}`).replace("two-way", "one-way"),
    isDraft: true, labels: [{ name: "do-not-merge" }], mergeable: "CONFLICTING",
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }],
  });
  const out = gate({ pr: risky, unresolved: 1, stackedOn: [{ number: 6, state: "OPEN", baseRefName: "main" }] }, { merge: true });
  assert.equal(out.action, "hold");
  assert.equal(out.acted, null);
  assert.deepEqual(out.reasons, [
    "draft",
    "hold label: do-not-merge",
    "Door: one-way",
    "review-it graded dual",
    "2 rejected review finding(s): reviewers did not all agree",
    "base is the branch of open PR #6; land it first",
    "conflicts with the base",
    "1 unresolved review thread(s)",
    "failing checks: ci",
  ]);
  assert.ok(!out.calls.some((call) => call[1] === "merge"));
});

test("a PR with no receipt, or stacked on a merged PR, is held", () => {
  const out = gate({ pr: pr(sha, { body: "Door: two-way" }) });
  assert.deepEqual(out.reasons, ["no review-it receipt in the PR body"]);

  const orphan = gate({ pr: pr(sha, { baseRefName: "fix/below" }), stackedOn: [{ number: 6, state: "MERGED", baseRefName: "main" }] });
  assert.deepEqual(orphan.reasons, ["PR #6 under this one merged; rebase onto main and retarget"]);
});

test("pending checks wait and a branch behind its base is updated", () => {
  const pending = gate({ pr: pr(sha, { statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: "" }] }) });
  assert.equal(pending.action, "wait");
  assert.deepEqual(pending.reasons, ["pending checks: ci"]);

  const behind = gate({ pr: pr(sha, { mergeStateStatus: "BEHIND" }) }, { merge: true });
  assert.equal(behind.action, "update-branch");
  assert.equal(behind.acted, "branch-updated");
  assert.deepEqual(behind.calls.at(-1), ["pr", "update-branch", "7", "-R", "acme/app"]);
});

// A real origin with main and the PR head under refs/pull/7/head, as GitHub
// publishes them, and a clone to run the gate in.
const repoWithPr = () => {
  const root = mkdtempSync(join(tmpdir(), "land-gate-git-"));
  const g = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  g(root, "init", "-q", "--bare", "-b", "main", origin);
  g(root, "clone", "-q", origin, work);
  const commit = (file, text, message) => {
    writeFileSync(join(work, file), text);
    g(work, "add", file);
    g(work, "commit", "-q", "-m", message);
    return g(work, "rev-parse", "HEAD");
  };
  commit("base.txt", "base\n", "base");
  g(work, "push", "-q", "origin", "main");
  g(work, "switch", "-q", "-c", "fix");
  const reviewed = commit("fix.txt", "fix\n", "fix");
  g(work, "switch", "-q", "main");
  commit("other.txt", "other\n", "main moves on");
  g(work, "push", "-q", "origin", "main");
  g(work, "switch", "-q", "fix");
  g(work, "merge", "-q", "--no-edit", "main");
  const baseMerged = g(work, "rev-parse", "HEAD");
  const changed = commit("fix.txt", "fix, changed after review\n", "unreviewed change");
  const publish = (head) => g(work, "push", "-q", "-f", "origin", `${head}:refs/pull/7/head`);
  return { work, reviewed, baseMerged, changed, publish };
};

test("a head that only merged its base keeps the review; a new change does not", () => {
  const { work, reviewed, baseMerged, changed, publish } = repoWithPr();

  publish(baseMerged);
  const merged = gate({ pr: pr(baseMerged, { body: body(reviewed) }) }, { cwd: work });
  assert.equal(merged.action, "merge");

  publish(changed);
  const edited = gate({ pr: pr(changed, { body: body(reviewed) }) }, { cwd: work });
  assert.equal(edited.action, "hold");
  assert.deepEqual(edited.reasons, [`HEAD changed since the review of ${reviewed.slice(0, 7)}`]);
});
