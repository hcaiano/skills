#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
const output = (result) => process.stdout.write(JSON.stringify({ result }) + "\\n");
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
    const session = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    session.delivery.received[sender] = sequence;
    fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2) + "\\n");
  }
  save(); output({});
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

  const body = join(root, "body.txt");
  writeFileSync(body, "Review the persistent pair transport.\n");
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

  let session = JSON.parse(readFileSync(sessionPath, "utf8"));
  assert.equal(session.delivery.submitted.codex, 1);
  assert.equal(session.delivery.received.codex, 1);
  assert.equal(session.delivery.pending.codex, null);
  assert.equal(session.round, 1);

  let state = JSON.parse(readFileSync(statePath, "utf8"));
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
  assert.equal(session.round, 1);
  assert.equal(session.last_status.codex, "review");
  assert.deepEqual(
    { seq: session.delivery.pending.codex.seq, kind: session.delivery.pending.codex.kind },
    { seq: 2, kind: "task" },
  );
  runAs("w1:p2", "receive", "--sid", created.sid, "--from", "codex", "--seq", "2");
  session = JSON.parse(readFileSync(sessionPath, "utf8"));
  assert.equal(session.round, 2);
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
  assert.equal(session.round, 2);
  assert.equal(session.delivery.pending.codex.seq, 3);
  assert.throws(
    () => run("reconcile", "--clear-pending", "true"),
    /exact --sid/u,
  );
  const cleared = JSON.parse(
    run("reconcile", "--sid", created.sid, "--clear-pending", "true"),
  );
  assert.equal(cleared.cleared.agent, "codex");
  assert.equal(cleared.cleared.seq, 3);
  assert.equal(cleared.session.delivery.pending.codex, null);
  assert.equal(cleared.session.round, 2);

  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.panes["w1:p1"].agent_status = "idle";
  state.panes["w1:p2"].agent_status = "idle";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.match(
    run("send", "--kind", "review", "--body-file", body, "--ack-timeout-ms", "50"),
    /receipt=pending-partner-may-be-busy-do-not-retry/u,
  );
  session = JSON.parse(readFileSync(sessionPath, "utf8"));
  session.delivery.received.codex = 4;
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
  const racedAck = JSON.parse(
    run("reconcile", "--sid", created.sid, "--clear-pending", "true"),
  );
  assert.equal(racedAck.cleared, null);
  assert.deepEqual(racedAck.reconciled, [{ agent: "codex", seq: 4, kind: "review" }]);
  assert.equal(racedAck.session.round, 3);
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
  assert.equal(reset.delivery.received.codex, 5);

  run("end", "--sid", created.sid);
  assert.equal(existsSync(sessionPath), false);
  assert.equal(existsSync(join(home, ".herdr-coworkers", "w1")), false);

  const legacyDirectory = dirname(sessionPath);
  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(join(legacyDirectory, "session.json.tmp.crash"), "partial\n");
  const repaired = JSON.parse(run("init"));
  assert.equal(repaired.schema_version, 2);
  assert.equal(repaired.active, true);
  run("end", "--sid", repaired.sid);

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
    }, null, 2)}\n`,
  );
  const migrated = JSON.parse(run("verify")).session;
  assert.equal(migrated.schema_version, 2);
  assert.equal(migrated.active, true);
  assert.deepEqual(migrated.participants, {
    codex: { pane_id: "w1:p1" },
    claude: { pane_id: "w1:p2" },
  });
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
    }, null, 2)}\n`,
  );
  assert.throws(() => run("init"), /cannot resume existing current-tab session.*--stale true/u);
  assert.throws(() => run("end", "--sid", "legacy-stale"), /recorded participants/u);
  run("end", "--sid", "legacy-stale", "--stale", "true");
  const rebound = JSON.parse(run("init"));
  assert.equal(rebound.participants.codex.pane_id, "w1:p1");
  assert.equal(rebound.participants.claude.pane_id, "w1:p2");
  run("end", "--sid", rebound.sid);

  process.stdout.write("herdr-pair tests: PASS\n");
} finally {
  if (existsSync(root)) execFileSync("trash", [root]);
}
