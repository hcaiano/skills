import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const unitScript = join(here, "unit.mjs");
const root = mkdtempSync(join(tmpdir(), "orchestrate-unit-test-"));
const repository = join(root, "repository");
const remote = join(root, "remote.git");
const bin = join(root, "bin");
const pairScript = join(root, "fake-pair.mjs");
mkdirSync(repository);
mkdirSync(bin);

const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
execFileSync("git", ["init", "-b", "main", repository]);
git(repository, "config", "user.name", "Orchestrate Test");
git(repository, "config", "user.email", "orchestrate@example.test");
writeFileSync(join(repository, "README.md"), "# scratch\n");
git(repository, "add", "README.md");
git(repository, "commit", "-m", "initial");
execFileSync("git", ["init", "--bare", remote]);
git(repository, "remote", "add", "origin", remote);
git(repository, "push", "-u", "origin", "main");

writeFileSync(pairScript, `
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [command, ...args] = process.argv.slice(2);
const option = (name) => { const i = args.indexOf("--" + name); return i < 0 ? null : args[i + 1]; };
const repo = option("repo");
const git = spawnSync("git", ["-C", repo, "rev-parse", "--absolute-git-dir"], { encoding: "utf8" });
if (git.status !== 0) { console.log(JSON.stringify({ok:false,reason:"missing repo"})); process.exit(1); }
const gitDir = git.stdout.trim();
const statePath = join(gitDir, "fake-pair.json");
const inFlight = join(gitDir, "fake-in-flight");
const read = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
const emit = (value, code = 0) => { console.log(JSON.stringify(value)); process.exit(code); };
if (command === "init") {
  const current = read();
  if (current) emit(current);
  const partner = option("partner");
  const state = {ok:true,sid:"sid-" + partner + "-" + gitDir.split("/").at(-1),partner,role:"executor",model:option("model"),effort:option("effort"),seq:0};
  writeFileSync(statePath, JSON.stringify(state));
  emit(state);
}
if (command === "send") {
  const state = read();
  if (!state) emit({ok:false,reason:"no pair"}, 1);
  state.seq += 1;
  writeFileSync(statePath, JSON.stringify(state));
  const transcripts = join(gitDir, "pair", "transcripts");
  mkdirSync(transcripts, {recursive:true});
  const stem = String(state.seq).padStart(4, "0") + "-task";
  const receipt = join(transcripts, stem + "-receipt.json");
  writeFileSync(receipt, JSON.stringify({ok:true,status:"replied",seq:state.seq,reply:"ready"}));
  emit({ok:true,status:"running",seq:state.seq,sid:state.sid,receipt_file:receipt,supervisor_pid:123,partner_pid:456});
}
if (command === "status") {
  const state = read();
  if (!state) emit({ok:false,reason:"no pair"}, 1);
  emit({...state,session_known:true,in_flight:existsSync(inFlight) ? {seq:state.seq,pid:456} : null});
}
if (command === "end") {
  if (existsSync(inFlight)) emit({ok:false,reason:"in flight"}, 1);
  if (existsSync(statePath)) unlinkSync(statePath);
  emit({ok:true,status:"ended"});
}
emit({ok:false,reason:"unsupported " + command}, 2);
`);

writeFileSync(join(bin, "gh"), `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
const branch = args[args.indexOf("--head") + 1];
const merged = (process.env.FAKE_GH_MERGED || "").split(",").includes(branch);
const head = spawnSync("git", ["rev-parse", "refs/heads/" + branch], {encoding:"utf8"}).stdout.trim();
console.log(JSON.stringify(merged ? [{number:1,url:"https://example.test/pr/1",state:"MERGED",mergedAt:"2026-08-19T00:00:00Z",headRefOid:head,baseRefName:"main",isDraft:false}] : []));
`);
writeFileSync(join(bin, "trash"), `#!/usr/bin/env node
import { existsSync, renameSync } from "node:fs";
for (const path of process.argv.slice(2)) if (existsSync(path)) renameSync(path, path + ".trashed." + process.pid);
`);
execFileSync("chmod", ["+x", join(bin, "gh"), join(bin, "trash")]);

const baseEnv = {
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  ORCHESTRATE_PAIR_SCRIPT: pairScript,
};
const invoke = (args, env = {}) => {
  const result = spawnSync(process.execPath, [unitScript, ...args], {
    encoding: "utf8",
    env: { ...baseEnv, ...env },
  });
  let output;
  try { output = JSON.parse(result.stdout); } catch { output = { stdout: result.stdout, stderr: result.stderr }; }
  return { ...result, output };
};
const taskFile = (name) => {
  const path = join(root, `${name}.md`);
  writeFileSync(path, `Implement ${name} and reply ready.\n`);
  return path;
};
const createArgs = (id, partner = "codex", setup = "true") => [
  "create", "--repo", repository,
  "--unit", id,
  "--worktree", join(root, `worktree-${id}`),
  "--branch", `feat/${id}`,
  "--base", "main",
  "--lead", "claude",
  "--partner", partner,
  "--model", "CLI-default",
  "--effort", "high",
  "--reason", `${partner} matches the task difficulty and available pool`,
  "--task-file", taskFile(id),
  "--scope", `file-${id}.txt`,
  "--validation", "test -f README.md",
  "--merge-policy", "auto",
  "--setup", setup,
];

test("create journals a durable unit and starts an executor pair", () => {
  const created = invoke(createArgs("one"));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  assert.equal(created.output.status, "created");
  assert.equal(created.output.unit.lifecycle, "working");
  assert.equal(created.output.unit.staffing.current.partner, "codex");
  assert.match(created.output.unit.staffing.current.reason, /task difficulty/u);
  assert.equal(created.output.unit.pair.latest_seq, 1);
  assert.equal(created.output.unit.observed.latest_receipt.status, "replied");
});

test("fresh list and status reconstruct the unit from disk", () => {
  const listed = invoke(["list", "--repo", repository]);
  assert.equal(listed.status, 0);
  assert.equal(listed.output.units.some((unit) => unit.unit_id === "one"), true);
  const status = invoke(["status", "--repo", repository, "--unit", "one"]);
  assert.equal(status.status, 0);
  assert.equal(status.output.unit.observed.worktree.branch, "feat/one");
  assert.equal(status.output.unit.observed.pair.session_known, true);
});

test("create refuses duplicate unit, branch, worktree, and same-harness partner", () => {
  const duplicate = invoke(createArgs("one"));
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.output.reason, /already exists|conflicts/u);
  const sameHarness = createArgs("same", "claude");
  const refused = invoke(sameHarness);
  assert.notEqual(refused.status, 0);
  assert.match(refused.output.reason, /differ from the orchestrator/u);
});

test("two linked worktrees hold distinct pair state", () => {
  const created = invoke(createArgs("two", "grok"));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  const oneGitDir = git(join(root, "worktree-one"), "rev-parse", "--absolute-git-dir");
  const twoGitDir = git(join(root, "worktree-two"), "rev-parse", "--absolute-git-dir");
  assert.notEqual(oneGitDir, twoGitDir);
  assert.equal(existsSync(join(oneGitDir, "fake-pair.json")), true);
  assert.equal(existsSync(join(twoGitDir, "fake-pair.json")), true);
});

test("restaff checkpoints the receipt and keeps the worktree", () => {
  const result = invoke([
    "restaff", "--repo", repository, "--unit", "one",
    "--lead", "claude", "--partner", "cursor", "--model", "CLI-default",
    "--effort", "high", "--reason", "the previous pool refused a new turn",
  ]);
  assert.equal(result.status, 0, result.stderr || JSON.stringify(result.output));
  assert.equal(result.output.unit.staffing.current.partner, "cursor");
  assert.equal(result.output.unit.staffing.history.length, 1);
  assert.equal(result.output.unit.staffing.history[0].checkpoint.receipt.status, "replied");
  assert.equal(existsSync(join(root, "worktree-one")), true);
});

test("dismantle refuses an in-flight pair and an unmerged PR", () => {
  const gitDir = git(join(root, "worktree-one"), "rev-parse", "--absolute-git-dir");
  const marker = join(gitDir, "fake-in-flight");
  writeFileSync(marker, "busy\n");
  const busy = invoke(["dismantle", "--repo", repository, "--unit", "one", "--force", "one"]);
  assert.notEqual(busy.status, 0);
  assert.match(busy.output.reason, /in-flight/u);
  unlinkSync(marker);
  const unmerged = invoke(["dismantle", "--repo", repository, "--unit", "one"]);
  assert.notEqual(unmerged.status, 0);
  assert.match(unmerged.output.reason, /no proved merged PR/u);
});

test("normal dismantle requires merge proof and removes owned resources", () => {
  const result = invoke(
    ["dismantle", "--repo", repository, "--unit", "one"],
    { FAKE_GH_MERGED: "feat/one" },
  );
  assert.equal(result.status, 0, result.stderr || JSON.stringify(result.output));
  assert.equal(result.output.merged_pr.state, "MERGED");
  assert.equal(existsSync(join(root, "worktree-one")), false);
  assert.notEqual(git(repository, "branch", "--list", "feat/one"), "feat/one");
  const listed = invoke(["list", "--repo", repository]);
  assert.equal(listed.output.units.some((unit) => unit.unit_id === "one"), false);
});

test("dismantle resumes after the pair ended before its journal update", () => {
  const created = invoke(createArgs("partial-dismantle"));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  const worktree = join(root, "worktree-partial-dismantle");
  const ended = spawnSync(process.execPath, [pairScript, "end", "--repo", worktree], {
    encoding: "utf8",
    env: baseEnv,
  });
  assert.equal(ended.status, 0, ended.stderr);

  const common = git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const recordPath = join(common, "orchestrate", "units", "partial-dismantle.json");
  const record = JSON.parse(readFileSync(recordPath, "utf8"));
  record.lifecycle = "dismantling";
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);

  const resumed = invoke([
    "dismantle", "--repo", repository, "--unit", "partial-dismantle",
    "--force", "partial-dismantle",
  ]);
  assert.equal(resumed.status, 0, resumed.stderr || JSON.stringify(resumed.output));
  assert.equal(existsSync(worktree), false);
  assert.equal(existsSync(recordPath), false);
});

test("force cleanup needs the exact unit id", () => {
  const wrong = invoke(["dismantle", "--repo", repository, "--unit", "two", "--force", "wrong"]);
  assert.notEqual(wrong.status, 0);
  assert.match(wrong.output.reason, /must equal the exact unit id/u);
  const exact = invoke(["dismantle", "--repo", repository, "--unit", "two", "--force", "two"]);
  assert.equal(exact.status, 0, exact.stderr || JSON.stringify(exact.output));
  assert.equal(exact.output.forced, true);
});

test("a setup failure rolls back only resources created by that command", () => {
  const failed = invoke(createArgs("setup-fails", "codex", "exit 7"));
  assert.notEqual(failed.status, 0);
  assert.match(failed.output.reason, /unit setup/u);
  assert.equal(existsSync(join(root, "worktree-setup-fails")), false);
  assert.equal(git(repository, "branch", "--list", "feat/setup-fails"), "");
  const listed = invoke(["list", "--repo", repository]);
  assert.equal(listed.output.units.some((unit) => unit.unit_id === "setup-fails"), false);
});

test("registry locking refuses a live owner and recovers a dead owner", () => {
  const common = git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const registry = join(common, "orchestrate");
  const lock = join(registry, "registry.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: process.pid })}\n`);
  const busy = invoke(createArgs("live-lock"));
  assert.notEqual(busy.status, 0);
  assert.match(busy.output.reason, /registry is busy/u);
  unlinkSync(join(lock, "owner.json"));
  rmdirSync(lock);

  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: 2147483647 })}\n`);
  const recovered = invoke(createArgs("dead-lock"));
  assert.equal(recovered.status, 0, recovered.stderr || JSON.stringify(recovered.output));
  assert.equal(readdirSync(registry).some((name) => name.startsWith("registry.lock.trashed.")), true);
  const cleaned = invoke(["dismantle", "--repo", repository, "--unit", "dead-lock", "--force", "dead-lock"]);
  assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
});

test("list exposes every journaled recovery phase", () => {
  const common = git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const units = join(common, "orchestrate", "units");
  mkdirSync(units, { recursive: true });
  const phases = ["creating", "setting-up", "initializing-pair", "restaff-failed", "dismantle-failed"];
  for (const phase of phases) {
    writeFileSync(join(units, `recovery-${phase}.json`), `${JSON.stringify({
      schema_version: 1,
      unit_id: `recovery-${phase}`,
      repository,
      common_git_dir: common,
      worktree: join(root, `missing-${phase}`),
      branch: `recovery/${phase}`,
      base: "main",
      lifecycle: phase,
      staffing: { current: { partner: "codex", model: null, effort: "high", reason: "recovery fixture" }, history: [] },
      pair: null,
      cleanup: [],
    }, null, 2)}\n`);
  }
  const listed = invoke(["list", "--repo", repository]);
  assert.equal(listed.status, 0);
  for (const phase of phases) {
    assert.equal(listed.output.units.some((unit) => unit.lifecycle === phase), true);
    unlinkSync(join(units, `recovery-${phase}.json`));
  }
});
