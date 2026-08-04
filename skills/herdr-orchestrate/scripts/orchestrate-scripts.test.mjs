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
} else if (key === "pane report-metadata") {
  out({});
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
  assert.deepEqual(solo, { created: true, tab_id: "w1:t9", lead_pane: "w1:p9", peer_pane: null, tokens: {} });
  const start = readState().calls.find((c) => c[1] === "agent" && c[2] === "start");
  assert.deepEqual(start.slice(3), ["lead-7", "--pane", "w1:p9", "--kind", "claude", "--", "--model", "opus", "--effort", "high"]);
  // Without spec.unit nothing is tagged and no unit env is injected, so an
  // existing caller keeps its exact previous behaviour.
  const plainCalls = readState().calls;
  assert.equal(plainCalls.some((c) => c[2] === "report-metadata"), false);
  assert.equal(plainCalls.find((c) => c[1] === "tab" && c[2] === "create").includes("--env"), false);

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

test("create-unit tags panes and injects unit env when spec.unit is given", () => {
  const unitSpec = (extra = {}) =>
    JSON.stringify({ ...JSON.parse(soloSpec), unit: "7", report_pane: "w1:pO", ...extra });

  // Tokens are what a later survey reads, so the pane list must carry them
  // back before the script reports success.
  const tagged = baseState();
  tagged.panes = [
    { pane_id: "w1:p9", tab_id: "w1:t9", agent: "claude", tokens: { unit: "7", role: "lead", report_pane: "w1:pO" } },
  ];
  writeState(tagged);
  const created = runScript(createUnit, "--spec", unitSpec());
  assert.deepEqual(created.tokens, { "w1:p9": { unit: "7", role: "lead", report_pane: "w1:pO" } });

  const calls = readState().calls;
  const tabCreate = calls.find((c) => c[1] === "tab" && c[2] === "create");
  assert.ok(tabCreate.includes("HERDR_UNIT=7"), "the tab must carry the unit id");
  assert.ok(tabCreate.includes("HERDR_UNIT_WORKSPACE=w1"), "the tab must carry the pinned workspace");
  assert.ok(tabCreate.includes("HERDR_UNIT_REPORT_PANE=w1:pO"), "the tab must carry the report pane");
  const tag = calls.find((c) => c[2] === "report-metadata");
  assert.deepEqual(tag.slice(3), [
    "w1:p9", "--source", "herdr-orchestrate",
    "--token", "unit=7", "--token", "role=lead", "--token", "report_pane=w1:pO",
  ]);

  // A split pane does NOT inherit the tab's env (measured against herdr
  // 0.8.0), so the peer must be given the same --env explicitly or its
  // delegate loses the report pane.
  const pair = baseState();
  const peerTokens = { unit: "7", role: "peer", report_pane: "w1:pO" };
  pair.panes = [
    { pane_id: "w1:p9", tab_id: "w1:t9", agent: "claude", tokens: { unit: "7", role: "lead", report_pane: "w1:pO" } },
    { pane_id: "w1:p9s", tab_id: "w1:t9", agent: "codex", tokens: peerTokens },
  ];
  writeState(pair);
  const paired = runScript(createUnit, "--spec", unitSpec({ peer: { name: "peer-7", args: ["--kind", "codex"] } }));
  assert.deepEqual(paired.tokens["w1:p9s"], peerTokens);
  const split = readState().calls.find((c) => c[1] === "pane" && c[2] === "split");
  for (const entry of ["HERDR_UNIT=7", "HERDR_UNIT_WORKSPACE=w1", "HERDR_UNIT_REPORT_PANE=w1:pO"]) {
    assert.ok(split.includes(entry), `the peer split must carry ${entry}`);
  }
  const peerTag = readState().calls.filter((c) => c[2] === "report-metadata").at(-1);
  assert.ok(peerTag.includes("role=peer"), "the peer pane must be tagged as peer");

  // A tag that does not stick makes the unit invisible to discovery, so it
  // must fail loudly rather than report a provisioned unit.
  const untagged = baseState();
  untagged.panes = [{ pane_id: "w1:p9", tab_id: "w1:t9", agent: "claude" }];
  writeState(untagged);
  const lost = runScriptFail(createUnit, "--spec", unitSpec());
  assert.match(lost.error, /did not keep its unit\/role\/report_pane tokens/u);
  assert.equal(lost.cleanup, "closed tab w1:t9");

  // Losing only report_pane is the quiet failure: unit and role still read
  // fine while the delegate's milestones would reach nobody.
  const noReport = baseState();
  noReport.panes = [{ pane_id: "w1:p9", tab_id: "w1:t9", agent: "claude", tokens: { unit: "7", role: "lead" } }];
  writeState(noReport);
  const droppedReport = runScriptFail(createUnit, "--spec", unitSpec());
  assert.match(droppedReport.error, /did not keep its unit\/role\/report_pane tokens/u);

  // `0` is a real unit key, not an absent one.
  const zero = baseState();
  zero.panes = [{ pane_id: "w1:p9", tab_id: "w1:t9", agent: "claude", tokens: { unit: "0", role: "lead" } }];
  writeState(zero);
  const zeroUnit = runScript(
    createUnit,
    "--spec",
    JSON.stringify({ ...JSON.parse(soloSpec), unit: 0 }),
  );
  assert.deepEqual(zeroUnit.tokens, { "w1:p9": { unit: "0", role: "lead" } });
  assert.ok(
    readState().calls.find((c) => c[1] === "tab" && c[2] === "create").includes("HERDR_UNIT=0"),
    "unit 0 must still be injected",
  );

  // A unit key that cannot be matched back exactly is refused up front.
  writeState(baseState());
  const bad = runScriptFail(createUnit, "--spec", unitSpec({ unit: "#7 fix" }));
  assert.match(bad.error, /must match/u);
  assert.equal(readState().calls.length, 0, "a rejected spec must not touch Herdr");

  // A report pane with no unit has nothing to tag, and is a caller mistake.
  writeState(baseState());
  const orphan = runScriptFail(
    createUnit,
    "--spec",
    JSON.stringify({ ...JSON.parse(soloSpec), report_pane: "w1:pO" }),
  );
  assert.match(orphan.error, /report_pane requires spec.unit/u);
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
