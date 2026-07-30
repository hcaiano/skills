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
    agent_session: { value: "codex-session-w1-p1" },
    agent_status: "working",
    cwd: "/workspace",
    pane_id: "w1:p1",
    tab_id: "w1:t1",
    terminal_id: "term-w1-p1",
    workspace_id: "w1",
  },
  "w1:p2": {
    agent: "claude",
    agent_session: { value: "claude-session-w1-p2" },
    agent_status: "idle",
    cwd: "/workspace",
    pane_id: "w1:p2",
    tab_id: "w1:t1",
    terminal_id: "term-w1-p2",
    workspace_id: "w1",
  },
};
writeFileSync(
  statePath,
  `${JSON.stringify({ panes, last_message: "", auto_ack: true, mutations: [] }, null, 2)}\n`,
);

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
else if (args[0] === "agent" && args[1] === "prompt") {
  const pane = state.panes[args[2]];
  state.mutations.push({ command: "agent prompt", pane: args[2] });
  state.last_message = args[3];
  pane.agent_status = "working";
  const control = state.last_message.match(/\\[herdr-pair control seq=(\\d+): run node .*? receive .*?--sid \\"?([^\\" ]+)\\"? --from \\"?([^\\" ]+)\\"? --seq (\\d+)/);
  if (control && state.auto_ack !== false) {
    const sender = control[3];
    const sequence = Number(control[4]);
    const slug = pane.tab_id.replaceAll(":", "_");
    const sessionPath = path.join(process.env.HOME, ".herdr-coworkers", pane.workspace_id, slug, "session.json");
    state.pending_ack = { sender, sequence, sessionPath };
  }
  save();
  if (state.fail_prompt === true) {
    process.stderr.write("simulated interruption after prompt\\n");
    process.exit(1);
  }
  output({});
} else if (args[0] === "pane" && args[1] === "split") {
  const source = state.panes[args[2]];
  state.mutations.push({ command: "pane split", pane: args[2] });
  const pane = {
    agent: null, agent_status: "unknown", cwd: source.cwd,
    pane_id: source.pane_id + "s", tab_id: source.tab_id,
    terminal_id: "term-" + source.pane_id + "s", workspace_id: source.workspace_id,
  };
  state.panes[pane.pane_id] = pane;
  save();
  output({ pane });
} else if (args[0] === "agent" && args[1] === "start") {
  // herdr's own rule, enforced here so a name it would reject fails the suite
  // instead of only failing in production.
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(args[2])) {
    process.stderr.write("invalid_agent_name: " + args[2] + "\\n");
    process.exit(1);
  }
  const paneId = args[args.indexOf("--pane") + 1];
  const pane = state.panes[paneId];
  state.mutations.push({ command: "agent start", pane: paneId });
  pane.agent = args[args.indexOf("--kind") + 1];
  pane.agent_status = "idle";
  state.last_agent_name = args[2];
  save();
  output({ agent: pane });
} else if (args[0] === "agent" && args[1] === "send-keys") {
  state.mutations.push({ command: "agent send-keys", pane: args[2] });
  state.enter_keys = (state.enter_keys ?? 0) + 1;
  state.last_send_keys = { pane: args[2], key: args[3] };
  save();
  output({});
} else if (args[0] === "workspace" && args[1] === "list") {
  const ids = [...new Set(Object.values(state.panes).map((p) => p.workspace_id))];
  output({ workspaces: ids.map((id) => ({ workspace_id: id })) });
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
const agentForPane = (paneId) =>
  JSON.parse(readFileSync(statePath, "utf8")).panes[paneId]?.agent;
const withCaller = (paneId, args) => [
  ...args,
  "--pane",
  paneId,
  "--as",
  agentForPane(paneId),
  ...(() => {
    const sessionId = JSON.parse(
      readFileSync(statePath, "utf8"),
    ).panes[paneId]?.agent_session?.value;
    return sessionId ? ["--agent-session-id", sessionId] : [];
  })(),
];
const runAs = (paneId, ...args) =>
  execFileSync(process.execPath, [helper, ...withCaller(paneId, args)], {
    encoding: "utf8",
    env: { ...env, HERDR_PANE_ID: "stale:pane" },
  });
const runAsWithEnv = (paneId, overrides, ...args) =>
  execFileSync(process.execPath, [helper, ...withCaller(paneId, args)], {
    encoding: "utf8",
    env: { ...env, ...overrides, HERDR_PANE_ID: "stale:pane" },
  });
const runAsyncWithEnv = (paneId, overrides, ...args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helper, ...withCaller(paneId, args)], {
      env: { ...env, ...overrides, HERDR_PANE_ID: "stale:pane" },
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
const runRaw = (...args) =>
  execFileSync(process.execPath, [helper, ...args], {
    encoding: "utf8",
    env: { ...env, HERDR_PANE_ID: "stale:pane" },
  });
const sessionPath = join(home, ".herdr-coworkers", "w1", "w1_t1", "session.json");

const runRawWithEnv = (overrides, ...args) =>
  execFileSync(process.execPath, [helper, ...args], {
    encoding: "utf8",
    env: { ...env, ...overrides },
  });

try {
  // `id` derives identity from the hint or an explicit --pane, and fails
  // closed on a stale hint, a wrong-kind pane, or an uncorroborated pane.
  const idHappy = JSON.parse(
    runRawWithEnv({ HERDR_PANE_ID: "w1:p2" }, "id", "--as", "claude"),
  );
  assert.deepEqual(idHappy, {
    pane: "w1:p2",
    as: "claude",
    agent_session_id: "claude-session-w1-p2",
    workspace_id: "w1",
    cwd: "/workspace",
    args: ["--pane", "w1:p2", "--as", "claude", "--agent-session-id", "claude-session-w1-p2"],
  });
  assert.equal(
    runRawWithEnv({ HERDR_PANE_ID: "w1:p2" }, "id", "--as", "claude", "--format", "shell").trim(),
    "--pane w1:p2 --as claude --agent-session-id claude-session-w1-p2",
  );
  assert.throws(
    () => runRawWithEnv({ HERDR_PANE_ID: "w1:p2" }, "id", "--as", "codex"),
    /hosts claude, not codex/u,
  );
  assert.throws(() => runRaw("id", "--as", "claude"), /stale:pane/u);
  const idExplicit = JSON.parse(runRaw("id", "--as", "codex", "--pane", "w1:p1"));
  assert.equal(idExplicit.pane, "w1:p1");
  // The caller's own session id finds its pane across every workspace —
  // immune to a stale env hint and to focus. (`pane current` in any form is
  // never called: the fake has no handler, so a reintroduction fails loud.)
  const idBySession = JSON.parse(
    runRaw("id", "--as", "claude", "--session", "claude-session-w1-p2"),
  );
  assert.equal(idBySession.pane, "w1:p2");
  // A hint whose pane hosts a different session of the same kind is refused.
  assert.throws(
    () => runRawWithEnv({ HERDR_PANE_ID: "w1:p2" }, "id", "--as", "claude", "--session", "not-my-session"),
    /hosts session claude-session-w1-p2, not yours/u,
  );

  let identityState = JSON.parse(readFileSync(statePath, "utf8"));
  identityState.panes["w9:p1"] = {
    agent: "claude",
    agent_status: "idle",
    cwd: "/other-workspace",
    pane_id: "w9:p1",
    tab_id: "w9:t1",
    terminal_id: "term-w9-p1",
    workspace_id: "w9",
  };
  identityState.panes["w8:p1"] = {
    agent: "codex",
    agent_status: "idle",
    cwd: "/foreign-workspace",
    pane_id: "w8:p1",
    tab_id: "w8:t1",
    terminal_id: "term-w8-p1",
    workspace_id: "w8",
  };
  identityState.panes["w8:p2"] = {
    agent: "claude",
    agent_status: "idle",
    cwd: "/foreign-workspace",
    pane_id: "w8:p2",
    tab_id: "w8:t1",
    terminal_id: "term-w8-p2",
    workspace_id: "w8",
  };
  identityState.panes["w7:p1"] = {
    agent: "codex",
    agent_status: "working",
    cwd: "/foreign-working",
    pane_id: "w7:p1",
    tab_id: "w7:t1",
    terminal_id: "term-w7-p1",
    workspace_id: "w7",
  };
  writeFileSync(statePath, `${JSON.stringify(identityState, null, 2)}\n`);
  const mutationsBeforeMismatch = identityState.mutations.length;
  assert.throws(
    () => runRaw("spawn", "--pane", "w9:p1", "--as", "codex"),
    /caller identity mismatch.*is claude, not --as codex/u,
  );
  identityState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(identityState.mutations.length, mutationsBeforeMismatch);
  assert.throws(
    () => runRaw("spawn", "--pane", "w7:p1", "--as", "codex"),
    /spawn requires a caller pane with a strong agent session identity/u,
  );
  identityState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(identityState.mutations.length, mutationsBeforeMismatch);
  assert.throws(
    () => runRaw("spawn", "--pane", "w8:p1", "--as", "codex"),
    /has no agent session identity and is idle/u,
  );
  identityState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(identityState.mutations.length, mutationsBeforeMismatch);
  const foreignBody = join(root, "foreign-body.txt");
  writeFileSync(foreignBody, "Do not deliver this message.\n");
  assert.throws(
    () =>
      runRaw(
        "send",
        "--pane",
        "w8:p1",
        "--as",
        "codex",
        "--sid",
        "foreign-sid",
        "--kind",
        "task",
        "--body-file",
        foreignBody,
      ),
    /has no agent session identity and is idle/u,
  );
  identityState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(identityState.mutations.length, mutationsBeforeMismatch);
  const foreignSessionPath = join(
    home,
    ".herdr-coworkers",
    "w8",
    "w8_t1",
    "session.json",
  );
  mkdirSync(dirname(foreignSessionPath), { recursive: true });
  writeFileSync(
    foreignSessionPath,
    `${JSON.stringify({ sid: "foreign-sid", active: true })}\n`,
  );
  assert.throws(
    () =>
      runRaw(
        "end",
        "--pane",
        "w8:p1",
        "--as",
        "codex",
        "--sid",
        "foreign-sid",
        "--stale",
        "true",
      ),
    /has no agent session identity and is idle/u,
  );
  assert.equal(existsSync(foreignSessionPath), true);
  identityState = JSON.parse(readFileSync(statePath, "utf8"));
  identityState.panes["w8:p1"].agent_status = "working";
  writeFileSync(statePath, `${JSON.stringify(identityState, null, 2)}\n`);
  writeFileSync(
    foreignSessionPath,
    `${JSON.stringify({
      schema_version: 2,
      sid: "foreign-sid",
      workspace_id: "w8",
      tab_id: "w8:t1",
      initiator: "codex",
      active: true,
      participants: {
        codex: {
          pane_id: "w8:p1",
          terminal_id: "term-w8-p1",
          agent_session_id: null,
        },
        claude: {
          pane_id: "w8:p2",
          terminal_id: "term-w8-p2",
          agent_session_id: null,
        },
      },
      round: 0,
      last_status: { claude: null, codex: null },
      completed_cycles: 0,
      no_progress_count: 0,
      delivery: {
        next: { claude: 0, codex: 0 },
        submitted: { claude: 0, codex: 0 },
        received: { claude: 0, codex: 0 },
        pending: { claude: null, codex: null },
      },
    }, null, 2)}\n`,
  );
  assert.throws(
    () =>
      runRaw(
        "send",
        "--pane",
        "w8:p1",
        "--as",
        "codex",
        "--sid",
        "caller-owned-sid",
        "--kind",
        "task",
        "--body-file",
        foreignBody,
      ),
    /send sid caller-owned-sid does not match current-tab session foreign-sid/u,
  );
  identityState = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(identityState.mutations.length, mutationsBeforeMismatch);
  assert.throws(
    () => runRaw("discover", "--as", "codex"),
    /requires the caller's exact --pane ID/u,
  );
  const explicitlyBound = JSON.parse(
    runRaw(
      "discover",
      "--pane",
      "w1:p1",
      "--as",
      "codex",
      "--agent-session-id",
      "codex-session-w1-p1",
    ),
  );
  assert.equal(explicitlyBound.self.pane_id, "w1:p1");
  delete identityState.panes["w9:p1"];
  delete identityState.panes["w8:p1"];
  delete identityState.panes["w8:p2"];
  delete identityState.panes["w7:p1"];
  writeFileSync(statePath, `${JSON.stringify(identityState, null, 2)}\n`);

  const created = JSON.parse(run("init"));
  assert.equal(created.schema_version, 2);
  assert.equal(created.active, true);
  assert.equal(created.round, 0);

  const resumed = JSON.parse(run("init"));
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.sid, created.sid);

  let recycledState = JSON.parse(readFileSync(statePath, "utf8"));
  recycledState.panes["w1:p1"].terminal_id = "term-recycled-w1-p1";
  writeFileSync(statePath, `${JSON.stringify(recycledState, null, 2)}\n`);
  assert.throws(
    () => run("verify"),
    /live panes do not match the participants recorded for this tab/u,
  );
  recycledState.panes["w1:p1"].terminal_id = "term-w1-p1";
  recycledState.panes["w1:p2"].terminal_id = "term-recycled-w1-p2";
  writeFileSync(statePath, `${JSON.stringify(recycledState, null, 2)}\n`);
  assert.throws(
    () => run("verify"),
    /live panes do not match the participants recorded for this tab/u,
  );
  recycledState.panes["w1:p2"].terminal_id = "term-w1-p2";
  writeFileSync(statePath, `${JSON.stringify(recycledState, null, 2)}\n`);

  const nullSessionBinding = JSON.parse(readFileSync(sessionPath, "utf8"));
  nullSessionBinding.participants.codex.agent_session_id = null;
  writeFileSync(
    sessionPath,
    `${JSON.stringify(nullSessionBinding, null, 2)}\n`,
  );
  const reboundSessionId = JSON.parse(run("verify")).session.participants.codex
    .agent_session_id;
  assert.equal(reboundSessionId, "codex-session-w1-p1");

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
  const ackWaitMarker = join(root, "ack-waiting-on-lock");
  const delayedAck = runAsyncWithEnv(
    "w1:p1",
    { HERDR_PAIR_TEST_LOCK_WAIT_MARKER: ackWaitMarker },
    "receive",
    "--sid",
    created.sid,
    "--from",
    "claude",
    "--seq",
    "1",
  );
  const verifiedDeadline = Date.now() + 5000;
  while (!existsSync(ackWaitMarker)) {
    if (Date.now() >= verifiedDeadline) {
      assert.fail("delayed receive did not block on the held session lock");
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
  const sent = run(
    "send",
    "--sid",
    created.sid,
    "--kind",
    "review",
    "--body-file",
    body,
    "--ack-timeout-ms",
    "1000",
  );
  assert.match(sent, /seq=1 receipt=acknowledged/u);
  const fake = JSON.parse(readFileSync(statePath, "utf8"));
  const message = fake.last_message;
  assert.match(message, /^\[agent codex -> claude kind=review sid=/u);
  assert.match(message, /\[herdr-pair control seq=1:/u);
  assert.match(message, /receive --pane "w1:p2" --as "claude"/u);
  assert.match(message, /never as visible text in this pane/u);
  // `agent prompt` pastes without reliably submitting, so a send that skips
  // the Enter leaves the message in the partner's composer and the pair
  // stalls in silence. Guard it here: this has regressed before.
  assert.equal(fake.enter_keys, 1, "send must follow the paste with an Enter");
  assert.deepEqual(fake.last_send_keys, { pane: "w1:p2", key: "enter" });

  let session = JSON.parse(readFileSync(sessionPath, "utf8"));
  assert.equal(session.delivery.submitted.codex, 1);
  assert.equal(session.delivery.received.codex, 1);
  assert.equal(session.delivery.pending.codex, null);
  assert.equal(session.round, 1);

  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.fail_prompt = true;
  state.panes["w1:p1"].agent_status = "idle";
  state.panes["w1:p2"].agent_status = "idle";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.throws(
    () =>
      run(
        "send",
        "--sid",
        created.sid,
        "--kind",
        "task",
        "--body-file",
        body,
        "--ack-timeout-ms",
        "50",
      ),
    /simulated interruption after prompt/u,
  );
  const recoveredAfterEnter = JSON.parse(run("verify")).session;
  assert.equal(recoveredAfterEnter.delivery.pending.codex, null);
  assert.equal(recoveredAfterEnter.delivery.submitted.codex, 2);
  assert.equal(recoveredAfterEnter.last_status.codex, "task");
  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.fail_prompt = false;
  state.panes["w1:p1"].agent_status = "idle";
  state.panes["w1:p2"].agent_status = "idle";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  state.auto_ack = false;
  state.panes["w1:p1"].agent_status = "idle";
  state.panes["w1:p2"].agent_status = "idle";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const pending = run(
    "send",
    "--sid",
    created.sid,
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
    run(
      "send",
      "--sid",
      created.sid,
      "--kind",
      "question",
      "--body-file",
      body,
      "--ack-timeout-ms",
      "50",
    ),
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
    run(
      "send",
      "--sid",
      created.sid,
      "--kind",
      "review",
      "--body-file",
      body,
      "--ack-timeout-ms",
      "50",
    ),
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
    run(
      "send",
      "--sid",
      created.sid,
      "--kind",
      "accepted",
      "--body-file",
      acceptedBody,
      "--ack-timeout-ms",
      "1000",
    ),
    /receipt=acknowledged/u,
  );
  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.panes["w1:p1"].agent_status = "idle";
  state.panes["w1:p2"].agent_status = "idle";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.match(
    runAs(
      "w1:p2",
      "send",
      "--sid",
      created.sid,
      "--kind",
      "accepted",
      "--body-file",
      acceptedBody,
      "--ack-timeout-ms",
      "1000",
    ),
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

  // A partner that never idles still gets the message: the send waits only a
  // short grace period, then delivers queued and proves landing from the
  // composer. Blocking until idle used to time out and silently drop urgent
  // messages (a STOP lost on 2026-07-29). Guard the queued path.
  state = JSON.parse(readFileSync(statePath, "utf8"));
  state.panes["w1:p2"].agent_status = "working";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const queued = run(
    "send",
    "--sid",
    created.sid,
    "--kind",
    "task",
    "--body-file",
    body,
    "--timeout-ms",
    "50",
    "--ack-timeout-ms",
    "1000",
  );
  assert.match(queued, /seq=7 receipt=acknowledged/u);
  session = JSON.parse(readFileSync(sessionPath, "utf8"));
  assert.equal(session.delivery.pending.codex, null);

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
        {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C", TZ: "America/New_York" },
        },
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
      process_start_format: "ps-lstart-c-utc-v1",
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
    codex: {
      pane_id: "w1:p1",
      terminal_id: "term-w1-p1",
      agent_session_id: "codex-session-w1-p1",
    },
    claude: {
      pane_id: "w1:p2",
      terminal_id: "term-w1-p2",
      agent_session_id: "claude-session-w1-p2",
    },
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

  // Spawning derives the peer's agent name from the tab id, and herdr rejects
  // anything but 1-32 lowercase characters. Workspace ids carry uppercase
  // (wY:t1) and long ones overflow the limit — both broke the spawn outright.
  for (const [paneId, tabId, workspaceId, expected] of [
    ["wY:p1", "wY:t1", "wY", "pair-claude-wy_t1"],
    ["w655f3dd90835016:p1", "w655f3dd90835016:t123", "w655f3dd90835016", "pair-claude-f0e59f4e"],
  ]) {
    const spawnState = JSON.parse(readFileSync(statePath, "utf8"));
    spawnState.panes = {
      [paneId]: {
        agent: "codex",
        agent_session: { value: `session-${paneId}` },
        agent_status: "working", cwd: "/workspace",
        pane_id: paneId, tab_id: tabId, workspace_id: workspaceId,
      },
    };
    delete spawnState.last_agent_name;
    writeFileSync(statePath, `${JSON.stringify(spawnState, null, 2)}\n`);
    runAs(paneId, "spawn");
    const named = JSON.parse(readFileSync(statePath, "utf8")).last_agent_name;
    assert.equal(named, expected, `spawn used an agent name herdr would reject: ${named}`);
    assert.match(named, /^[a-z][a-z0-9_-]{0,31}$/u);
  }

  process.stdout.write("herdr-pair tests: PASS\n");
} finally {
  if (existsSync(root)) execFileSync("trash", [root]);
}
