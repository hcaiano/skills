#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const helper = join(directory, "herdr-pair.mjs");
const root = mkdtempSync(join(tmpdir(), "herdr-pair-test-"));
const home = join(root, "home");
const bin = join(root, "bin");
const statePath = join(root, "herdr-state.json");
const fakeHerdr = join(bin, "herdr");

mkdirSync(home, { recursive: true });
mkdirSync(bin, { recursive: true });

const panes = {
  "w1:p1": {
    agent: "codex",
    agent_status: "working",
    cwd: "/workspace",
    pane_id: "w1:p1",
    tab_id: "w1:t1",
    workspace_id: "w1",
  },
  "w1:p2": {
    agent: "claude",
    agent_status: "idle",
    cwd: "/workspace",
    pane_id: "w1:p2",
    tab_id: "w1:t1",
    workspace_id: "w1",
  },
};
writeFileSync(statePath, `${JSON.stringify({ panes, last_message: "", auto_ack: true }, null, 2)}\n`);

writeFileSync(
  fakeHerdr,
  `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const statePath = process.env.FAKE_HERDR_STATE;
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n");
state.call_count = (state.call_count || 0) + 1;
save();
const output = (result) => process.stdout.write(JSON.stringify({ result }) + "\\n");
const flushAck = () => {
  const ack = state.pending_ack;
  if (!ack || fs.existsSync(ack.sessionPath + ".lock")) return;
  const session = JSON.parse(fs.readFileSync(ack.sessionPath, "utf8"));
  session.delivery.received[ack.sender] = ack.sequence;
  fs.writeFileSync(ack.sessionPath, JSON.stringify(session, null, 2) + "\\n");
  delete state.pending_ack;
  save();
};
flushAck();
if (args[0] === "pane" && args[1] === "get") output({ pane: state.panes[args[2]] });
else if (args[0] === "pane" && args[1] === "list") output({ panes: Object.values(state.panes) });
else if (args[0] === "pane" && args[1] === "send-text") {
  state.last_message = args[3]; save(); output({});
} else if (args[0] === "pane" && args[1] === "send-keys") {
  const pane = state.panes[args[2]];
  pane.agent_status = "working";
  const control = state.last_message.match(/\\[herdr-pair control seq=(\\d+): run node .*? receive --sid \\"?([^\\" ]+)\\"? --from \\"?([^\\" ]+)\\"? --seq (\\d+)/);
  if (control && state.auto_ack !== false) {
    const sender = control[3];
    const sequence = Number(control[4]);
    const slug = pane.tab_id.replaceAll(":", "_");
    const sessionPath = path.join(process.env.HOME, ".herdr-coworkers", pane.workspace_id, slug, "session.json");
    state.pending_ack = { sender, sequence, sessionPath };
  }
  save();
  if (state.fail_after_enter === true) {
    process.stderr.write("simulated interruption after Enter\\n");
    process.exit(1);
  }
  output({});
} else if (args[0] === "pane" && args[1] === "read") process.stdout.write("");
else { process.stderr.write("unsupported fake herdr args: " + args.join(" ") + "\\n"); process.exit(1); }
`,
);
chmodSync(fakeHerdr, 0o755);

const env = {
  ...process.env,
  FAKE_HERDR_STATE: statePath,
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p1",
  HOME: home,
  PATH: `${bin}:${process.env.PATH}`,
};
const runAs = (paneId, ...args) =>
  execFileSync(process.execPath, [helper, ...args], {
    encoding: "utf8",
    env: { ...env, HERDR_PANE_ID: paneId },
  });
const runAsWithEnv = (paneId, overrides, ...args) =>
  execFileSync(process.execPath, [helper, ...args], {
    encoding: "utf8",
    env: { ...env, ...overrides, HERDR_PANE_ID: paneId },
  });
const runAsyncWithEnv = (paneId, overrides, ...args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...args], {
      env: { ...env, ...overrides, HERDR_PANE_ID: paneId },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `helper exited ${code}`));
    });
  });
const runAsync = (paneId, ...args) => runAsyncWithEnv(paneId, {}, ...args);
const run = (...args) => runAs("w1:p1", ...args);
const sessionPath = join(home, ".herdr-coworkers", "w1", "w1_t1", "session.json");

try {
  const created = JSON.parse(run("init"));
  assert.equal(created.schema_version, 2);
  assert.equal(created.active, true);
  assert.equal(created.round, 0);

  const resumed = JSON.parse(run("init"));
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.sid, created.sid);

  const beforeDelayedAck = JSON.parse(readFileSync(sessionPath, "utf8"));
  beforeDelayedAck.delivery.next.claude = 1;
  writeFileSync(sessionPath, `${JSON.stringify(beforeDelayedAck, null, 2)}\n`);
  const ackLock = `${sessionPath}.lock`;
  mkdirSync(ackLock);
  writeFileSync(
    join(ackLock, "owner.json"),
    `${JSON.stringify({
      pid: process.pid,
      token: "hold-ack-for-session-replacement",
      process_start: execFileSync(
        "/bin/ps",
        ["-o", "lstart=", "-p", String(process.pid)],
        { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
      ).trim(),
      created_at: new Date().toISOString(),
    })}\n`,
  );
  const callsBeforeDelayedAck = JSON.parse(readFileSync(statePath, "utf8")).call_count ?? 0;
  const delayedAck = runAsync(
    "w1:p1",
    "receive",
    "--sid",
    created.sid,
    "--from",
    "claude",
    "--seq",
    "1",
  );
  const verifiedDeadline = Date.now() + 5000;
  while (
    (JSON.parse(readFileSync(statePath, "utf8")).call_count ?? 0) <
      callsBeforeDelayedAck + 3
  ) {
    if (Date.now() >= verifiedDeadline) {
      assert.fail("delayed receive did not finish live session verification");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  writeFileSync(
    sessionPath,
    `${JSON.stringify({
      ...beforeDelayedAck,
      sid: "replacement-sid",
      delivery: {
        ...beforeDelayedAck.delivery,
        next: { claude: 0, codex: 0 },
        submitted: { claude: 0, codex: 0 },
        received: { claude: 0, codex: 0 },
        pending: { claude: null, codex: null },
      },
    }, null, 2)}\n`,
  );
  execFileSync("trash", [ackLock]);
  await assert.rejects(
    delayedAck,
    /inbound sid .* does not match the active locked session replacement-sid/u,
  );
  writeFileSync(sessionPath, `${JSON.stringify(beforeDelayedAck, null, 2)}\n`);

  const body = join(root, "body.txt");
  writeFileSync(body, "Review the persistent pair transport.\n");
  let state = JSON.parse(readFileSync(statePath, "utf8"));
  state.panes["w1:p2"].agent_status = "working";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.throws(
    () => run(
      "send",
      "--kind",
      "review",
      "--body-file",
      body,
      "--timeout-ms",
      "50",
    ),
    /stayed working for 50ms; message not sent/u,
  );
  let session = JSON.parse(readFileSync(sessionPath, "utf8"));
  assert.equal(session.delivery.next.codex, 0);
  assert.equal(session.delivery.pending.codex, null);
  state.panes["w1:p2"].agent_status = "idle";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const sent = run(
    "send",
    "--kind",
    "review",
    "--body-file",
    body,
    "--ack-timeout-ms",
    "1000",
  );
  assert.match(sent, /seq=1 receipt=acknowledged/u);
  const message = JSON.parse(readFileSync(statePath, "utf8")).last_message;
  assert.match(message, /^\[agent codex -> claude kind=review sid=/u);
  assert.match(message, /\[herdr-pair control seq=1:/u);
  assert.match(message, /never as visible text in this pane/u);

  session = JSON.parse(readFileSync(sessionPath, "utf8"));
  assert.equal(session.delivery.submitted.codex, 1);
  assert.equal(session.delivery.received.codex, 1);
  assert.equal(session.delivery.pending.codex, null);
  assert.equal(session.round, 1);

  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.fail_after_enter = true;
  state.panes["w1:p1"].agent_status = "idle";
  state.panes["w1:p2"].agent_status = "idle";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.throws(
    () => run("send", "--kind", "task", "--body-file", body, "--ack-timeout-ms", "50"),
    /simulated interruption after Enter/u,
  );
  const recoveredAfterEnter = JSON.parse(run("verify")).session;
  assert.equal(recoveredAfterEnter.delivery.pending.codex, null);
  assert.equal(recoveredAfterEnter.delivery.submitted.codex, 2);
  assert.equal(recoveredAfterEnter.last_status.codex, "task");
  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.fail_after_enter = false;
  state.panes["w1:p1"].agent_status = "idle";
  state.panes["w1:p2"].agent_status = "idle";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  state.auto_ack = false;
  state.panes["w1:p1"].agent_status = "idle";
  state.panes["w1:p2"].agent_status = "idle";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const pending = run(
    "send",
    "--kind",
    "task",
    "--body-file",
    body,
    "--ack-timeout-ms",
    "50",
  );
  assert.match(pending, /receipt=pending-partner-may-be-busy-do-not-retry/u);
  session = JSON.parse(readFileSync(sessionPath, "utf8"));
  assert.equal(session.round, 2);
  assert.equal(session.last_status.codex, "task");
  assert.deepEqual(
    { seq: session.delivery.pending.codex.seq, kind: session.delivery.pending.codex.kind },
    { seq: 3, kind: "task" },
  );
  assert.throws(
    () => run("end", "--sid", created.sid),
    /cannot end while codex seq 3 awaits receipt/u,
  );
  assert.equal(JSON.parse(readFileSync(sessionPath, "utf8")).active, true);
  runAs("w1:p2", "receive", "--sid", created.sid, "--from", "codex", "--seq", "3");
  session = JSON.parse(readFileSync(sessionPath, "utf8"));
  assert.equal(session.round, 3);
  assert.equal(session.last_status.codex, "task");
  assert.equal(session.delivery.pending.codex, null);
  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.auto_ack = true;
  state.panes["w1:p1"].agent_status = "idle";
  state.panes["w1:p2"].agent_status = "idle";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  state.auto_ack = false;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.match(
    run("send", "--kind", "question", "--body-file", body, "--ack-timeout-ms", "50"),
    /receipt=pending-partner-may-be-busy-do-not-retry/u,
  );
  session = JSON.parse(readFileSync(sessionPath, "utf8"));
  assert.equal(session.round, 3);
  assert.equal(session.delivery.pending.codex.seq, 4);
  assert.throws(
    () => run("reconcile", "--clear-pending", "true"),
    /exact --sid/u,
  );
  const cleared = JSON.parse(
    run("reconcile", "--sid", created.sid, "--clear-pending", "true"),
  );
  assert.equal(cleared.cleared.agent, "codex");
  assert.equal(cleared.cleared.seq, 4);
  assert.equal(cleared.session.delivery.pending.codex, null);
  assert.equal(cleared.session.round, 3);

  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.panes["w1:p1"].agent_status = "idle";
  state.panes["w1:p2"].agent_status = "idle";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.match(
    run("send", "--kind", "review", "--body-file", body, "--ack-timeout-ms", "50"),
    /receipt=pending-partner-may-be-busy-do-not-retry/u,
  );
  session = JSON.parse(readFileSync(sessionPath, "utf8"));
  session.delivery.received.codex = 5;
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
  const racedAck = JSON.parse(
    run("reconcile", "--sid", created.sid, "--clear-pending", "true"),
  );
  assert.equal(racedAck.cleared, null);
  assert.deepEqual(racedAck.reconciled, [{ agent: "codex", seq: 5, kind: "review" }]);
  assert.equal(racedAck.session.round, 4);
  assert.equal(racedAck.session.delivery.pending.codex, null);
  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.auto_ack = true;
  state.panes["w1:p1"].agent_status = "idle";
  state.panes["w1:p2"].agent_status = "idle";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const acceptedBody = join(root, "accepted.txt");
  writeFileSync(acceptedBody, "Accepted.\n");
  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.panes["w1:p1"].agent_status = "idle";
  state.panes["w1:p2"].agent_status = "idle";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.match(
    run("send", "--kind", "accepted", "--body-file", acceptedBody, "--ack-timeout-ms", "1000"),
    /receipt=acknowledged/u,
  );
  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.panes["w1:p1"].agent_status = "idle";
  state.panes["w1:p2"].agent_status = "idle";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.match(
    runAs("w1:p2", "send", "--kind", "accepted", "--body-file", acceptedBody, "--ack-timeout-ms", "1000"),
    /receipt=acknowledged/u,
  );
  session = JSON.parse(readFileSync(sessionPath, "utf8"));
  assert.deepEqual(session.last_status, { claude: "accepted", codex: "accepted" });
  assert.equal(session.completed_cycles, 1);
  assert.equal(existsSync(sessionPath), true);
  assert.equal(JSON.parse(run("init")).resumed, true);

  session.delivery.next.claude = 2;
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
  run("receive", "--sid", created.sid, "--from", "claude", "--seq", "2");
  session = JSON.parse(readFileSync(sessionPath, "utf8"));
  assert.equal(session.delivery.received.claude, 2);

  const reset = JSON.parse(run("reset"));
  assert.equal(reset.reset, true);
  assert.equal(reset.round, 0);
  assert.deepEqual(reset.last_status, { claude: null, codex: null });
  assert.equal(reset.delivery.received.codex, 6);

  run("end", "--sid", created.sid);
  assert.equal(existsSync(sessionPath), false);
  assert.equal(existsSync(join(home, ".herdr-coworkers", "w1")), false);

  const legacyDirectory = dirname(sessionPath);
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(join(legacyDirectory, "session.json.tmp.crash"), "partial\n");
  const orphanLock = `${legacyDirectory}.init.lock`;
  mkdirSync(orphanLock);
  writeFileSync(
    join(orphanLock, "owner.json"),
    `${JSON.stringify({ pid: 999999, token: "dead-owner", created_at: new Date().toISOString() })}\n`,
  );
  writeFileSync(
    join(orphanLock, "reclaim.json"),
    `${JSON.stringify({ pid: 999999, token: "dead-reclaimer", created_at: new Date().toISOString() })}\n`,
  );
  const repairedOutputs = await Promise.all([
    runAsync("w1:p1", "init"),
    runAsync("w1:p2", "init"),
  ]);
  const repairedSessions = repairedOutputs.map((output) => JSON.parse(output));
  assert.equal(repairedSessions[0].sid, repairedSessions[1].sid);
  const repaired = repairedSessions[0];
  assert.equal(repaired.schema_version, 2);
  assert.equal(repaired.active, true);
  assert.equal(existsSync(orphanLock), false);
  run("end", "--sid", repaired.sid);

  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(join(legacyDirectory, "session.json.tmp.crash"), "partial\n");
  mkdirSync(orphanLock);
  writeFileSync(
    join(orphanLock, "owner.json"),
    `${JSON.stringify({
      pid: process.pid,
      token: "live-owner-with-shifted-clock",
      boot_time_ms: 0,
      process_start: execFileSync(
        "/bin/ps",
        ["-o", "lstart=", "-p", String(process.pid)],
        { encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
      ).trim(),
      created_at: new Date().toISOString(),
    })}\n`,
  );
  const liveOwnerAttempt = runAsyncWithEnv(
    "w1:p1",
    { TZ: "America/New_York" },
    "init",
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(existsSync(orphanLock), true);
  execFileSync("trash", [orphanLock]);
  const afterLiveOwner = JSON.parse(await liveOwnerAttempt);
  assert.equal(afterLiveOwner.active, true);
  run("end", "--sid", afterLiveOwner.sid);

  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(join(legacyDirectory, "session.json.tmp.crash"), "partial\n");
  mkdirSync(orphanLock);
  writeFileSync(
    join(orphanLock, "owner.json"),
    `${JSON.stringify({
      pid: process.pid,
      token: "reused-pid-owner",
      process_start: "not-the-current-process-start",
      created_at: new Date().toISOString(),
    })}\n`,
  );
  const pidReuseRecovered = JSON.parse(run("init"));
  assert.equal(pidReuseRecovered.active, true);
  assert.equal(existsSync(orphanLock), false);
  run("end", "--sid", pidReuseRecovered.sid);

  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(
    sessionPath,
    `${JSON.stringify({
      sid: "legacy-1",
      workspace_id: "w1",
      tab_id: "w1:t1",
      self: { agent: "codex", pane_id: "w1:p1" },
      partner: { agent: "claude", pane_id: "w1:p2" },
      round: 4,
      last_status: { claude: "ready", codex: "review" },
      no_progress_count: 0,
      delivery: {
        submitted: { claude: 0, codex: 7 },
        received: { claude: 0, codex: 6 },
        pending: {
          claude: null,
          codex: { seq: 8, kind: "task", submitted_at: null },
        },
      },
    }, null, 2)}\n`,
  );
  let migrated = JSON.parse(run("verify")).session;
  assert.equal(migrated.schema_version, 2);
  assert.equal(migrated.active, true);
  assert.deepEqual(migrated.participants, {
    codex: { pane_id: "w1:p1" },
    claude: { pane_id: "w1:p2" },
  });
  assert.equal(migrated.delivery.next.codex, 8);
  assert.equal(migrated.delivery.submitted.codex, 7);
  assert.equal(migrated.delivery.received.codex, 6);
  migrated = JSON.parse(
    run("reconcile", "--sid", "legacy-1", "--clear-pending", "true"),
  ).session;
  const future = { ...migrated, schema_version: 99 };
  writeFileSync(sessionPath, `${JSON.stringify(future, null, 2)}\n`);
  assert.throws(() => run("init"), /session schema 99 is newer/u);
  assert.equal(existsSync(`${legacyDirectory}.init.lock`), false);
  writeFileSync(sessionPath, `${JSON.stringify(migrated, null, 2)}\n`);
  run("end", "--sid", "legacy-1");

  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(
    sessionPath,
    `${JSON.stringify({
      ...migrated,
      sid: "legacy-stale",
      participants: {
        codex: { pane_id: "w1:old-codex" },
        claude: { pane_id: "w1:old-claude" },
      },
      delivery: {
        ...migrated.delivery,
        pending: {
          ...migrated.delivery.pending,
          codex: {
            seq: migrated.delivery.next.codex + 1,
            kind: "task",
            reserved_at: new Date().toISOString(),
            submitted_at: new Date().toISOString(),
          },
        },
      },
    }, null, 2)}\n`,
  );
  assert.throws(() => run("init"), /cannot resume existing current-tab session.*--stale true/u);
  assert.throws(() => run("end", "--sid", "legacy-stale"), /recorded participants/u);
  run("end", "--sid", "legacy-stale", "--stale", "true");
  const rebound = JSON.parse(run("init"));
  assert.equal(rebound.participants.codex.pane_id, "w1:p1");
  assert.equal(rebound.participants.claude.pane_id, "w1:p2");
  assert.throws(
    () => runAsWithEnv(
      "w1:p1",
      { PATH: `${bin}:${dirname(process.execPath)}` },
      "end",
      "--sid",
      rebound.sid,
    ),
    /requires trash on PATH before it can deactivate the session/u,
  );
  assert.equal(JSON.parse(readFileSync(sessionPath, "utf8")).active, true);
  const failingTrashBin = join(root, "failing-trash-bin");
  mkdirSync(failingTrashBin);
  const failingTrash = join(failingTrashBin, "trash");
  writeFileSync(failingTrash, "#!/bin/sh\nexit 42\n");
  chmodSync(failingTrash, 0o755);
  assert.throws(
    () => runAsWithEnv(
      "w1:p1",
      { PATH: `${failingTrashBin}:${bin}:${dirname(process.execPath)}` },
      "end",
      "--sid",
      rebound.sid,
    ),
    /cannot trash herdr-pair session; restored active state/u,
  );
  assert.equal(JSON.parse(readFileSync(sessionPath, "utf8")).active, true);
  state = JSON.parse(readFileSync(statePath, "utf8"));
  session = JSON.parse(readFileSync(sessionPath, "utf8"));
  session.delivery.pending.codex = {
    seq: session.delivery.next.codex + 1,
    kind: "task",
    reserved_at: new Date().toISOString(),
    submitted_at: new Date().toISOString(),
  };
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
  const otherTabDirectory = join(home, ".herdr-coworkers", "w1", "other_tab");
  mkdirSync(otherTabDirectory);
  delete state.panes["w1:p2"];
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  run("end", "--sid", rebound.sid, "--stale", "true");
  assert.equal(existsSync(sessionPath), false);
  assert.equal(existsSync(otherTabDirectory), true);

  process.stdout.write("herdr-pair tests: PASS\n");
} finally {
  if (existsSync(root)) execFileSync("trash", [root]);
}
