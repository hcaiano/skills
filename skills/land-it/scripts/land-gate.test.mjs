import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { decide, parseDoor, parseReceipt } from "./land-gate.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "land-gate.mjs");
const sha = "0123456789abcdef0123456789abcdef01234567";

const green = [
  { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "StatusContext", context: "CodeRabbit", state: "SUCCESS" },
];
const body = (receipt = `single by gpt-6.1-sol; 1 fixed, 0 rejected, 0 open; reviewed \`${sha.slice(0, 7)}\``) =>
  `Fix the thing.\n\n**Merge danger.** Door: two-way. Blast radius: small.\n\n**Review.** ${receipt}\n`;
const pr = (overrides = {}) => ({
  number: 7, url: "https://github.com/acme/app/pull/7", state: "OPEN", isDraft: false, body: body(),
  author: { login: "henrique" }, isCrossRepository: false, headRefOid: sha, baseRefName: "main",
  mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "", statusCheckRollup: green, labels: [],
  files: [{ path: "src/app.js" }], changedFiles: 1,
  ...overrides,
});
const facts = (prOverrides = {}, overrides = {}) => {
  const p = pr(prOverrides);
  return {
    pr: p, viewer: "henrique", defaultBranch: "main", unresolvedThreads: 0, moreThreads: false,
    receipt: parseReceipt(p.body), door: parseDoor(p.body), reviewed: { matches: true }, baseChangedAfterReview: false,
    ...overrides,
  };
};

test("a reviewed, green, two-way PR merges", () => {
  assert.deepEqual(decide(facts()), { action: "merge", reasons: [] });
});

test("risk, disagreement, foreign authorship and open review state each hold the PR", () => {
  const risky = facts({
    body: body("dual by claude-opus-5-5, gpt-6.1-sol; 0 fixed, 2 rejected, 1 open; reviewed 0123456").replace("two-way", "one-way"),
    isDraft: true, labels: [{ name: "do-not-merge" }, { name: "stakeholder-review" }], mergeable: "CONFLICTING",
    author: { login: "someone" }, isCrossRepository: true, baseRefName: "feature/epic", reviewDecision: "CHANGES_REQUESTED",
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }],
  }, { unresolvedThreads: 1, reviewed: { matches: false, reason: "HEAD changed since the review of 0123456" }, baseChangedAfterReview: true });
  assert.deepEqual(decide(risky), {
    action: "hold",
    reasons: [
      "PR comes from a fork",
      "PR author someone is not henrique",
      "base feature/epic is not the default branch main",
      "draft",
      "hold label: do-not-merge",
      "Door: one-way",
      "review-it graded dual",
      "2 rejected review finding(s): reviewers did not all agree",
      "1 review finding(s) or blocker(s) left open",
      "HEAD changed since the review of 0123456",
      "base changed after the review",
      "changes requested",
      "conflicts with the base",
      "1 unresolved review thread(s)",
      "failing checks: ci",
    ],
  });
});

test("the Merge danger line decides the door, and any one-way mention wins", () => {
  assert.equal(parseDoor("Old notes said Door: two-way.\n\n**Merge danger.** Door: one-way. Blast radius: data."), "one-way");
  assert.equal(parseDoor("We now read `Door: two-way` from write-pr.\n\n**Merge danger.** Blast radius: small."), null);
  assert.equal(parseDoor("**Merge danger.** Door: two-way. Blast radius: small."), "two-way");
});

test("a receipt without its open count, or skip on code, holds", () => {
  const old = facts({ body: body("single by gpt-6.1-sol; 0 fixed, 0 rejected; reviewed 0123456") });
  assert.deepEqual(decide(old).reasons, ["no review-it receipt in the PR body"]);
  const skip = (files) => facts({ body: body("skip by none; 0 fixed, 0 rejected, 0 open; reviewed 0123456"), files, changedFiles: files.length });
  assert.equal(decide(skip([{ path: "docs/guide.md" }])).action, "merge");
  assert.deepEqual(decide(skip([{ path: "skills/review-it/SKILL.md" }])).reasons, ["graded skip but changes more than plain docs"]);
  assert.deepEqual(decide(skip([{ path: "src/app.js" }])).reasons, ["graded skip but changes more than plain docs"]);
});

test("pending checks and unknown mergeability wait; behind updates; protection blocks hold", () => {
  const pending = [{ __typename: "CheckRun", name: "ci", status: "IN_PROGRESS", conclusion: "" }];
  assert.deepEqual(decide(facts({ statusCheckRollup: pending, mergeable: "UNKNOWN" })), {
    action: "wait", reasons: ["pending checks: ci", "GitHub is still computing mergeability"],
  });
  assert.deepEqual(decide(facts({ mergeStateStatus: "BEHIND" })), { action: "update-branch", reasons: ["branch is behind its base"] });
  assert.deepEqual(decide(facts({ mergeStateStatus: "BLOCKED" })), { action: "hold", reasons: ["branch protection blocks the merge"] });
  assert.deepEqual(decide(facts({ statusCheckRollup: [] })), { action: "hold", reasons: ["no checks reported"] });
});

// A `gh` stand-in that answers from the fixture in $GH_FIXTURE and appends
// every call to $GH_LOG, so a test sees which merge command ran.
const fakeGhDir = mkdtempSync(join(tmpdir(), "land-gate-gh-"));
writeFileSync(join(fakeGhDir, "gh"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(args) + '\\n');
const f = JSON.parse(fs.readFileSync(process.env.GH_FIXTURE, 'utf8'));
const out = (value) => console.log(JSON.stringify(value));
if (args[0] === 'pr' && args[1] === 'view' && args.at(-1) === 'state') out({ state: f.afterMerge });
else if (args[0] === 'pr' && args[1] === 'view') out(f.pr);
else if (args[0] === 'repo') out({ defaultBranchRef: { name: 'main' }, ...f.methods });
else if (args[0] === 'api' && args[1] === 'user') console.log('henrique');
else if (args[0] === 'api') out({ data: { repository: { pullRequest: {
  reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] }, timelineItems: { nodes: [] } } } } });
else if (args[0] === 'pr' && args[1] === 'merge' && f.mergeError) { console.error(f.mergeError); process.exit(1); }
`);
chmodSync(join(fakeGhDir, "gh"), 0o755);

const cli = (fixture, cwd) => {
  const dir = mkdtempSync(join(tmpdir(), "land-gate-case-"));
  writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture));
  writeFileSync(join(dir, "log"), "");
  const result = spawnSync("node", [script, fixture.pr.url, "--merge"], {
    cwd, encoding: "utf8",
    env: { ...process.env, PATH: `${fakeGhDir}:${process.env.PATH}`, GH_FIXTURE: join(dir, "fixture.json"), GH_LOG: join(dir, "log") },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(join(dir, "log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { ...JSON.parse(result.stdout), merges: calls.filter((call) => call[1] === "merge") };
};

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
  const reviewed = commit("fix.py", "if x:\n    danger()\n", "fix");
  g(work, "switch", "-q", "main");
  commit("other.txt", "other\n", "main moves on");
  g(work, "push", "-q", "origin", "main");
  g(work, "switch", "-q", "fix");
  g(work, "merge", "-q", "--no-edit", "main");
  const baseMerged = g(work, "rev-parse", "HEAD");
  const dedented = commit("fix.py", "if x:\ndanger()\n", "dedent after review");
  const publish = (head) => g(work, "push", "-q", "-f", "origin", `${head}:refs/pull/7/head`);
  return { work, reviewed, baseMerged, dedented, publish };
};

test("a head that only merged its base keeps the review and lands with an allowed method", () => {
  const { work, reviewed, baseMerged, publish } = repoWithPr();
  publish(baseMerged);
  const receipt = `single by gpt-6.1-sol; 0 fixed, 0 rejected, 0 open; reviewed ${reviewed.slice(0, 10)}`;
  const out = cli({ pr: pr({ headRefOid: baseMerged, body: body(receipt) }), methods: { squashMergeAllowed: false, mergeCommitAllowed: true }, afterMerge: "MERGED" }, work);
  assert.equal(out.action, "merge");
  assert.equal(out.acted, "merged");
  assert.deepEqual(out.merges, [["pr", "merge", "7", "-R", "acme/app", "--merge", "--match-head-commit", baseMerged]]);
});

test("any change after the review holds, even one patch-id would call whitespace", () => {
  const { work, reviewed, dedented, publish } = repoWithPr();
  publish(dedented);
  const receipt = `single by gpt-6.1-sol; 0 fixed, 0 rejected, 0 open; reviewed ${reviewed.slice(0, 10)}`;
  const out = cli({ pr: pr({ headRefOid: dedented, body: body(receipt) }), methods: { squashMergeAllowed: true } }, work);
  assert.equal(out.action, "hold");
  assert.deepEqual(out.reasons, [`HEAD changed since the review of ${reviewed.slice(0, 10)}`]);
  assert.deepEqual(out.merges, []);
});

test("a rejected or queued merge is reported, never claimed as merged", () => {
  const { work, reviewed, publish } = repoWithPr();
  publish(reviewed);
  const receipt = `single by gpt-6.1-sol; 0 fixed, 0 rejected, 0 open; reviewed ${reviewed}`;
  const base = { pr: pr({ headRefOid: reviewed, body: body(receipt) }), methods: { squashMergeAllowed: true } };
  const rejected = cli({ ...base, mergeError: "GraphQL: Head branch was modified. Review and try the merge again." }, work);
  assert.deepEqual([rejected.action, rejected.acted], ["hold", null]);
  assert.deepEqual(rejected.reasons, ["merge rejected: GraphQL: Head branch was modified. Review and try the merge again."]);
  const queued = cli({ ...base, afterMerge: "OPEN" }, work);
  assert.deepEqual([queued.action, queued.acted, queued.reasons], ["wait", "queued", ["queued to merge"]]);
});
