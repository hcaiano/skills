import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  symlinkSync,
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
const counterPath = join(gitDir, "fake-pair-counter");
const inFlight = join(gitDir, "fake-in-flight");
const read = () => existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
const latestReceipt = (state) => {
  if (!state || state.seq < 1) return null;
  const receipt = join(gitDir, "pair", "transcripts", String(state.seq).padStart(4, "0") + "-task-receipt.json");
  return existsSync(receipt) ? {...JSON.parse(readFileSync(receipt, "utf8")), receipt_file:receipt} : null;
};
const emit = (value, code = 0) => { console.log(JSON.stringify(value)); process.exit(code); };
if (command === "init") {
  const current = read();
  if (current) emit(current);
  const partner = option("partner");
  if (process.env.FAKE_PAIR_FAIL_INIT_PARTNER === partner) emit({ok:false,reason:"forced init failure for " + partner}, 1);
  const count = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) + 1 : 1;
  writeFileSync(counterPath, String(count));
  const baseSid = "sid-" + partner + "-" + gitDir.split("/").at(-1);
  const state = {ok:true,sid:baseSid + (count === 1 ? "" : "-" + count),partner,role:"executor",model:option("model"),effort:option("effort"),seq:0,forked:[]};
  writeFileSync(statePath, JSON.stringify(state));
  if (process.env.FAKE_PAIR_BAD_INIT_RESPONSE_PARTNER === partner) emit({...state,model:"forced-wrong-model"});
  emit(state);
}
if (command === "send") {
  const state = read();
  if (!state) emit({ok:false,reason:"no pair"}, 1);
  if (process.env.FAKE_PAIR_FAIL_SEND_PARTNER === state.partner) emit({ok:false,reason:"forced send failure for " + state.partner}, 1);
  state.seq += 1;
  writeFileSync(statePath, JSON.stringify(state));
  const transcripts = join(gitDir, "pair", "transcripts");
  mkdirSync(transcripts, {recursive:true});
  const stem = String(state.seq).padStart(4, "0") + "-task";
  const receipt = join(transcripts, stem + "-receipt.json");
  writeFileSync(receipt, JSON.stringify({ok:true,status:"replied",seq:state.seq,reply:"ready"}));
  if (process.env.FAKE_PAIR_BAD_SEND_AFTER_START === state.partner) emit({ok:true,status:"unexpected",seq:state.seq,sid:state.sid,receipt_file:receipt});
  emit({ok:true,status:"running",seq:state.seq,sid:state.sid,receipt_file:receipt,supervisor_pid:123,partner_pid:456});
}
if (command === "status") {
  const state = read();
  if (!state) emit({ok:false,reason:"no pair"}, 1);
  emit({...state,session_known:true,in_flight:existsSync(inFlight) ? {seq:state.seq,pid:456} : null,latest_receipt:latestReceipt(state),lineage:{current_sid:state.sid,forks:state.forked || []}});
}
if (command === "fork") {
  const state = read();
  if (!state) emit({ok:false,reason:"no pair"}, 1);
  const successor = state.sid + "-fork";
  state.forked = [...(state.forked || []), {sid:state.sid,forked_at:"2026-08-21T00:00:00.000Z",successor_sid:successor}];
  state.sid = successor;
  writeFileSync(statePath, JSON.stringify(state));
  emit({...state,lineage:{current_sid:state.sid,forks:state.forked}});
}
if (command === "end") {
  if (existsSync(inFlight)) emit({ok:false,reason:"in flight"}, 1);
  if (existsSync(statePath)) unlinkSync(statePath);
  if (process.env.FAKE_PAIR_FAIL_AFTER_END === "1") emit({ok:false,reason:"forced failure after end"}, 1);
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
for (const path of process.argv.slice(2)) {
  if (process.env.FAKE_TRASH_FAIL_MATCH && path.includes(process.env.FAKE_TRASH_FAIL_MATCH)) process.exit(9);
  if (existsSync(path)) renameSync(path, path + ".trashed." + process.pid);
}
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
const invokeAsync = (args, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [unitScript, ...args], {
    env: { ...baseEnv, ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (status) => {
    let output;
    try { output = JSON.parse(stdout); } catch { output = { stdout, stderr }; }
    resolve({ status, stdout, stderr, output });
  });
});
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
const resumeArgs = (id, partner = "codex", setup = "true") => {
  const args = createArgs(id, partner, setup);
  const index = args.indexOf("--task-file");
  const originalTaskFile = args[index + 1];
  args.splice(index, 2);
  unlinkSync(originalTaskFile);
  return args;
};
const writeRecoveryRecord = (
  id,
  lifecycle,
  { withWorktree = false, withPair = false, pairStarted = false, recordSid = null } = {},
) => {
  const common = git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const units = join(common, "orchestrate", "units");
  let worktree = join(root, `worktree-${id}`);
  const branch = `feat/${id}`;
  const task = `Implement ${id} and reply ready.`;
  mkdirSync(units, { recursive: true });
  if (withWorktree) {
    git(repository, "worktree", "add", "-b", branch, worktree, "main");
    worktree = git(worktree, "rev-parse", "--show-toplevel");
  }
  if (withPair) {
    const initialized = spawnSync(process.execPath, [
      pairScript, "init", "--repo", worktree,
      "--partner", "codex", "--effort", "high", "--role", "executor",
    ], { encoding: "utf8", env: baseEnv });
    assert.equal(initialized.status, 0, initialized.stderr);
    if (pairStarted) {
      const bodyFile = taskFile(`${id}-started`);
      const sent = spawnSync(process.execPath, [
        pairScript, "send", "--repo", worktree,
        "--kind", "task", "--body-file", bodyFile, "--background",
      ], { encoding: "utf8", env: baseEnv });
      assert.equal(sent.status, 0, sent.stderr);
    }
  }
  const record = {
    schema_version: 1,
    unit_id: id,
    repository,
    common_git_dir: common,
    worktree,
    branch,
    base: "main",
    lifecycle,
    lead: "claude",
    task,
    task_file: join(common, "orchestrate", "tasks", `${id}.md`),
    scope: `file-${id}.txt`,
    validation: "test -f README.md",
    merge_policy: "auto",
    setup: "true",
    resources: {
      task_file: false,
      worktree: withWorktree,
      local_branch: withWorktree,
      pair: withPair,
    },
    staffing: {
      current: {
        partner: "codex",
        model: null,
        effort: "high",
        reason: "codex matches the task difficulty and available pool",
        selected_at: "2026-08-19T00:00:00.000Z",
      },
      history: [],
    },
    pair: withPair ? {
      sid: recordSid ?? `sid-codex-${worktree.split("/").at(-1)}`,
      latest_seq: 0,
    } : null,
    cleanup: [],
    created_at: "2026-08-19T00:00:00.000Z",
    updated_at: "2026-08-19T00:00:00.000Z",
  };
  writeFileSync(join(units, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
};

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

test("status advances a recorded pair sid through public fork lineage", () => {
  const id = "fork-status";
  const created = invoke(createArgs(id, "grok"));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  const oldSid = created.output.unit.pair.sid;
  const worktree = join(root, `worktree-${id}`);
  const forked = spawnSync(process.execPath, [pairScript, "fork", "--repo", worktree], {
    encoding: "utf8",
    env: baseEnv,
  });
  assert.equal(forked.status, 0, forked.stderr);
  const successor = JSON.parse(forked.stdout).sid;
  assert.notEqual(successor, oldSid);

  const status = invoke(["status", "--repo", repository, "--unit", id]);
  assert.equal(status.status, 0, status.stderr || JSON.stringify(status.output));
  assert.equal(status.output.unit.pair.sid, successor);
  assert.equal(status.output.unit.observed.pair.sid, successor);
});

test("restaff ends the reachable head of a forked pair", () => {
  const id = "fork-restaff";
  const created = invoke(createArgs(id, "grok"));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  const worktree = join(root, `worktree-${id}`);
  const forked = spawnSync(process.execPath, [pairScript, "fork", "--repo", worktree], {
    encoding: "utf8",
    env: baseEnv,
  });
  assert.equal(forked.status, 0, forked.stderr);
  const successor = JSON.parse(forked.stdout).sid;

  const restaffed = invoke(restaffArgs(id, "codex"));
  assert.equal(restaffed.status, 0, restaffed.stderr || JSON.stringify(restaffed.output));
  assert.equal(restaffed.output.unit.staffing.current.partner, "codex");
  assert.equal(restaffed.output.unit.staffing.history[0].checkpoint.pair_sid, successor);
});

test("an unrelated live pair sid is refused by status and restaff", () => {
  const id = "unrelated-sid";
  const created = invoke(createArgs(id));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  const worktree = join(root, `worktree-${id}`);
  const gitDir = git(worktree, "rev-parse", "--absolute-git-dir");
  const fakeStatePath = join(gitDir, "fake-pair.json");
  const state = JSON.parse(readFileSync(fakeStatePath, "utf8"));
  state.sid = "sid-from-an-unrelated-session";
  state.forked = [];
  writeFileSync(fakeStatePath, JSON.stringify(state));

  const status = invoke(["status", "--repo", repository, "--unit", id]);
  assert.notEqual(status.status, 0);
  assert.match(status.output.reason, /pair sid differs/u);
  const restaffed = invoke(restaffArgs(id));
  assert.notEqual(restaffed.status, 0);
  assert.match(restaffed.output.reason, /pair sid differs/u);
});

test("create refuses duplicate unit, branch, worktree, and same-harness partner", () => {
  const duplicate = invoke(createArgs("one"));
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.output.reason, /already exists|conflicts/u);
  const sameHarness = createArgs("same", "claude");
  const refused = invoke(sameHarness);
  assert.equal(refused.status, 2);
  assert.match(refused.output.reason, /differ from the orchestrator/u);

  const sameOpenCode = createArgs("same-opencode", "opencode");
  sameOpenCode[sameOpenCode.indexOf("--lead") + 1] = "opencode";
  const refusedOpenCode = invoke(sameOpenCode);
  assert.equal(refusedOpenCode.status, 2);
  assert.match(refusedOpenCode.output.reason, /differ from the orchestrator/u);
});

test("OpenCode is a legal executor for a different harness", () => {
  const created = invoke(createArgs("opencode-executor", "opencode"));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  assert.equal(created.output.unit.staffing.current.partner, "opencode");
  assert.equal(created.output.unit.staffing.current.effort, "high");
});

test("cursor staffing uses the effort-specific live-catalog model without a separate effort", () => {
  const args = createArgs("cursor-catalog", "cursor");
  args.splice(args.indexOf("--effort"), 2);
  args[args.indexOf("--model") + 1] = "gpt-5.3-codex-low-fast";
  const created = invoke(args);
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  assert.equal(created.output.unit.staffing.current.model, "gpt-5.3-codex-low-fast");
  assert.equal(created.output.unit.staffing.current.effort, null);
  assert.equal(created.output.unit.observed.pair.effort, null);

  const incompatible = createArgs("cursor-old-syntax", "cursor");
  incompatible[incompatible.indexOf("--model") + 1] = "gpt-5.3-codex-low-fast";
  const refused = invoke(incompatible);
  assert.notEqual(refused.status, 0);
  assert.match(refused.output.reason, /omit --effort/u);
});

test("create resumes every journaled phase from the manifest-owned task", () => {
  const cases = [
    ["recover-creating", "creating", {}],
    ["recover-setting-up", "setting-up", { withWorktree: true }],
    ["recover-initializing", "initializing-pair", { withWorktree: true }],
    ["recover-starting", "starting", { withWorktree: true, withPair: true }],
    ["recover-started", "starting", { withWorktree: true, withPair: true, pairStarted: true }],
  ];
  for (const [id, phase, state] of cases) {
    const record = writeRecoveryRecord(id, phase, state);
    const resumed = invoke(resumeArgs(id));
    assert.equal(resumed.status, 0, resumed.stderr || JSON.stringify(resumed.output));
    assert.equal(resumed.output.status, "resumed");
    assert.equal(resumed.output.resumed_from, phase);
    assert.equal(resumed.output.unit.lifecycle, "working");
    assert.equal(resumed.output.unit.pair.latest_seq, 1);
    assert.equal(readFileSync(record.task_file, "utf8"), `${record.task}\n`);
    const cleaned = invoke(["dismantle", "--repo", repository, "--unit", id, "--force", id]);
    assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
    assert.equal(existsSync(record.task_file), false);
  }
});

test("create migrates a pairless legacy Cursor recovery record", () => {
  const id = "recover-cursor-legacy";
  const record = writeRecoveryRecord(id, "setting-up", { withWorktree: true });
  const common = git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const path = join(common, "orchestrate", "units", `${id}.json`);
  record.staffing.current = {
    partner: "cursor",
    model: null,
    effort: "high",
    reason: "cursor matches the task difficulty and available pool",
    selected_at: "2026-08-19T00:00:00.000Z",
  };
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);

  const args = resumeArgs(id, "cursor");
  args.splice(args.indexOf("--effort"), 2);
  args[args.indexOf("--model") + 1] = "gpt-5.3-codex-low-fast";
  const resumed = invoke(args);
  assert.equal(resumed.status, 0, resumed.stderr || JSON.stringify(resumed.output));
  assert.equal(resumed.output.resumed_from, "setting-up");
  assert.equal(resumed.output.unit.staffing.current.model, "gpt-5.3-codex-low-fast");
  assert.equal(resumed.output.unit.staffing.current.effort, null);
  assert.equal(resumed.output.unit.staffing.history.length, 1);
  assert.equal(
    resumed.output.unit.staffing.history[0].migration,
    "cursor-live-catalog-effort-model",
  );
});

test("create names the immutable field that prevents resume", () => {
  writeRecoveryRecord("recover-mismatch", "creating");
  const args = resumeArgs("recover-mismatch");
  args[args.indexOf("--scope") + 1] = "a different scope";
  const refused = invoke(args);
  assert.notEqual(refused.status, 0);
  assert.match(refused.output.reason, /scope differs/u);
  const cleaned = invoke([
    "dismantle", "--repo", repository, "--unit", "recover-mismatch",
    "--force", "recover-mismatch",
  ]);
  assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
});

test("create recovery keeps a manifest mismatch as one JSON document", () => {
  const record = writeRecoveryRecord("recover-task-mismatch", "creating");
  mkdirSync(dirname(record.task_file), { recursive: true });
  writeFileSync(record.task_file, "different task\n");
  const refused = invoke(resumeArgs("recover-task-mismatch"));
  assert.notEqual(refused.status, 0);
  const document = JSON.parse(refused.stdout);
  assert.match(document.reason, /manifest task differs/u);
  assert.equal(document.reason, refused.output.reason);
  const cleaned = invoke([
    "dismantle", "--repo", repository, "--unit", "recover-task-mismatch",
    "--force", "recover-task-mismatch",
  ]);
  assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
});

test("create refuses a replaced or phase-impossible pair during recovery", () => {
  const cases = [
    [
      "recover-wrong-sid",
      "starting",
      { withWorktree: true, withPair: true, recordSid: "sid-from-another-session" },
      /pair sid differs/u,
    ],
    [
      "recover-early-pair",
      "setting-up",
      { withWorktree: true, withPair: true },
      /unexpected pair in phase setting-up/u,
    ],
    [
      "recover-early-seq",
      "initializing-pair",
      { withWorktree: true, withPair: true, pairStarted: true },
      /unexpected started pair/u,
    ],
  ];
  for (const [id, phase, state, reason] of cases) {
    writeRecoveryRecord(id, phase, state);
    const refused = invoke(resumeArgs(id));
    assert.notEqual(refused.status, 0);
    assert.match(refused.output.reason, reason);
    const cleaned = invoke(["dismantle", "--repo", repository, "--unit", id, "--force", id]);
    assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
  }
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
    "--lead", "claude", "--partner", "cursor", "--model", "gpt-5.3-codex-low-fast",
    "--reason", "the previous pool refused; the live Cursor low-fast model fits the mechanical task",
  ]);
  assert.equal(result.status, 0, result.stderr || JSON.stringify(result.output));
  assert.equal(result.output.unit.staffing.current.partner, "cursor");
  assert.equal(result.output.unit.staffing.current.model, "gpt-5.3-codex-low-fast");
  assert.equal(result.output.unit.staffing.current.effort, null);
  assert.equal(result.output.unit.staffing.history.length, 1);
  assert.equal(result.output.unit.staffing.history[0].checkpoint.receipt.status, "replied");
  assert.equal(existsSync(join(root, "worktree-one")), true);
});

const restaffArgs = (id, partner = "grok") => [
  "restaff", "--repo", repository, "--unit", id,
  "--lead", "claude", "--partner", partner, "--model", "CLI-default",
  "--effort", "high", "--reason", `${partner} is the proved replacement arena`,
];

test("restaff resumes when old pair end succeeds before its journal update", () => {
  const created = invoke(createArgs("restaff-after-end"));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  const failed = invoke(restaffArgs("restaff-after-end"), { FAKE_PAIR_FAIL_AFTER_END: "1" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output.reason, /forced failure after end/u);
  const stranded = invoke(["status", "--repo", repository, "--unit", "restaff-after-end"]);
  assert.equal(stranded.output.unit.lifecycle, "restaff-failed");
  assert.equal(stranded.output.unit.restaff_phase, "ending-old");
  assert.equal(stranded.output.unit.observed.pair.ok, false);

  const resumed = invoke(restaffArgs("restaff-after-end"));
  assert.equal(resumed.status, 0, resumed.stderr || JSON.stringify(resumed.output));
  assert.equal(resumed.output.resumed_from, "restaff-failed");
  assert.equal(resumed.output.unit.staffing.history.length, 1);
  assert.equal(resumed.output.unit.pair.latest_seq, 1);
});

test("restaff resumes after replacement init fails", () => {
  const created = invoke(createArgs("restaff-init-failed"));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  const failed = invoke(restaffArgs("restaff-init-failed"), { FAKE_PAIR_FAIL_INIT_PARTNER: "grok" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output.reason, /forced init failure/u);
  const stranded = invoke(["status", "--repo", repository, "--unit", "restaff-init-failed"]);
  assert.equal(stranded.output.unit.lifecycle, "restaff-failed");
  assert.equal(stranded.output.unit.restaff_phase, "initializing-target");
  assert.equal(stranded.output.unit.pending_staffing.partner, "grok");
  assert.equal(stranded.output.unit.staffing.history.length, 1);
  assert.equal(stranded.output.unit.observed.pair.ok, false);

  const resumed = invoke(restaffArgs("restaff-init-failed"));
  assert.equal(resumed.status, 0, resumed.stderr || JSON.stringify(resumed.output));
  assert.equal(resumed.output.status, "restaffed");
  assert.equal(resumed.output.resumed_from, "restaff-failed");
  assert.equal(resumed.output.unit.staffing.current.partner, "grok");
  assert.equal(resumed.output.unit.staffing.history.length, 1);
  assert.equal(resumed.output.unit.pair.latest_seq, 1);
});

test("restaff adopts a replacement initialized before its journal update", () => {
  const id = "restaff-init-live";
  const created = invoke(createArgs(id));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  const failed = invoke(restaffArgs(id), { FAKE_PAIR_BAD_INIT_RESPONSE_PARTNER: "grok" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output.reason, /does not match pending staffing/u);
  const stranded = invoke(["status", "--repo", repository, "--unit", id]);
  assert.equal(stranded.output.unit.restaff_phase, "initializing-target");
  assert.equal(stranded.output.unit.observed.pair.partner, "grok");
  assert.equal(stranded.output.unit.observed.pair.seq, 0);

  const resumed = invoke(restaffArgs(id));
  assert.equal(resumed.status, 0, resumed.stderr || JSON.stringify(resumed.output));
  assert.equal(resumed.output.resumed_from, "restaff-failed");
  assert.equal(resumed.output.unit.pair.latest_seq, 1);
  assert.equal(resumed.output.unit.staffing.history.length, 1);
});

test("restaff resumes a replacement pair initialized before send", () => {
  const created = invoke(createArgs("restaff-after-init"));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  const failed = invoke(restaffArgs("restaff-after-init"), { FAKE_PAIR_FAIL_SEND_PARTNER: "grok" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output.reason, /forced send failure/u);
  const stranded = invoke(["status", "--repo", repository, "--unit", "restaff-after-init"]);
  assert.equal(stranded.output.unit.observed.pair.partner, "grok");
  assert.equal(stranded.output.unit.observed.pair.seq, 0);

  const resumed = invoke(restaffArgs("restaff-after-init"));
  assert.equal(resumed.status, 0, resumed.stderr || JSON.stringify(resumed.output));
  assert.equal(resumed.output.resumed_from, "restaff-failed");
  assert.equal(resumed.output.unit.pair.latest_seq, 1);
  assert.equal(resumed.output.unit.staffing.history.length, 1);
});

test("restaff resumes after the first replacement send started", () => {
  const created = invoke(createArgs("restaff-after-send"));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  const failed = invoke(restaffArgs("restaff-after-send"), { FAKE_PAIR_BAD_SEND_AFTER_START: "grok" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output.reason, /pair send did not start/u);
  const stranded = invoke(["status", "--repo", repository, "--unit", "restaff-after-send"]);
  assert.equal(stranded.output.unit.observed.pair.seq, 1);

  const resumed = invoke(restaffArgs("restaff-after-send"));
  assert.equal(resumed.status, 0, resumed.stderr || JSON.stringify(resumed.output));
  assert.equal(resumed.output.resumed_from, "restaff-failed");
  assert.equal(resumed.output.unit.pair.latest_seq, 1);
  assert.equal(resumed.output.unit.staffing.history.length, 1);
});

test("restaff recovery refuses a different pending target field", () => {
  const created = invoke(createArgs("restaff-mismatch"));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  const failed = invoke(restaffArgs("restaff-mismatch"), { FAKE_PAIR_FAIL_INIT_PARTNER: "grok" });
  assert.notEqual(failed.status, 0);
  const changed = restaffArgs("restaff-mismatch");
  changed[changed.indexOf("--reason") + 1] = "a different retry reason";
  const refused = invoke(changed);
  assert.notEqual(refused.status, 0);
  assert.match(refused.output.reason, /reason differs/u);
  const resumed = invoke(restaffArgs("restaff-mismatch"));
  assert.equal(resumed.status, 0, resumed.stderr || JSON.stringify(resumed.output));
  assert.equal(resumed.output.unit.staffing.history.length, 1);
});

test("restaff recovery claims the first target for a legacy failed record", () => {
  const id = "restaff-legacy";
  const created = invoke(createArgs(id));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  writeFileSync(join(root, `worktree-${id}`, "preserved.txt"), "preserved\n");
  const failed = invoke(restaffArgs(id), { FAKE_PAIR_FAIL_INIT_PARTNER: "grok" });
  assert.notEqual(failed.status, 0);

  const common = git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const path = join(common, "orchestrate", "units", `${id}.json`);
  const record = JSON.parse(readFileSync(path, "utf8"));
  delete record.pending_staffing;
  delete record.staffing.history[0].checkpoint.worktree_status;
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);

  const resumed = invoke(restaffArgs(id));
  assert.equal(resumed.status, 0, resumed.stderr || JSON.stringify(resumed.output));
  assert.equal(resumed.output.resumed_from, "restaff-failed");
  assert.equal(resumed.output.unit.staffing.history.length, 1);
  assert.equal(resumed.output.unit.staffing.current.partner, "grok");
  assert.match(resumed.output.unit.staffing.history[0].checkpoint.worktree_status, /preserved\.txt/u);
});

test("legacy restaff recovery adopts a live target with a stale recorded sid", () => {
  const cases = [
    ["restaff-legacy-live-zero", { FAKE_PAIR_BAD_INIT_RESPONSE_PARTNER: "grok" }],
    ["restaff-legacy-live-one", { FAKE_PAIR_BAD_SEND_AFTER_START: "grok" }],
  ];
  for (const [id, environment] of cases) {
    const created = invoke(createArgs(id));
    assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
    const oldSid = created.output.unit.pair.sid;
    const failed = invoke(restaffArgs(id), environment);
    assert.notEqual(failed.status, 0);

    const common = git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const path = join(common, "orchestrate", "units", `${id}.json`);
    const record = JSON.parse(readFileSync(path, "utf8"));
    delete record.pending_staffing;
    delete record.restaff_phase;
    record.resources.pair = true;
    record.pair = { sid: oldSid, latest_seq: 1 };
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);

    const before = invoke(["status", "--repo", repository, "--unit", id]);
    assert.notEqual(before.status, 0);
    assert.match(before.output.reason, /pair (sid|staffing) differs/u);

    const resumed = invoke(restaffArgs(id));
    assert.equal(resumed.status, 0, resumed.stderr || JSON.stringify(resumed.output));
    assert.equal(resumed.output.resumed_from, "restaff-failed");
    assert.equal(resumed.output.unit.staffing.current.partner, "grok");
    assert.equal(resumed.output.unit.pair.latest_seq, 1);
    assert.equal(resumed.output.unit.staffing.history.length, 1);
  }
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

test("setup rollback uses the recorded resolved worktree path", () => {
  const aliasRoot = join(root, "symlink-parent");
  symlinkSync(root, aliasRoot);
  const args = createArgs("symlink-rollback", "codex", "exit 7");
  args[args.indexOf("--worktree") + 1] = join(aliasRoot, "worktree-symlink-rollback");
  const failed = invoke(args);
  assert.notEqual(failed.status, 0);
  assert.match(failed.output.reason, /unit setup/u);
  assert.equal(existsSync(join(root, "worktree-symlink-rollback")), false);
  assert.equal(git(repository, "branch", "--list", "feat/symlink-rollback"), "");
});

test("a timed-out setup kills its complete process group", async () => {
  const pidFile = join(root, "timed-out-setup-child.pid");
  const args = createArgs(
    "setup-timeout-tree",
    "codex",
    `sleep 999 & echo $! > ${JSON.stringify(pidFile)}; wait`,
  );
  const failed = invoke(args, { ORCHESTRATE_LONG_COMMAND_TIMEOUT_MS: "100" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output.reason, /timed out|ETIMEDOUT/u);
  const childPid = Number(readFileSync(pidFile, "utf8").trim());
  await new Promise((resolve) => setTimeout(resolve, 100));
  let alive = true;
  try { process.kill(childPid, 0); } catch (error) { alive = error?.code === "EPERM"; }
  if (alive) {
    try { process.kill(childPid, "SIGKILL"); } catch {}
  }
  assert.equal(alive, false, `setup grandchild ${childPid} survived its timeout`);
});

test("an overflowing setup kills its complete process group", async () => {
  const pidFile = join(root, "overflowing-setup-child.pid");
  const args = createArgs(
    "setup-buffer-tree",
    "codex",
    `sleep 999 & echo $! > ${JSON.stringify(pidFile)}; yes x`,
  );
  const failed = invoke(args, { ORCHESTRATE_MAX_BUFFER_BYTES: "1024" });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output.reason, /ENOBUFS|maxBuffer/u);
  const childPid = Number(readFileSync(pidFile, "utf8").trim());
  await new Promise((resolve) => setTimeout(resolve, 100));
  let alive = true;
  try { process.kill(childPid, 0); } catch (error) { alive = error?.code === "EPERM"; }
  if (alive) {
    try { process.kill(childPid, "SIGKILL"); } catch {}
  }
  assert.equal(alive, false, `setup grandchild ${childPid} survived its buffer overflow`);
});

test("a missing command reports ENOENT without signaling the caller group", () => {
  const limitedBin = join(root, "missing-command-bin");
  mkdirSync(limitedBin);
  symlinkSync(process.execPath, join(limitedBin, "node"));
  symlinkSync("/usr/bin/git", join(limitedBin, "git"));
  symlinkSync(join(bin, "trash"), join(limitedBin, "trash"));
  const failed = invoke(
    createArgs("missing-setup-command", "codex", "exit 7"),
    { PATH: limitedBin },
  );
  assert.notEqual(failed.status, 0);
  assert.match(failed.output.reason, /spawnSync sh ENOENT/u);
  assert.equal(existsSync(join(root, "worktree-missing-setup-command")), false);
  assert.equal(git(repository, "branch", "--list", "feat/missing-setup-command"), "");
});

test("restaff keeps the send error when checkpoint cleanup also fails", () => {
  const created = invoke(createArgs("restaff-cleanup-error"));
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  const args = [
    "restaff", "--repo", repository, "--unit", "restaff-cleanup-error",
    "--lead", "claude", "--partner", "grok", "--model", "CLI-default",
    "--effort", "low", "--reason", "grok matches the bounded task and available pool",
  ];
  const failed = invoke(args, {
    FAKE_PAIR_FAIL_SEND_PARTNER: "grok",
    FAKE_TRASH_FAIL_MATCH: "restaff-restaff-cleanup-error",
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output.reason, /pair send failed: forced send failure for grok/u);
  assert.doesNotMatch(failed.output.reason, /trash/u);
  const registry = join(git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir"), "orchestrate");
  for (const name of readdirSync(registry)) {
    if (name.startsWith("restaff-restaff-cleanup-error-")) unlinkSync(join(registry, name));
  }
  const cleaned = invoke([
    "dismantle", "--repo", repository, "--unit", "restaff-cleanup-error",
    "--force", "restaff-cleanup-error",
  ]);
  assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
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
  assert.equal(
    readdirSync(registry).some((name) => name.startsWith("registry.lock.stale-") && name.includes(".trashed.")),
    true,
  );
  const cleaned = invoke(["dismantle", "--repo", repository, "--unit", "dead-lock", "--force", "dead-lock"]);
  assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
});

test("stale registry recovery gives one concurrent process the lock", async () => {
  const common = git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const lock = join(common, "orchestrate", "registry.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "owner.json"), `${JSON.stringify({ pid: 2147483647 })}\n`);
  const [first, second] = await Promise.all([
    invokeAsync(createArgs("lock-race-a", "codex", "sleep 0.4")),
    invokeAsync(createArgs("lock-race-b", "codex", "sleep 0.4")),
  ]);
  const succeeded = [first, second].filter((result) => result.status === 0);
  const refused = [first, second].filter((result) => result.status !== 0);
  assert.equal(succeeded.length, 1, JSON.stringify([first.output, second.output]));
  assert.equal(refused.length, 1, JSON.stringify([first.output, second.output]));
  assert.match(refused[0].output.reason, /registry (?:is busy|lock)/u);
  const id = succeeded[0].output.unit.unit_id;
  const cleaned = invoke(["dismantle", "--repo", repository, "--unit", id, "--force", id]);
  assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
});

test("dismantle normalizes a legacy record without resources or cleanup", () => {
  const record = writeRecoveryRecord("legacy-dismantle", "working", {
    withWorktree: true,
    withPair: true,
  });
  const path = join(record.common_git_dir, "orchestrate", "units", "legacy-dismantle.json");
  delete record.resources;
  delete record.cleanup;
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  const cleaned = invoke([
    "dismantle", "--repo", repository, "--unit", "legacy-dismantle",
    "--force", "legacy-dismantle",
  ]);
  assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
  assert.equal(existsSync(record.worktree), false);
  assert.equal(existsSync(path), false);
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
