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
const herdrPairScript = join(root, "fake-herdr-pair.mjs");
const herdrStatePath = join(root, "fake-herdr-pair-state.json");
const herdrLogPath = join(root, "fake-herdr-pair-log.jsonl");
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

writeFileSync(herdrPairScript, `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const [command, ...args] = process.argv.slice(2);
const option = (name) => { const i = args.indexOf("--" + name); return i < 0 ? null : args[i + 1]; };
const statePath = process.env.FAKE_HERDR_PAIR_STATE;
const logPath = process.env.FAKE_HERDR_PAIR_LOG;
const read = () => existsSync(statePath)
  ? JSON.parse(readFileSync(statePath, "utf8"))
  : {counter:0,panes:{},sessions:{}};
const state = read();
const save = () => writeFileSync(statePath, JSON.stringify(state));
const emit = (value, code = 0) => { console.log(JSON.stringify(value)); process.exit(code); };
appendFileSync(logPath, JSON.stringify({command,args}) + "\\n");
if (command === "spawn") {
  if (process.env.FAKE_HERDR_PAIR_FAIL_SPAWN === "1") {
    console.error("forced Herdr spawn failure");
    process.exit(1);
  }
  const partner = option("partner");
  let pane = option("partner-pane");
  if (!pane || process.env.FAKE_HERDR_PAIR_DEAD_PANE === pane) {
    state.counter += 1;
    pane = "wH:p" + (state.counter + 1);
  }
  state.panes[pane] ??= {
    partner,
    repo_root:option("partner-repo-root"),
    model:option("model"),
    effort:option("effort"),
  };
  save();
  emit({
    self:{pane_id:option("pane"),agent:option("as")},
    partner:{pane_id:pane,agent:state.panes[pane].partner},
    partnerAgent:state.panes[pane].partner,
    partnerRepoRoot:state.panes[pane].repo_root,
    partnerRegisteredAt:"2026-08-21T12:00:00.000Z",
  });
}
if (command === "init") {
  const pane = option("partner-pane");
  const info = state.panes[pane];
  if (!info) emit({ok:false,reason:"unknown pane"}, 1);
  if (process.env.FAKE_HERDR_PAIR_FAIL_INIT === "1") {
    console.error("forced Herdr init failure");
    process.exit(1);
  }
  let session = Object.values(state.sessions).find((candidate) => candidate.participants[info.partner].pane_id === pane);
  if (!session) {
    const lead = option("as");
    const sid = "herdr-sid-" + pane;
    session = {
      sid,
      active:true,
      initiator:lead,
      role:option("role"),
      model:option("model"),
      effort:option("effort"),
      participants:{
        [lead]:{pane_id:option("pane"),terminal_id:option("terminal-id"),repo_root:option("repo-root")},
        [info.partner]:{pane_id:pane,repo_root:option("partner-repo-root"),registered_at:option("partner-registered-at")},
      },
      delivery:{next:{[lead]:0,[info.partner]:0},submitted:{[lead]:0,[info.partner]:0},received:{[lead]:0,[info.partner]:0},pending:{[lead]:null,[info.partner]:null}},
      last_status:{[lead]:null,[info.partner]:null},
      completed_cycles:0,
    };
    state.sessions[sid] = session;
    save();
  }
  emit(session);
}
if (command === "reconcile") {
  const session = state.sessions[option("sid")];
  if (!session) { console.error("no session with sid " + option("sid")); process.exit(1); }
  const partner = Object.keys(session.participants).find((kind) => kind !== option("as"));
  if (process.env.FAKE_HERDR_PAIR_DEAD_PANE === session.participants[partner].pane_id) {
    console.error("recorded partner pane " + session.participants[partner].pane_id + " is gone");
    process.exit(1);
  }
  emit({reconciled:[],cleared:null,session});
}
if (command === "send") {
  const session = state.sessions[option("sid")];
  if (!session) { console.error("no session"); process.exit(1); }
  const lead = option("as");
  session.delivery.next[lead] += 1;
  session.delivery.submitted[lead] = session.delivery.next[lead];
  const receipt = process.env.FAKE_HERDR_PAIR_RECEIPT || "acknowledged";
  const reservation = {
    seq:session.delivery.next[lead],
    kind:option("kind"),
    reserved_at:"2026-08-21T00:00:00.000Z",
    submitted_at:"2026-08-21T00:00:01.000Z",
  };
  if (receipt === "acknowledged") {
    session.delivery.received[lead] = session.delivery.next[lead];
    session.delivery.pending[lead] = null;
  } else {
    session.delivery.pending[lead] = reservation;
  }
  save();
  const partner = Object.keys(session.participants).find((kind) => kind !== lead);
  if (option("format") === "json") {
    emit({ok:true,sid:session.sid,from:lead,to:partner,kind:option("kind"),seq:session.delivery.next[lead],receipt,acknowledged:receipt === "acknowledged",reservation:session.delivery.pending[lead],submitted:session.delivery.submitted[lead],received:session.delivery.received[lead]});
  }
  console.log("[agent " + lead + " -> " + partner + " kind=" + option("kind") + " sid=" + session.sid + "] seq=" + session.delivery.next[lead] + " receipt=" + receipt);
  process.exit(0);
}
if (command === "repin") {
  const session = state.sessions[option("sid")];
  if (!session) { console.error("no session with sid " + option("sid")); process.exit(1); }
  const lead = option("as");
  const previous = session.participants[lead];
  if (previous.pane_id !== option("previous-pane") || previous.terminal_id !== option("previous-terminal-id")) {
    console.error("repin previous identity differs");
    process.exit(1);
  }
  session.participants[lead] = {pane_id:option("pane"),terminal_id:option("terminal-id"),repo_root:option("repo-root")};
  save();
  emit({ok:true,sid:session.sid,agent:lead,changed:true,previous,participant:session.participants[lead]});
}
if (command === "end") {
  const sid = option("sid");
  if (!state.sessions[sid]) { console.error("no session"); process.exit(1); }
  const session = state.sessions[sid];
  const partner = Object.keys(session.participants).find((kind) => kind !== option("as"));
  if (process.env.FAKE_HERDR_PAIR_DEAD_PANE === session.participants[partner].pane_id && option("stale") !== "true") {
    console.error("recorded partner pane " + session.participants[partner].pane_id + " is gone");
    process.exit(1);
  }
  delete state.sessions[sid];
  save();
  console.log("ended herdr-pair session " + sid);
  process.exit(0);
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
  HERDR_ENV: "0",
  PATH: `${bin}:${process.env.PATH}`,
  ORCHESTRATE_PAIR_SCRIPT: pairScript,
  ORCHESTRATE_HERDR_PAIR_SCRIPT: herdrPairScript,
  FAKE_HERDR_PAIR_STATE: herdrStatePath,
  FAKE_HERDR_PAIR_LOG: herdrLogPath,
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
const unitRecordPath = (id) => join(
  git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir"),
  "orchestrate",
  "units",
  `${id}.json`,
);
const readHerdrState = () => JSON.parse(readFileSync(herdrStatePath, "utf8"));
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
  "--setup", setup,
];
const herdrCreateArgs = (id, partner = "grok") => [
  ...createArgs(id, partner),
  "--pane", "wH:p1",
  "--workspace", "wH",
  "--tab-id", "wH:t1",
  "--as", "claude",
  "--terminal-id", "term-herdr-lead",
  "--repo-root", repository,
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
  const exclude = created.output.unit.delivery_setup.pr_body_exclude;
  assert.equal(exclude.pattern, "/PR_BODY.md");
  assert.equal(exclude.added_by_unit, true);
  assert.equal(
    readFileSync(exclude.path, "utf8").split(/\r?\n/u).filter((line) => line === "/PR_BODY.md").length,
    1,
  );
});

test("create refuses --merge-policy: every unit PR holds for Henrique's review", () => {
  const refused = invoke([...createArgs("merge-policy-refused"), "--merge-policy", "auto"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.output.reason, /--merge-policy is removed[\s\S]*holds for Henrique's review/u);
});

test("Herdr backend is recorded and routes the unit through pinned pair commands", () => {
  writeFileSync(herdrStatePath, JSON.stringify({ counter: 0, panes: {}, sessions: {} }));
  writeFileSync(herdrLogPath, "");
  const id = "herdr-route";
  const created = invoke(herdrCreateArgs(id), { HERDR_ENV: "1" });
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  assert.equal(created.output.unit.backend, "herdr");
  assert.equal(created.output.unit.caller.pane, "wH:p1");
  assert.equal(created.output.unit.observed.pair.backend, "herdr");
  assert.equal(created.output.unit.observed.pair.partner, "grok");
  assert.equal(created.output.unit.observed.pair.seq, 1);
  assert.equal(created.output.unit.observed.pair.acknowledged_seq, 1);
  assert.equal(created.output.unit.observed.pair.session_active, true);
  assert.equal(created.output.unit.pair.delivery_receipt, "acknowledged");
  assert.match(created.output.unit.pair.partner_pane, /^wH:p/u);

  const observed = invoke(
    ["status", "--repo", repository, "--unit", id],
    { HERDR_ENV: "1" },
  );
  assert.equal(observed.status, 0, observed.stderr || JSON.stringify(observed.output));
  assert.equal(observed.output.unit.observed.pair.in_flight, null);

  const restaffed = invoke(restaffArgs(id, "codex"), { HERDR_ENV: "1" });
  assert.equal(restaffed.status, 0, restaffed.stderr || JSON.stringify(restaffed.output));
  assert.equal(restaffed.output.unit.backend, "herdr");
  assert.equal(restaffed.output.unit.staffing.current.partner, "codex");
  assert.equal(
    restaffed.output.unit.staffing.history[0].checkpoint.receipt.backend,
    "herdr",
  );

  const dismantled = invoke(
    ["dismantle", "--repo", repository, "--unit", id, "--force", id],
    { HERDR_ENV: "1" },
  );
  assert.equal(dismantled.status, 0, dismantled.stderr || JSON.stringify(dismantled.output));
  const pairCleanup = dismantled.output.done.find((entry) => entry.step === "pair");
  assert.equal(pairCleanup.detail.backend, "herdr");
  assert.equal(pairCleanup.detail.pane_close, "manual");

  const calls = readFileSync(herdrLogPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    [...new Set(calls.map((entry) => entry.command))].sort(),
    ["end", "init", "reconcile", "send", "spawn"],
  );
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf("--pane") + 1], "wH:p1");
    assert.equal(call.args[call.args.indexOf("--workspace") + 1], "wH");
    assert.equal(call.args[call.args.indexOf("--tab-id") + 1], "wH:t1");
    assert.equal(call.args[call.args.indexOf("--terminal-id") + 1], "term-herdr-lead");
    assert.equal(call.args[call.args.indexOf("--repo-root") + 1], repository);
  }
  const spawnCalls = calls.filter((entry) => entry.command === "spawn");
  assert.equal(spawnCalls.length, 2);
  assert.equal(
    spawnCalls[0].args[spawnCalls[0].args.indexOf("--partner-repo-root") + 1],
    join(root, `worktree-${id}`),
  );
  assert.equal(spawnCalls[0].args.includes("--autonomy"), true);
  const initCall = calls.find((entry) => entry.command === "init");
  assert.equal(
    initCall.args[initCall.args.indexOf("--partner-registered-at") + 1],
    "2026-08-21T12:00:00.000Z",
  );
  const sendCall = calls.find((entry) => entry.command === "send");
  assert.equal(sendCall.args.includes("--background"), false);
  assert.equal(sendCall.args[sendCall.args.indexOf("--format") + 1], "json");
});

test("create falls back to a local base when origin lacks that branch", () => {
  git(repository, "branch", "local-only-base", "main");
  const id = "local-only-base";
  const args = createArgs(id);
  args[args.indexOf("--base") + 1] = "local-only-base";

  const created = invoke(args);

  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  assert.equal(
    git(join(root, `worktree-${id}`), "rev-parse", "HEAD"),
    git(repository, "rev-parse", "local-only-base"),
  );
  const cleaned = invoke(["dismantle", "--repo", repository, "--unit", id, "--force", id]);
  assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
  git(repository, "branch", "-D", "local-only-base");

  const missingId = "missing-base";
  const missingArgs = createArgs(missingId);
  missingArgs[missingArgs.indexOf("--base") + 1] = "missing-locally-and-remotely";
  const missing = invoke(missingArgs);
  assert.notEqual(missing.status, 0);
  assert.match(missing.output.reason, /does not exist at origin or locally/u);
});

test("forced dismantle skips the remote branch when origin is absent", () => {
  const localRepository = join(root, "repository-without-origin");
  mkdirSync(localRepository);
  execFileSync("git", ["init", "-b", "main", localRepository]);
  git(localRepository, "config", "user.name", "Orchestrate Test");
  git(localRepository, "config", "user.email", "orchestrate@example.test");
  writeFileSync(join(localRepository, "README.md"), "# local only\n");
  git(localRepository, "add", "README.md");
  git(localRepository, "commit", "-m", "initial");

  const id = "no-origin-cleanup";
  const args = createArgs(id);
  args[args.indexOf("--repo") + 1] = localRepository;
  const created = invoke(args);
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));

  const cleaned = invoke([
    "dismantle", "--repo", localRepository, "--unit", id, "--force", id,
  ]);

  assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
  const remoteBranch = cleaned.output.done.find((entry) => entry.step === "remote-branch");
  assert.equal(remoteBranch.ok, true);
  assert.equal(remoteBranch.detail.skipped, "origin remote is not configured");
});

test("an explicit backend overrides Herdr auto-detection", () => {
  const id = "headless-override";
  const args = [...createArgs(id, "grok"), "--backend", "headless"];
  const created = invoke(args, { HERDR_ENV: "1" });
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  assert.equal(created.output.unit.backend, "headless");
  const cleaned = invoke(
    ["dismantle", "--repo", repository, "--unit", id, "--force", id],
    { HERDR_ENV: "1" },
  );
  assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
});

test("a Herdr spawn failure rolls back the unit journal", () => {
  const id = "herdr-spawn-fail";
  const failed = invoke(herdrCreateArgs(id), {
    HERDR_ENV: "1",
    FAKE_HERDR_PAIR_FAIL_SPAWN: "1",
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output.reason, /spawn failure/u);
  assert.equal(existsSync(join(root, `worktree-${id}`)), false);
  assert.notEqual(
    spawnSync("git", ["-C", repository, "show-ref", "--verify", "--quiet", `refs/heads/feat/${id}`]).status,
    0,
  );
  const common = git(repository, "rev-parse", "--path-format=absolute", "--git-common-dir");
  assert.equal(existsSync(join(common, "orchestrate", "units", `${id}.json`)), false);
});

test("a non-acknowledged Herdr send stays starting with its reservation journaled", () => {
  writeFileSync(herdrStatePath, JSON.stringify({ counter: 0, panes: {}, sessions: {} }));
  writeFileSync(herdrLogPath, "");
  const id = "herdr-lost-send";
  const failed = invoke(herdrCreateArgs(id), {
    HERDR_ENV: "1",
    FAKE_HERDR_PAIR_RECEIPT: "lost-partner-idle-inspect-that-pane-then-reconcile",
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output.reason, /not acknowledged/u);
  assert.match(failed.output.reason, /lost-partner-idle/u);
  const record = JSON.parse(readFileSync(unitRecordPath(id), "utf8"));
  assert.equal(record.lifecycle, "starting");
  assert.equal(record.pair.latest_seq, 1);
  assert.equal(record.pair.delivery_receipt, "lost-partner-idle-inspect-that-pane-then-reconcile");
  assert.equal(record.pair.delivery_reservation.seq, 1);
  assert.equal(Object.hasOwn(record.pair, "latest_receipt_file"), false);

  const state = readHerdrState();
  const session = Object.values(state.sessions)[0];
  session.delivery.pending.claude = null;
  writeFileSync(herdrStatePath, JSON.stringify(state));
  const resumed = invoke(herdrCreateArgs(id), { HERDR_ENV: "1" });
  assert.equal(resumed.status, 0, resumed.stderr || JSON.stringify(resumed.output));
  assert.equal(resumed.output.unit.lifecycle, "working");
  assert.equal(resumed.output.unit.pair.latest_seq, 2);
  const cleaned = invoke(
    ["dismantle", "--repo", repository, "--unit", id, "--force", id],
    { HERDR_ENV: "1" },
  );
  assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
});

test("a Herdr spawn followed by init failure keeps the pane for forced dismantle", () => {
  writeFileSync(herdrStatePath, JSON.stringify({ counter: 0, panes: {}, sessions: {} }));
  writeFileSync(herdrLogPath, "");
  const id = "herdr-init-fail";
  const failed = invoke(herdrCreateArgs(id), {
    HERDR_ENV: "1",
    FAKE_HERDR_PAIR_FAIL_INIT: "1",
  });
  assert.notEqual(failed.status, 0);
  assert.match(failed.output.reason, /init failure/u);
  const record = JSON.parse(readFileSync(unitRecordPath(id), "utf8"));
  assert.equal(record.resources.pair, false);
  assert.match(record.pair.partner_pane, /^wH:p/u);

  const cleaned = invoke(
    ["dismantle", "--repo", repository, "--unit", id, "--force", id],
    { HERDR_ENV: "1" },
  );
  assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
  const pairCleanup = cleaned.output.done.find((entry) => entry.step === "pair");
  assert.equal(pairCleanup.detail.session, "not-initialized");
  assert.equal(pairCleanup.detail.partner_pane, record.pair.partner_pane);
});

test("restaff and forced dismantle recover stale Herdr sessions", () => {
  for (const action of ["restaff", "dismantle"]) {
    writeFileSync(herdrStatePath, JSON.stringify({ counter: 0, panes: {}, sessions: {} }));
    writeFileSync(herdrLogPath, "");
    const id = `herdr-stale-${action}`;
    const created = invoke(herdrCreateArgs(id), { HERDR_ENV: "1" });
    assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
    const deadPane = created.output.unit.pair.partner_pane;
    if (action === "restaff") {
      const restaffed = invoke(restaffArgs(id, "codex"), {
        HERDR_ENV: "1",
        FAKE_HERDR_PAIR_DEAD_PANE: deadPane,
      });
      assert.equal(restaffed.status, 0, restaffed.stderr || JSON.stringify(restaffed.output));
      assert.equal(restaffed.output.unit.staffing.current.partner, "codex");
      assert.equal(restaffed.output.unit.transport_recovery.at(-1).status, "ended-stale");
      const cleaned = invoke(
        ["dismantle", "--repo", repository, "--unit", id, "--force", id],
        { HERDR_ENV: "1" },
      );
      assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
    } else {
      const cleaned = invoke(
        ["dismantle", "--repo", repository, "--unit", id, "--force", id],
        { HERDR_ENV: "1", FAKE_HERDR_PAIR_DEAD_PANE: deadPane },
      );
      assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
      const pairCleanup = cleaned.output.done.find((entry) => entry.step === "pair");
      assert.equal(pairCleanup.detail.recovery.status, "ended-stale");
    }
    const calls = readFileSync(herdrLogPath, "utf8").trim().split("\n").map(JSON.parse);
    const staleEnd = calls.find(
      (entry) => entry.command === "end" && entry.args.includes("--stale"),
    );
    assert.equal(staleEnd.args[staleEnd.args.indexOf("--stale") + 1], "true");
  }
});

test("repin journals a fresh Herdr caller identity", () => {
  writeFileSync(herdrStatePath, JSON.stringify({ counter: 0, panes: {}, sessions: {} }));
  writeFileSync(herdrLogPath, "");
  const id = "herdr-repin";
  const created = invoke(herdrCreateArgs(id), { HERDR_ENV: "1" });
  assert.equal(created.status, 0, created.stderr || JSON.stringify(created.output));
  const repinned = invoke([
    "repin", "--repo", repository, "--unit", id,
    "--pane", "wH:p1", "--workspace", "wH", "--tab-id", "wH:t1",
    "--as", "claude", "--terminal-id", "term-herdr-lead-2",
    "--repo-root", repository,
  ], { HERDR_ENV: "1" });
  assert.equal(repinned.status, 0, repinned.stderr || JSON.stringify(repinned.output));
  assert.equal(repinned.output.unit.caller.terminal_id, "term-herdr-lead-2");
  assert.equal(repinned.output.unit.caller_history.at(-1).status, "repinned");
  assert.equal(repinned.output.transport.changed, true);
  const cleaned = invoke(
    ["dismantle", "--repo", repository, "--unit", id, "--force", id],
    { HERDR_ENV: "1" },
  );
  assert.equal(cleaned.status, 0, cleaned.stderr || JSON.stringify(cleaned.output));
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

test("create preserves marked task addenda and keeps PR_BODY excluded once", () => {
  const id = "recover-addendum";
  const record = writeRecoveryRecord(id, "setting-up", { withWorktree: true });
  mkdirSync(dirname(record.task_file), { recursive: true });
  const addendum = `${record.task}\n\n## Addendum — 2026-08-21T12:00:00Z\nReread this recovery constraint.\n`;
  writeFileSync(record.task_file, addendum);

  const resumed = invoke(resumeArgs(id));
  assert.equal(resumed.status, 0, resumed.stderr || JSON.stringify(resumed.output));
  assert.equal(readFileSync(record.task_file, "utf8"), addendum);
  const exclude = resumed.output.unit.delivery_setup.pr_body_exclude;
  assert.equal(
    readFileSync(exclude.path, "utf8").split(/\r?\n/u).filter((line) => line === "/PR_BODY.md").length,
    1,
  );

  const cleaned = invoke(["dismantle", "--repo", repository, "--unit", id, "--force", id]);
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
  assert.match(failed.output.reason, /pair send was not acknowledged/u);
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
