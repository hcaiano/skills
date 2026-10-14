import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { ownerBypass, decide, parseDoor, parseReceipt } from "./land-gate.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "land-gate.mjs");
const sha = "0123456789abcdef0123456789abcdef01234567";

test("a symlinked invocation prints usage when no PR is supplied", () => {
  const dir = mkdtempSync(join(tmpdir(), "land-gate-symlink-"));
  const linkedScript = join(dir, "land-gate.mjs");
  symlinkSync(script, linkedScript);
  for (const flags of [[], ["--preserve-symlinks-main"]]) {
    const result = spawnSync(process.execPath, [...flags, linkedScript], { encoding: "utf8" });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "usage: land-gate.mjs <pr-url|number> [--merge]\n");
  }
});

test("an import with a nonexistent argv path loads without running main", () => {
  const missing = join(mkdtempSync(join(tmpdir(), "land-gate-import-")), "missing.mjs");
  const source = `await import(${JSON.stringify(pathToFileURL(script).href)}); console.log('imported');`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source, missing], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "imported\n");
  assert.equal(result.stderr, "");
});

const green = [
  { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
  { __typename: "StatusContext", context: "CodeRabbit", state: "SUCCESS" },
];
const body = (receipt = `single by gpt-6.1-sol; 1 fixed, 0 rejected, 0 open; reviewed \`${sha.slice(0, 7)}\` on main`) =>
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
    pr: p, viewer: "henrique", defaultBranch: "main", unresolvedThreads: 0,
    receipt: parseReceipt(p.body), door: parseDoor(p.body), reviewed: { matches: true },
    ...overrides,
  };
};

test("a reviewed, green, two-way PR merges", () => {
  assert.deepEqual(decide(facts()), { action: "merge", reasons: [] });
});

test("risk, disagreement, foreign authorship and open review state each hold the PR", () => {
  const risky = facts({
    body: body("panel by claude-opus-5-5, gpt-6.1-sol; 0 fixed, 2 rejected, 1 open; reviewed 0123456 on fix/below").replace("two-way", "one-way"),
    isDraft: true, labels: [{ name: "do-not-merge" }, { name: "stakeholder-review" }], mergeable: "CONFLICTING",
    author: { login: "someone" }, isCrossRepository: true, baseRefName: "feature/epic", reviewDecision: "CHANGES_REQUESTED",
    statusCheckRollup: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "FAILURE" }],
  }, { unresolvedThreads: 1, reviewed: { matches: false, reason: "HEAD changed since the review of 0123456" } });
  assert.deepEqual(decide(risky), {
    action: "hold",
    reasons: [
      "PR comes from a fork",
      "PR author someone is not henrique",
      "base feature/epic is not the default branch main",
      "draft",
      "hold label: do-not-merge",
      "Door: one-way",
      "review-it graded panel",
      "2 rejected review finding(s) without one `- Declined:` reason each",
      "1 review finding(s) or blocker(s) left open",
      "reviewed on fix/below, but the base is now feature/epic",
      "HEAD changed since the review of 0123456",
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

test("reasoned declines land; unexplained or shared ones hold", () => {
  const receipt = `standard by claude-opus-5-5, gpt-6.1-sol; 0 fixed, 1 rejected, 0 open; reviewed \`${sha.slice(0, 7)}\` on main`;
  const reasoned = `${body(receipt)}\n- Declined: rename the helper (raised by gpt-6.1-sol): the name matches the API it wraps.`;
  assert.equal(decide(facts({ body: reasoned })).action, "merge");
  assert.deepEqual(decide(facts({ body: body(receipt) })).reasons, ["1 rejected review finding(s) without one `- Declined:` reason each"]);
  const shared = `${body(receipt)}\n- Declined: drop the cache (raised by claude-opus-5-5, gpt-6.1-sol): it is measured.`;
  assert.deepEqual(decide(facts({ body: shared })).reasons, ["a declined finding was raised by more than one reviewer"]);
  const hold = ["1 rejected review finding(s) without one `- Declined:` reason each"];
  for (const line of ["- Declined: x (raised by   ): reason", "- Declined: x (raised by ,): reason", "- Declined:    (raised by gpt-6.1-sol): reason", "- Declined: x (raised by gpt-6.1-sol):   ", "- Declined: x (raised by someone-else): reason", "- Declined: x (raised by a): reason", "- Declined: x (raised by sol): reason"]) {
    assert.deepEqual(decide(facts({ body: `${body(receipt)}\n${line}` })).reasons, hold, line);
  }
  const two = `standard by claude-opus-5-5, gpt-6.1-sol; 0 fixed, 2 rejected, 0 open; reviewed \`${sha.slice(0, 7)}\` on main`;
  const repeated = `${body(two)}\n- Declined: rename (raised by gpt-6.1-sol): fits.\n- Declined: rename (raised by gpt-6.1-sol): fits.`;
  assert.deepEqual(decide(facts({ body: repeated })).reasons, ["2 rejected review finding(s) without one `- Declined:` reason each"]);
});

test("an owner-only ruleset merges as the owner; anything else blocked holds", () => {
  assert.deepEqual(decide(facts({ mergeStateStatus: "BLOCKED" }, { rulesetBypass: true })), { action: "merge", reasons: [], admin: true });
  assert.deepEqual(decide(facts({ mergeStateStatus: "BLOCKED" }, { rulesetBypass: false })).reasons, ["branch protection blocks the merge"]);
});

test("owner bypass only covers owner-only rulesets and met classic protection", () => {
  const owner = { type: "update", ruleset_id: 1 };
  const responses = (rules, ruleset, protection) => (path) => {
    if (path.includes("/rules/branches/")) return [rules];
    if (path.includes("/rulesets/")) return [ruleset];
    if (protection instanceof Error) throw protection;
    return [protection];
  };
  const p = pr();
  const none = Object.assign(new Error("gh: Upgrade to GitHub Pro (HTTP 403)"), { stderr: "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)" });
  assert.equal(ownerBypass(p, "a/b", responses([owner], { current_user_can_bypass: "always" }, none)), true);
  assert.equal(ownerBypass(p, "a/b", responses([owner, { type: "pull_request", ruleset_id: 1 }], { current_user_can_bypass: "always" }, none)), false);
  assert.equal(ownerBypass(p, "a/b", responses([owner], { current_user_can_bypass: "always" }, { required_status_checks: { contexts: ["build-and-test"] } })), false);
  assert.equal(ownerBypass(pr({ statusCheckRollup: [{ __typename: "CheckRun", name: "build-and-test", status: "COMPLETED", conclusion: "SUCCESS" }] }), "a/b",
    responses([owner], { current_user_can_bypass: "always" }, { required_status_checks: { contexts: ["build-and-test"] } })), true);
  assert.equal(ownerBypass(p, "a/b", responses([owner], { current_user_can_bypass: "always" }, { required_pull_request_reviews: { required_approving_review_count: 1 } })), false);
  assert.equal(ownerBypass(p, "a/b", responses([owner], { current_user_can_bypass: "always" }, { required_signatures: { enabled: true } })), false);
  assert.equal(ownerBypass(p, "a/b", () => { throw new Error("HTTP 500"); }), false);
  assert.equal(ownerBypass(p, "a/b", responses([], { current_user_can_bypass: "always" }, none)), false);
  assert.equal(ownerBypass(p, "a/b", responses([owner], { current_user_can_bypass: "pull_requests_only" }, none)), true);
  assert.equal(ownerBypass(p, "a/b", responses([owner], { current_user_can_bypass: "always" }, Object.assign(new Error("x"), { stderr: "HTTP 403 Forbidden" }))), false);
  assert.equal(ownerBypass(p, "a/b", responses([owner], { current_user_can_bypass: "always" }, { required_pull_request_reviews: { required_approving_review_count: 0, require_last_push_approval: true } })), false);
});

test("a standard receipt lands and a high receipt holds", () => {
  assert.equal(decide(facts({ body: body(`standard by claude-opus-5-5, gpt-6.1-sol; 1 fixed, 0 rejected, 0 open; reviewed \`${sha.slice(0, 7)}\` on main`) })).action, "merge");
  assert.deepEqual(decide(facts({ body: body(`high by claude-opus-5-5, gpt-6.1-sol; 0 fixed, 0 rejected, 0 open; reviewed \`${sha.slice(0, 7)}\` on main`) })).reasons, ["review-it graded high"]);
});

test("an old receipt, a skip grade, a closed PR and a rollup with no success each stop the merge", () => {
  const old = facts({ body: body("single by gpt-6.1-sol; 0 fixed, 0 rejected; reviewed 0123456") });
  assert.deepEqual(decide(old).reasons, ["no review-it receipt in the PR body"]);
  const skip = facts({ body: body("skip by none; 0 fixed, 0 rejected, 0 open; reviewed 0123456 on main") });
  assert.deepEqual(decide(skip).reasons, ["graded skip: no reviewer saw the change"]);
  assert.deepEqual(decide(facts({ state: "CLOSED" })), { action: "done", reasons: ["PR was closed without merging"] });
  const skipped = [{ __typename: "CheckRun", name: "deploy", status: "COMPLETED", conclusion: "SKIPPED" }];
  assert.deepEqual(decide(facts({ statusCheckRollup: skipped })), { action: "hold", reasons: ["no check succeeded"] });
});

test("only the last Review line counts, and the base is read whole", () => {
  const approved = "**Review.** single by gpt-6.1-sol; 0 fixed, 0 rejected, 0 open; reviewed 0123456 on main";
  assert.equal(parseReceipt(`${approved}\n\n**Review.** dual by opus; 0 fixed, 1 rejected; reviewed 0123456`), null);
  assert.equal(parseReceipt("**Review.** single by sol; 0 fixed, 0 rejected, 0 open; reviewed 0123456 on main.release").base, "main.release");
  assert.equal(parseReceipt("**Review.** single by sol; 0 fixed, 0 rejected, 0 open; reviewed `0123456` on `main`.").base, "main");
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
  reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
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
  const receipt = `single by gpt-6.1-sol; 0 fixed, 0 rejected, 0 open; reviewed ${reviewed.slice(0, 10)} on main`;
  const out = cli({ pr: pr({ headRefOid: baseMerged, body: body(receipt) }), methods: { squashMergeAllowed: false, mergeCommitAllowed: true }, afterMerge: "MERGED" }, work);
  assert.equal(out.action, "merge");
  assert.equal(out.acted, "merged");
  assert.deepEqual(out.merges, [["pr", "merge", "7", "-R", "acme/app", "--merge", "--match-head-commit", baseMerged]]);
});

test("any change after the review holds, even one patch-id would call whitespace", () => {
  const { work, reviewed, dedented, publish } = repoWithPr();
  publish(dedented);
  const receipt = `single by gpt-6.1-sol; 0 fixed, 0 rejected, 0 open; reviewed ${reviewed.slice(0, 10)} on main`;
  const out = cli({ pr: pr({ headRefOid: dedented, body: body(receipt) }), methods: { squashMergeAllowed: true } }, work);
  assert.equal(out.action, "hold");
  assert.deepEqual(out.reasons, [`HEAD changed since the review of ${reviewed.slice(0, 10)}`]);
  assert.deepEqual(out.merges, []);
});

test("a rejected or queued merge is reported, never claimed as merged", () => {
  const { work, reviewed, publish } = repoWithPr();
  publish(reviewed);
  const receipt = `single by gpt-6.1-sol; 0 fixed, 0 rejected, 0 open; reviewed ${reviewed} on main`;
  const base = { pr: pr({ headRefOid: reviewed, body: body(receipt) }), methods: { squashMergeAllowed: true } };
  const rejected = cli({ ...base, mergeError: "GraphQL: Head branch was modified. Review and try the merge again." }, work);
  assert.deepEqual([rejected.action, rejected.acted], ["hold", null]);
  assert.deepEqual(rejected.reasons, ["merge rejected: GraphQL: Head branch was modified. Review and try the merge again."]);
  const queued = cli({ ...base, afterMerge: "OPEN" }, work);
  assert.deepEqual([queued.action, queued.acted, queued.reasons], ["wait", "queued", ["queued to merge"]]);
});
