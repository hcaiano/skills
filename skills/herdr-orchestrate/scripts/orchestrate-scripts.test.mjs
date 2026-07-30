import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Fake herdr/git/trash record every call into a state file so the tests can
// assert order and arguments without a live Herdr or repo.
const root = mkdtempSync(join(tmpdir(), "orchestrate-scripts-test-"));
const bin = join(root, "bin");
mkdirSync(bin);
const statePath = join(root, "state.json");
const here = new URL(".", import.meta.url).pathname;
const createUnit = join(here, "create-unit.mjs");
const dismantleUnit = join(here, "dismantle-unit.mjs");

const writeState = (state) => writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));

writeFileSync(
  join(bin, "herdr"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
state.calls.push(["herdr", ...args]);
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
const out = (result) => process.stdout.write(JSON.stringify({ result }) + "\\n");
const key = args.slice(0, 2).join(" ");
if (state.fail_on === key) { process.stderr.write("simulated " + key + " failure\\n"); process.exit(1); }
if (key === "tab create") {
  out(state.tab_create);
} else if (key === "agent start") {
  if (state.busy_starts > 0) {
    state.busy_starts -= 1;
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
    process.stderr.write("agent_pane_busy: pane has no available prompt\\n");
    process.exit(1);
  }
  out({ agent: { name: args[2] } });
} else if (key === "pane split") {
  out({ pane: { pane_id: args[2] + "s", tab_id: state.tab_create.tab.tab_id } });
} else if (key === "pane list") {
  out({ panes: state.panes });
} else if (key === "pane close" || key === "tab close") {
  out({});
} else { process.stderr.write("unsupported fake herdr: " + args.join(" ") + "\\n"); process.exit(1); }
`,
);
writeFileSync(
  join(bin, "git"),
  `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
state.calls.push(["git", ...args]);
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
const sub = args.filter((a) => a !== "-C" && !a.startsWith("/")).join(" ");
if (sub.startsWith("rev-parse")) { process.stdout.write(state.repo + "/.git\\n"); process.exit(0); }
if (state.git_fail && sub.startsWith(state.git_fail.cmd)) {
  process.stderr.write(state.git_fail.stderr + "\\n");
  process.exit(1);
}
process.exit(0);
`,
);
writeFileSync(join(bin, "trash"), `#!/usr/bin/env node
const fs = require("node:fs");
const statePath = process.env.FAKE_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
state.calls.push(["trash", ...process.argv.slice(2)]);
fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
process.exit(0);
`);
for (const name of ["herdr", "git", "trash"]) chmodSync(join(bin, name), 0o755);

const env = {
  ...process.env,
  FAKE_STATE: statePath,
  PATH: `${bin}:${process.env.PATH}`,
  CREATE_UNIT_BUSY_RETRY_MS: "10",
};
const runScript = (script, ...args) => {
  const r = execFileSync(process.execPath, [script, ...args], { encoding: "utf8", env });
  return JSON.parse(r);
};
const runScriptFail = (script, ...args) => {
  try {
    execFileSync(process.execPath, [script, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return JSON.parse(error.stdout);
  }
  throw new Error("expected the script to exit nonzero");
};

const baseState = () => ({
  calls: [],
  repo: "/repo",
  tab_create: {
    tab: { tab_id: "w1:t9" },
    root_pane: { pane_id: "w1:p9", tab_id: "w1:t9", workspace_id: "w1", cwd: "/repo/wt" },
  },
  panes: [{ pane_id: "w1:p9", tab_id: "w1:t9", agent: "claude" }],
});

const soloSpec = JSON.stringify({
  workspace: "w1",
  cwd: "/repo/wt",
  label: "#7 fix",
  lead: { name: "lead-7", args: ["--kind", "claude", "--", "--model", "opus", "--effort", "high"] },
});

test("create-unit provisions, verifies, and cleans up", () => {
  // Solo happy path: tab → lead in root pane → exactly one agent pane.
  writeState(baseState());
  const solo = runScript(createUnit, "--spec", soloSpec);
  assert.deepEqual(solo, { created: true, tab_id: "w1:t9", lead_pane: "w1:p9", peer_pane: null });
  const start = readState().calls.find((c) => c[1] === "agent" && c[2] === "start");
  assert.deepEqual(start.slice(3), ["lead-7", "--pane", "w1:p9", "--kind", "claude", "--", "--model", "opus", "--effort", "high"]);

  // Pair: split once, start peer, close the leftover shell pane.
  const pairState = baseState();
  pairState.panes = [
    { pane_id: "w1:p9", tab_id: "w1:t9", agent: "claude" },
    { pane_id: "w1:p9s", tab_id: "w1:t9", agent: "codex" },
    { pane_id: "w1:pX", tab_id: "w1:t9", agent: null },
  ];
  writeState(pairState);
  // After the leftover closes, the second pane list must show only agent panes.
  const spec = JSON.parse(soloSpec);
  spec.peer = { name: "peer-7", args: ["--kind", "codex"] };
  // The fake pane list is static, so emulate the close by pre-trimming on the
  // second call: instead, assert the close call happened and the script
  // failed the final count on the stale list — that is the fail-closed path.
  const outcome = runScriptFail(createUnit, "--spec", JSON.stringify(spec));
  assert.equal(outcome.created, false);
  assert.match(outcome.error, /exactly one live pane per agent/u);
  assert.equal(outcome.cleanup, "closed tab w1:t9");
  const calls = readState().calls.map((c) => c.slice(0, 3).join(" "));
  assert.ok(calls.includes("herdr pane close"), "leftover shell pane must be closed");
  assert.ok(calls.at(-1).startsWith("herdr tab close"), "failure must close the tab");

  // agent_pane_busy is an initialization race: retry bounded, then succeed.
  const busy = baseState();
  busy.busy_starts = 2;
  writeState(busy);
  const retried = runScript(createUnit, "--spec", soloSpec);
  assert.equal(retried.created, true);
  const starts = readState().calls.filter((c) => c[1] === "agent" && c[2] === "start");
  assert.equal(starts.length, 3, "two busy rejections then one successful start");

  // A pane that never frees exhausts the retries and still cleans up.
  const stuck = baseState();
  stuck.busy_starts = 999;
  writeState(stuck);
  const exhausted = runScriptFail(createUnit, "--spec", soloSpec);
  assert.match(exhausted.error, /agent_pane_busy/u);
  assert.equal(exhausted.cleanup, "closed tab w1:t9");

  // Wrong workspace fails before any agent starts, and closes the tab.
  const wrong = baseState();
  wrong.tab_create.root_pane.workspace_id = "w2";
  writeState(wrong);
  const mismatch = runScriptFail(createUnit, "--spec", soloSpec);
  assert.match(mismatch.error, /workspace w2, not the pinned w1/u);
  assert.ok(!readState().calls.some((c) => c[1] === "agent"), "no agent may start in the wrong workspace");
});

test("dismantle-unit removes in order and falls back", () => {
  // Happy path: worktree → branch both sides → aux → tab, in that order.
  writeState(baseState());
  const ok = runScript(dismantleUnit, "--worktree", "/repo/wt", "--branch", "feat/7", "--tab", "w1:t9", "--aux", "w1:t10");
  assert.equal(ok.dismantled, true);
  assert.deepEqual(ok.done.map((s) => s.step), ["worktree", "local-branch", "remote-branch", "aux", "tab"]);
  const calls = readState().calls;
  assert.deepEqual(calls.find((c) => c[0] === "git" && c.includes("worktree")).slice(-3), ["worktree", "remove", "/repo/wt"]);
  assert.deepEqual(calls.find((c) => c.includes("branch")).slice(-3), ["branch", "-D", "feat/7"]);
  assert.deepEqual(calls.find((c) => c.includes("push")).slice(-4), ["push", "origin", "--delete", "feat/7"]);
  assert.deepEqual(calls.at(-1), ["herdr", "tab", "close", "w1:t9"]);

  // Worktree remove fails → trash + prune fallback.
  const slow = baseState();
  slow.git_fail = { cmd: "worktree remove", stderr: "simulated timeout" };
  writeState(slow);
  const fallback = runScript(dismantleUnit, "--worktree", "/repo/wt", "--branch", "feat/7", "--tab", "w1:t9");
  assert.equal(fallback.done[0].via, "trash + prune");
  assert.ok(readState().calls.some((c) => c[0] === "trash"));

  // A branch already gone locally is tolerated, not fatal.
  const gone = baseState();
  gone.git_fail = { cmd: "branch -D", stderr: "error: branch 'feat/7' not found." };
  writeState(gone);
  const tolerant = runScript(dismantleUnit, "--worktree", "/repo/wt", "--branch", "feat/7", "--tab", "w1:t9");
  assert.equal(tolerant.dismantled, true);
  assert.equal(tolerant.done.find((s) => s.step === "local-branch").ok, false);

  // A real remote failure is a hard stop with a checkpoint.
  const push = baseState();
  push.git_fail = { cmd: "push", stderr: "error: failed to push (network)" };
  writeState(push);
  const failed = runScriptFail(dismantleUnit, "--worktree", "/repo/wt", "--branch", "feat/7", "--tab", "w1:t9");
  assert.equal(failed.failed_step, "remote-branch");
  assert.ok(failed.done.some((s) => s.step === "worktree"), "checkpoint must list what already happened");
});
