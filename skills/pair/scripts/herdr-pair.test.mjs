#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
    agent_session: {
      agent: "codex",
      kind: "id",
      source: "herdr:codex",
      value: "codex-session-w1-p1",
    },
    agent_status: "working",
    cwd: "/workspace",
    foreground_cwd: "/workspace",
    pane_id: "w1:p1",
    tab_id: "w1:t1",
    terminal_id: "term-w1-p1",
    workspace_id: "w1",
  },
  "w1:p2": {
    agent: "claude",
    agent_session: {
      agent: "claude",
      kind: "id",
      source: "herdr:claude",
      value: "claude-session-w1-p2",
    },
    agent_status: "idle",
    cwd: "/workspace",
    foreground_cwd: "/workspace",
    pane_id: "w1:p2",
    tab_id: "w1:t1",
    terminal_id: "term-w1-p2",
    workspace_id: "w1",
  },
};
writeFileSync(
  statePath,
  `${JSON.stringify(
    {
      panes,
      workspaces: { w1: { workspace_id: "w1", label: "workspace" } },
      transcripts: {
        "w1:p1": "Newest user request: refactor Herdr identity.\nCaller marker: proving this exact conversation.",
        "w1:p2": "Different Claude conversation.",
      },
      processes: {
        "w1:p2": [
          {
            argv: ["claude"],
            argv0: "claude",
            cwd: "/workspace",
            name: "2.1.220",
          },
        ],
      },
      last_message: "",
      auto_ack: true,
      mutations: [],
    },
    null,
    2,
  )}\n`,
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
if (args[0] === "pane" && args[1] === "get") {
  const paneId = args[2];
  output({ pane: state.panes[paneId] });
}
else if (args[0] === "pane" && args[1] === "list") output({ panes: Object.values(state.panes) });
else if (args[0] === "api" && args[1] === "snapshot") {
  output({
    snapshot: {
      agents: Object.values(state.panes)
        .filter((pane) => pane.agent)
        .map((pane) => ({
          ...pane,
          foreground_cwd: pane.foreground_cwd ?? pane.cwd,
        })),
    },
  });
}
else if (args[0] === "pane" && args[1] === "process-info") {
  const paneId = args[args.indexOf("--pane") + 1];
  if (state.fail_process_info_pane === paneId) {
    process.stderr.write("simulated process-info failure\\n");
    process.exit(1);
  }
  if (state.malformed_process_info_pane === paneId) {
    output({ process_info: { pane_id: paneId } });
    process.exit(0);
  }
  const pane = state.panes[paneId];
  const foreground_processes =
    state.processes?.[paneId] ??
    (pane?.agent
      ? [{ argv: [pane.agent], cwd: pane.cwd, name: pane.agent }]
      : []);
  // Real herdr reports a pid on every foreground process, and the caller
  // proves itself by ancestry, so panes listed in state.ancestor_panes report a
  // pid the test process really is an ancestor of; every other pane still gets
  // a pid, just an unrelated one.
  let nextFakePid = 900000;
  for (const entry of foreground_processes) {
    if (entry && typeof entry === "object" && entry.pid === undefined) {
      entry.pid = (nextFakePid += 1);
    }
  }
  if ((state.ancestor_panes ?? []).includes(paneId) && foreground_processes[0]) {
    foreground_processes[0].pid = Number(process.env.TEST_ANCESTOR_PID);
  }
  output({ process_info: { pane_id: paneId, foreground_processes } });
}
else if (args[0] === "agent" && args[1] === "read") {
  process.stdout.write(state.transcripts?.[args[2]] ?? "");
}
else if (args[0] === "agent" && args[1] === "prompt") {
  const pane = state.panes[args[2]];
  const wasWorking = pane.agent_status === "working";
  const droppedWhileWorking = state.drop_paste_when_working === true && wasWorking;
  state.mutations.push({ command: "agent prompt", pane: args[2] });
  state.last_message = args[3];
  // Both harnesses collapse a large multi-line paste into a summary line, so
  // the composer never shows the message text itself. state.drop_paste models
  // the failure this fake used to hide: the paste silently never lands.
  if (state.drop_paste !== true && !droppedWhileWorking && !(state.hide_composer_when_working === true && wasWorking)) {
    const lines = args[3].split("\\n").length;
    state.composers = state.composers ?? {};
    state.composers[args[2]] = state.show_composer_when_working === true && wasWorking
      ? args[3]
      : lines > 1
        ? "[Pasted text #1 +" + lines + " lines]"
        : args[3];
  }
  if (state.working_on_prompt !== false) pane.agent_status = "working";
  // Models a partner that settles idle right after the paste: was working at
  // send time, provably idle by the time the receipt is chosen.
  if (state.idle_after_prompt === true) pane.agent_status = "idle";
  const control = state.last_message.match(/\\[herdr-pair control seq=(\\d+): run node .*? receive .*? --seq (\\d+)/);
  const sender = state.last_message.match(/^\\[agent (claude|codex|cursor|grok|opencode) ->/)?.[1];
  const sid = state.last_message.match(/sid=([^\\]\\s]+)\\]/)?.[1];
  if (control && sender && state.auto_ack !== false && !droppedWhileWorking) {
    const sequence = Number(control[2]);
    const slug = pane.tab_id.replaceAll(":", "_");
    // One file per pair: acknowledge the session the message names, never
    // whichever pair happens to sort first.
    const dir = path.join(process.env.HOME, ".herdr-coworkers", pane.workspace_id, slug);
    let sessionPath = null;
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      if (name !== "session.json" && !(name.startsWith("pair-") && name.endsWith(".json"))) continue;
      try {
        if (JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")).sid === sid) {
          sessionPath = path.join(dir, name);
          break;
        }
      } catch {}
    }
    if (sessionPath) state.pending_ack = { sender, sequence, sessionPath };
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
  const requestedCwd = args.includes("--cwd")
    ? args[args.indexOf("--cwd") + 1]
    : source.cwd;
  let splitId = source.pane_id + "s";
  while (state.panes[splitId]) splitId += "s";
  const pane = {
    agent: null, agent_status: "unknown", cwd: requestedCwd,
    pane_id: splitId, tab_id: source.tab_id,
    terminal_id: "term-" + splitId, workspace_id: source.workspace_id,
  };
  state.panes[pane.pane_id] = pane;
  save();
  output({ pane });
} else if (args[0] === "pane" && args[1] === "close") {
  state.mutations.push({ command: "pane close", pane: args[2] });
  delete state.panes[args[2]];
  save();
  output({});
} else if (args[0] === "agent" && args[1] === "start") {
  // herdr's own rule, enforced here so a name it would reject fails the suite
  // instead of only failing in production.
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(args[2])) {
    process.stderr.write("invalid_agent_name: " + args[2] + "\\n");
    process.exit(1);
  }
  // herdr keeps a live agent's name unique, so a second spawn reusing one
  // fails here instead of only failing in production.
  if (Object.values(state.panes).some((p) => p.agent_name === args[2])) {
    process.stderr.write("agent_name_taken: " + args[2] + "\\n");
    process.exit(1);
  }
  // A fresh split can answer agent_pane_busy while its shell starts up; the
  // countdown models that transient window.
  if (state.agent_start_busy_remaining > 0) {
    state.agent_start_busy_remaining -= 1;
    save();
    process.stderr.write("agent_pane_busy: agent target pane is not an available shell\\n");
    process.exit(1);
  }
  if (state.fail_agent_start === true) {
    process.stderr.write("simulated agent start failure\\n");
    process.exit(1);
  }
  const paneId = args[args.indexOf("--pane") + 1];
  const pane = state.panes[paneId];
  state.mutations.push({ command: "agent start", pane: paneId });
  pane.agent = args[args.indexOf("--kind") + 1];
  pane.agent_status = "idle";
  state.last_agent_name = args[2];
  pane.agent_name = args[2];
  state.last_agent_start_argv = args;
  save();
  output({ agent: pane });
} else if (args[0] === "agent" && args[1] === "send-keys") {
  state.mutations.push({ command: "agent send-keys", pane: args[2] });
  state.enter_keys = (state.enter_keys ?? 0) + 1;
  state.last_send_keys = { pane: args[2], key: args[3] };
  // Enter submits, which returns the composer to its empty placeholder.
  if (args[3] === "enter" && state.swallow_enter !== true) {
    state.composers = state.composers ?? {};
    delete state.composers[args[2]];
  }
  save();
  output({});
} else if (args[0] === "workspace" && args[1] === "list") {
  const ids = [...new Set(Object.values(state.panes).map((p) => p.workspace_id))];
  output({ workspaces: ids.map((id) => ({ workspace_id: id })) });
} else if (args[0] === "workspace" && args[1] === "get") {
  const workspaceId = args[2];
  output({
    workspace: state.workspaces?.[workspaceId] ?? {
      workspace_id: workspaceId,
    },
  });
} else if (args[0] === "pane" && args[1] === "read") {
  const source = args[args.indexOf("--source") + 1];
  const tail = state.pane_tails?.[args[2]];
  if (source === "recent-unwrapped" && tail !== undefined) {
    process.stdout.write(tail);
    process.exit(0);
  }
  // Returning "" here used to make every composer check read "nothing is
  // holding the text", so the whole landing proof passed vacuously and a lost
  // paste was indistinguishable from a delivered one. The pane now renders its
  // composer: the harness placeholder when empty, the pasted content when not.
  const composer = (state.composers ?? {})[args[2]];
  process.stdout.write(
    "some earlier output\\n› " + (composer ?? "Improve documentation in @filename") + "\\n",
  );
}
else { process.stderr.write("unsupported fake herdr args: " + args.join(" ") + "\\n"); process.exit(1); }
`,
);
chmodSync(fakeHerdr, 0o755);

const env = {
  ...process.env,
  FAKE_HERDR_STATE: statePath,
  TEST_ANCESTOR_PID: String(process.pid),
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p1",
  HOME: home,
  PATH: `${bin}:${process.env.PATH}`,
};
const withCaller = (paneId, args) => {
  const pane = JSON.parse(readFileSync(statePath, "utf8")).panes[paneId];
  return [
    ...args,
    "--pane",
    paneId,
    "--workspace",
    pane.workspace_id,
    "--tab-id",
    pane.tab_id,
    "--as",
    pane.agent,
    "--terminal-id",
    pane.terminal_id,
    "--repo-root",
    pane.cwd,
  ];
};
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

function installedCliHelp(command) {
  const result = spawnSync(command, ["--help"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") return null;
  assert.equal(result.error, undefined, `${command} --help failed to start`);
  assert.equal(result.status, 0, `${command} --help exited ${result.status}`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

const tabDirectory = join(home, ".herdr-coworkers", "w1", "w1_t1");
// One file per pair, named after the partner pane; `session.json` is the
// single-pair name written before multi-pair and still resolved.
const sessionPath = join(tabDirectory, "pair-w1_p2.json");
const legacySessionPath = join(tabDirectory, "session.json");

try {
  // A `role=process-pane` token is written by whoever asks, so it must not be
  // able to hide a real agent from the exact-two invariant on its own: only a
  // pane actually running the gate helper is excluded.
  let tokenState = JSON.parse(readFileSync(statePath, "utf8"));
  tokenState.panes["w1:p3"] = {
    ...tokenState.panes["w1:p1"],
    pane_id: "w1:p3",
    terminal_id: "term-w1-p3",
    tokens: { role: "process-pane" },
  };
  // A real agent whose PROMPT names the wrapper — this conversation does it
  // constantly — must not be hideable by a stale or forged token.
  tokenState.processes["w1:p3"] = [
    {
      argv: ["codex", "run node /skills/review-it/scripts/herdr-visible-run.mjs exec --pane w1:p3"],
      cwd: "/workspace",
      name: "codex",
      pid: 999001,
    },
  ];
  writeFileSync(statePath, `${JSON.stringify(tokenState, null, 2)}\n`);
  assert.deepEqual(
    JSON.parse(runAs("w1:p2", "discover")).candidates.map((candidate) => candidate.pane_id).sort(),
    ["w1:p1", "w1:p3"],
    "a forged process-pane token must not hide a real agent",
  );
  // Neither may a wrapper that belongs to a different pane's run.
  tokenState = JSON.parse(readFileSync(statePath, "utf8"));
  tokenState.processes["w1:p3"] = [
    {
      argv: ["node", "/skills/review-it/scripts/herdr-visible-run.mjs", "exec", "--pane", "w1:p9"],
      cwd: "/workspace",
      name: "node",
      pid: 999001,
    },
  ];
  writeFileSync(statePath, `${JSON.stringify(tokenState, null, 2)}\n`);
  assert.deepEqual(
    JSON.parse(runAs("w1:p2", "discover")).candidates.map((candidate) => candidate.pane_id).sort(),
    ["w1:p1", "w1:p3"],
    "another pane's wrapper must not exclude this one",
  );
  // The same pane, now genuinely running this pane's gate wrapper, is excluded.
  tokenState = JSON.parse(readFileSync(statePath, "utf8"));
  tokenState.processes["w1:p3"] = [
    {
      argv: ["node", "/skills/review-it/scripts/herdr-visible-run.mjs", "exec", "--pane", "w1:p3"],
      cwd: "/workspace",
      name: "node",
      pid: 999001,
    },
  ];
  writeFileSync(statePath, `${JSON.stringify(tokenState, null, 2)}\n`);
  const withGatePane = JSON.parse(runAs("w1:p2", "discover"));
  assert.deepEqual(
    withGatePane.candidates.map((candidate) => candidate.pane_id),
    ["w1:p1"],
    "a pane running this pane's own gate wrapper is not a partner candidate",
  );
  tokenState = JSON.parse(readFileSync(statePath, "utf8"));
  delete tokenState.panes["w1:p3"];
  delete tokenState.processes["w1:p3"];
  writeFileSync(statePath, `${JSON.stringify(tokenState, null, 2)}\n`);

  let identityState = JSON.parse(readFileSync(statePath, "utf8"));
  identityState.panes["w1:p1"].agent_session.value = "stale-or-duplicated-metadata";
  writeFileSync(statePath, `${JSON.stringify(identityState, null, 2)}\n`);

  // A stale session binding cannot override the pinned pane proof.
  assert.equal(JSON.parse(runAs("w1:p1", "discover")).self.pane_id, "w1:p1");
  assert.throws(
    () => runRaw("discover", "--as", "codex"),
    /requires the transcript-proven --pane/u,
  );
  assert.throws(
    () =>
      runRaw(
        "discover",
        "--pane",
        "w1:p1",
        "--workspace",
        "wrong-workspace",
        "--tab-id",
        "w1:t1",
        "--as",
        "codex",
        "--terminal-id",
        "term-w1-p1",
        "--repo-root",
        "/workspace",
      ),
    /caller workspace mismatch/u,
  );
  assert.throws(
    () =>
      runRaw(
        "discover",
        "--pane",
        "w1:p1",
        "--workspace",
        "w1",
        "--tab-id",
        "w1:other-tab",
        "--as",
        "codex",
        "--terminal-id",
        "term-w1-p1",
        "--repo-root",
        "/workspace",
      ),
    /caller tab mismatch/u,
  );
  assert.throws(
    () =>
      runRaw(
        "discover",
        "--pane",
        "w1:p1",
        "--workspace",
        "w1",
        "--tab-id",
        "w1:t1",
        "--as",
        "codex",
        "--terminal-id",
        "recycled-terminal",
        "--repo-root",
        "/workspace",
      ),
    /caller terminal changed/u,
  );
  assert.throws(
    () =>
      runRaw(
        "discover",
        "--pane",
        "w1:p1",
        "--workspace",
        "w1",
        "--tab-id",
        "w1:t1",
        "--as",
        "codex",
        "--terminal-id",
        "term-w1-p1",
        "--repo-root",
        "/other-repository",
      ),
    /has no live foreground codex process rooted at \/other-repository/u,
  );
  identityState = JSON.parse(readFileSync(statePath, "utf8"));
  identityState.panes["w1:p1"].agent_session.value = "codex-session-w1-p1";
  writeFileSync(statePath, `${JSON.stringify(identityState, null, 2)}\n`);

  const created = JSON.parse(run("init"));
  assert.equal(created.schema_version, 3);
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
    /recorded partner is no longer the partner agent/u,
  );
  recycledState.panes["w1:p2"].terminal_id = "term-w1-p2";
  writeFileSync(statePath, `${JSON.stringify(recycledState, null, 2)}\n`);

  // A replacement conversation in the SAME pane and terminal must not inherit
  // the pair for CLIs whose session ids are stable.
  recycledState.panes["w1:p2"].agent_session.value = "claude-session-replacement";
  writeFileSync(statePath, `${JSON.stringify(recycledState, null, 2)}\n`);
  assert.throws(
    () => run("verify"),
    /recorded partner is no longer the partner agent/u,
  );

  // Codex rolls its thread id after compaction and reports subagent thread ids
  // while delegating. Matching pane and terminal identity must survive either
  // non-null id change.
  recycledState.panes["w1:p2"].agent_session.value = "claude-session-w1-p2";
  recycledState.panes["w1:p1"].agent_session.value = "codex-session-replacement";
  writeFileSync(statePath, `${JSON.stringify(recycledState, null, 2)}\n`);
  assert.equal(JSON.parse(run("verify")).session.sid, created.sid);
  recycledState.panes["w1:p1"].agent_session.value = "codex-session-w1-p1";
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

  // Herdr can report the matching pane and terminal before it re-attaches the
  // live agent_session metadata. That is unreported, not a replacement
  // conversation; keep the recorded id and let the next verify backfill it.
  const unreportedSessionState = JSON.parse(readFileSync(statePath, "utf8"));
  unreportedSessionState.panes["w1:p1"].agent_session = null;
  writeFileSync(statePath, `${JSON.stringify(unreportedSessionState, null, 2)}\n`);
  const unreported = JSON.parse(run("verify")).session;
  assert.equal(unreported.participants.codex.agent_session_id, "codex-session-w1-p1");
  unreportedSessionState.panes["w1:p1"].agent_session = {
    agent: "codex",
    kind: "id",
    source: "herdr:codex",
    value: "codex-session-w1-p1",
  };
  writeFileSync(statePath, `${JSON.stringify(unreportedSessionState, null, 2)}\n`);

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
  const shellExecutionMarker = join(root, "unexpected-shell-execution");
  const shellMetaRepo = `/workspace with 'quotes' $(touch ${shellExecutionMarker}) \`false\``;
  for (const pane of Object.values(state.panes)) {
    pane.cwd = shellMetaRepo;
    pane.foreground_cwd = shellMetaRepo;
  }
  state.processes["w1:p2"][0].cwd = shellMetaRepo;
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
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
  assert.match(
    message,
    /receive '--pane' 'w1:p2' '--workspace' 'w1' '--tab-id' 'w1:t1' '--as' 'claude'/u,
  );
  assert.equal(
    message.includes(
      `'--repo-root' '/workspace with '"'"'quotes'"'"' $(touch ${shellExecutionMarker}) \`false\`'`,
    ),
    true,
  );
  const receiveCommand = message.match(
    /\[herdr-pair control seq=1: run (.+) before doing work\./su,
  )?.[1];
  assert.ok(receiveCommand);
  const quoteProbeBin = join(root, "quote-probe-bin");
  const quoteProbeNode = join(quoteProbeBin, "node");
  mkdirSync(quoteProbeBin);
  writeFileSync(quoteProbeNode, "#!/bin/sh\nprintf '%s\\n' \"$@\"\n");
  chmodSync(quoteProbeNode, 0o755);
  const receiveArgv = execFileSync("/bin/sh", ["-c", receiveCommand], {
    encoding: "utf8",
    env: { ...env, PATH: `${quoteProbeBin}:${env.PATH}` },
  }).trimEnd().split("\n");
  assert.deepEqual(receiveArgv.slice(0, 4), [
    helper,
    "receive",
    "--pane",
    "w1:p2",
  ]);
  assert.equal(receiveArgv[receiveArgv.indexOf("--tab-id") + 1], "w1:t1");
  assert.equal(receiveArgv[receiveArgv.indexOf("--repo-root") + 1], shellMetaRepo);
  assert.equal(existsSync(shellExecutionMarker), false);
  assert.match(message, /never as visible text in this pane/u);
  // `agent prompt` pastes without reliably submitting, so a send that skips
  // the Enter leaves the message in the partner's composer and the pair
  // stalls in silence. Guard it here: this has regressed before.
  assert.equal(fake.enter_keys, 1, "send must follow the paste with an Enter");
  assert.deepEqual(fake.last_send_keys, { pane: "w1:p2", key: "enter" });
  state = JSON.parse(readFileSync(statePath, "utf8"));
  for (const pane of Object.values(state.panes)) {
    pane.cwd = "/workspace";
    pane.foreground_cwd = "/workspace";
  }
  state.processes["w1:p2"][0].cwd = "/workspace";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

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
  // The two kinds this pair does not use stay absent, never pending.
  assert.deepEqual(session.last_status, {
    claude: "accepted",
    codex: "accepted",
    cursor: null,
    grok: null,
    opencode: null,
  });
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
  assert.deepEqual(reset.last_status, { claude: null, codex: null, cursor: null, grok: null, opencode: null });
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
  assert.equal(repaired.schema_version, 3);
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
    legacySessionPath,
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
  // A pre-universal session is refused, never rewritten, and the refusal names
  // the exact end command that clears the way for a new pair.
  for (const command of ["verify", "init", "reset"]) {
    assert.throws(
      () => run(command),
      /schema unset predates the universal pair \(schema 3\)[\s\S]*--sid 'legacy-1' --stale true/u,
      `${command} must refuse a pre-universal session`,
    );
  }
  assert.throws(
    () => run("verify"),
    /end '--pane' 'w1:p1'/u,
    "the refusal must carry the caller's own pin",
  );
  assert.equal(existsSync(`${legacyDirectory}.init.lock`), false);
  // Ending it is the way out, and it leaves nothing behind for the next pair.
  run("end", "--sid", "legacy-1", "--stale", "true");
  assert.equal(existsSync(legacySessionPath), false);

  let migrated = JSON.parse(run("init"));
  assert.equal(migrated.schema_version, 3);
  assert.equal(migrated.role, "peer");
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
  run("end", "--sid", migrated.sid);
  mkdirSync(legacyDirectory, { recursive: true });
  migrated = { ...migrated, sid: "legacy-1" };
  const future = { ...migrated, schema_version: 99 };
  writeFileSync(legacySessionPath, `${JSON.stringify(future, null, 2)}\n`);
  assert.throws(() => run("init"), /session schema 99 is newer/u);
  assert.equal(existsSync(`${legacyDirectory}.init.lock`), false);
  // A session written under the legacy single-pair name still resumes and
  // still ends by its own sid.
  writeFileSync(legacySessionPath, `${JSON.stringify(migrated, null, 2)}\n`);
  const legacyResumed = JSON.parse(run("init"));
  assert.equal(legacyResumed.resumed, true, "a legacy session.json must still resume");
  assert.equal(legacyResumed.sid, "legacy-1");
  assert.equal(JSON.parse(run("verify", "--sid", "legacy-1")).session.sid, "legacy-1");
  run("end", "--sid", "legacy-1");
  assert.equal(existsSync(legacySessionPath), false);

  mkdirSync(legacyDirectory, { recursive: true });
  writeFileSync(
    legacySessionPath,
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
  state.fail_process_info_pane = "w1:p2";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.throws(
    () => run("end", "--sid", rebound.sid, "--stale", "true"),
    /herdr pane process-info --pane w1:p2 failed: simulated process-info failure/u,
  );
  assert.equal(existsSync(sessionPath), true);
  delete state.fail_process_info_pane;
  state.malformed_process_info_pane = "w1:p2";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.throws(
    () => run("end", "--sid", rebound.sid, "--stale", "true"),
    /herdr did not return process info for exact pane w1:p2/u,
  );
  assert.equal(existsSync(sessionPath), true);
  delete state.malformed_process_info_pane;
  state.processes["w1:p2"][0].cwd = "/partner-moved-to-another-repository";
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
  assert.throws(
    () => run("end", "--sid", rebound.sid),
    /has no live foreground claude process rooted at \/workspace/u,
  );
  assert.equal(existsSync(sessionPath), true);
  run("end", "--sid", rebound.sid, "--stale", "true");
  assert.equal(existsSync(sessionPath), false);
  assert.equal(existsSync(otherTabDirectory), true);

  // Spawning derives the peer's agent name from the NEW pane, and herdr rejects
  // anything but 1-32 unique lowercase characters. Workspace ids carry
  // uppercase (wY:p1) and long ones overflow the limit — both broke the spawn.
  const longSpawnPane = "w655f3dd90835016:p123";
  const longSpawnName = `pair-cursor-${createHash("sha256")
    .update(`${longSpawnPane}s`)
    .digest("hex")
    .slice(0, 8)}`;
  for (const [paneId, tabId, workspaceId, expected, paneCwd, repoRoot, partner] of [
    ["wY:p1", "wY:t1", "wY", "pair-claude-wy_p1s", "/workspace", "/workspace", "claude"],
    [longSpawnPane, "w655f3dd90835016:t123", "w655f3dd90835016", longSpawnName, "/workspace", "/workspace", "cursor"],
    ["wZ:p1", "wZ:t1", "wZ", "pair-grok-wz_p1s", "/shell-home", "/workspace", "grok"],
    ["wQ:p1", "wQ:t1", "wQ", "pair-opencode-wq_p1s", "/workspace", "/workspace", "opencode"],
  ]) {
    const spawnState = JSON.parse(readFileSync(statePath, "utf8"));
    spawnState.panes = {
      [paneId]: {
        agent: "codex",
        agent_session: { value: `session-${paneId}` },
        agent_status: "working", cwd: paneCwd,
        foreground_cwd: repoRoot,
        pane_id: paneId, tab_id: tabId, terminal_id: `term-${paneId}`,
        workspace_id: workspaceId,
      },
    };
    spawnState.processes = {
      [paneId]: [{ argv: ["codex"], cwd: repoRoot, name: "codex" }],
    };
    delete spawnState.last_agent_name;
    writeFileSync(statePath, `${JSON.stringify(spawnState, null, 2)}\n`);
    runRaw(
      "spawn",
      "--pane",
      paneId,
      "--workspace",
      workspaceId,
      "--tab-id",
      tabId,
      "--as",
      "codex",
      "--terminal-id",
      `term-${paneId}`,
      "--repo-root",
      repoRoot,
      "--partner",
      partner,
    );
    const spawnedState = JSON.parse(readFileSync(statePath, "utf8"));
    const named = spawnedState.last_agent_name;
    assert.equal(named, expected, `spawn used an agent name herdr would reject: ${named}`);
    assert.match(named, /^[a-z][a-z0-9_-]{0,31}$/u);
    const spawned = spawnedState.panes[`${paneId}s`];
    assert.equal(spawned.cwd, repoRoot);
    assert.equal(spawned.agent, partner, "the spawned pane must run the requested CLI");
  }

  // Model and effort reach the new pane as the partner CLI's own arguments,
  // after `--`, and each CLI takes them through its own door.
  for (const [partner, extra, expected] of [
    ["grok", ["--model", "grok-5", "--effort", "high"], ["--", "-m", "grok-5", "--reasoning-effort", "high"]],
    ["codex", ["--model", "gpt-5", "--effort", "high"], ["--", "-m", "gpt-5", "-c", 'model_reasoning_effort="high"']],
    ["cursor", ["--model", "claude-opus-4-8", "--effort", "high"], ["--", "--model", "claude-opus-4-8[effort=high]"]],
    ["claude", ["--model", "opus", "--effort", "xhigh"], ["--", "--effort", "xhigh", "--model", "opus"]],
    ["claude", ["--model", "opus"], ["--", "--model", "opus"]],
    ["claude", [], []],
    ["opencode", ["--model", "provider/model"], ["--", "-m", "provider/model"]],
    // --autonomy full launches the partner past its permission prompts, each
    // CLI through its own verified flag.
    ["claude", ["--autonomy", "full"], ["--", "--permission-mode", "bypassPermissions"]],
    ["grok", ["--autonomy", "full", "--model", "grok-5"], ["--", "--always-approve", "-m", "grok-5"]],
    ["codex", ["--autonomy", "full"], ["--", "-a", "never", "-s", "danger-full-access"]],
    ["cursor", ["--autonomy", "full"], ["--", "--force"]],
    ["opencode", ["--autonomy", "full"], ["--", "--auto"]],
  ]) {
    // The lead is any CLI other than the one being spawned.
    const lead = partner === "grok" ? "claude" : "grok";
    const spawnState = JSON.parse(readFileSync(statePath, "utf8"));
    spawnState.panes = {
      "wM:p1": {
        agent: lead, agent_session: { value: "session-wM" }, agent_status: "idle",
        cwd: "/workspace", foreground_cwd: "/workspace", pane_id: "wM:p1",
        tab_id: "wM:t1", terminal_id: "term-wM-p1", workspace_id: "wM",
      },
    };
    spawnState.processes = { "wM:p1": [{ argv: [lead], cwd: "/workspace", name: lead }] };
    delete spawnState.last_agent_start_argv;
    writeFileSync(statePath, `${JSON.stringify(spawnState, null, 2)}\n`);
    runRaw(
      "spawn", "--pane", "wM:p1", "--workspace", "wM", "--tab-id", "wM:t1",
      "--as", lead, "--terminal-id", "term-wM-p1", "--repo-root", "/workspace",
      "--partner", partner, ...extra,
    );
    const argv = JSON.parse(readFileSync(statePath, "utf8")).last_agent_start_argv;
    assert.deepEqual(argv.slice(argv.indexOf("60000") + 1), expected, `${partner} agent arguments`);
  }

  // OpenCode documents --variant on `opencode run`, but Herdr starts its TUI.
  // Refuse an effort instead of forwarding a flag that the TUI does not own.
  {
    const spawnState = JSON.parse(readFileSync(statePath, "utf8"));
    spawnState.panes = {
      "wV:p1": {
        agent: "claude", agent_session: { value: "session-wV" }, agent_status: "idle",
        cwd: "/workspace", foreground_cwd: "/workspace", pane_id: "wV:p1",
        tab_id: "wV:t1", terminal_id: "term-wV-p1", workspace_id: "wV",
      },
    };
    spawnState.processes = { "wV:p1": [{ argv: ["claude"], cwd: "/workspace", name: "claude" }] };
    writeFileSync(statePath, `${JSON.stringify(spawnState, null, 2)}\n`);
    assert.throws(
      () => runRaw(
        "spawn", "--pane", "wV:p1", "--workspace", "wV", "--tab-id", "wV:t1",
        "--as", "claude", "--terminal-id", "term-wV-p1", "--repo-root", "/workspace",
        "--partner", "opencode", "--effort", "high",
      ),
      /OpenCode exposes --variant only on `opencode run`/u,
    );
  }

  // Keep the pane mappings pinned to the installed CLIs' help contracts. A
  // missing optional CLI skips only this live check; fixture-based mapping
  // tests above still run in every environment.
  for (const [command, contracts] of [
    ["claude", [
      /--permission-mode <mode>/u,
      /bypassPermissions/u,
      /--effort <level>/u,
      /low, medium, high, xhigh, max/u,
    ]],
    ["grok", [
      /--always-approve/u,
      /--permission-mode <MODE>/u,
      /dontAsk/u,
      /bypassPermissions/u,
    ]],
    ["codex", [
      /--ask-for-approval <APPROVAL_POLICY>/u,
      /never/u,
      /--sandbox <SANDBOX_MODE>/u,
      /danger-full-access/u,
    ]],
    ["cursor-agent", [/-f, --force/u]],
    ["opencode", [/-m, --model/u, /--auto/u]],
  ]) {
    const help = installedCliHelp(command);
    if (help === null) continue;
    for (const contract of contracts) {
      assert.match(help, contract, `${command} --help no longer exposes ${contract}`);
    }
  }

  // A pane of the caller's own CLI is not a partner: it echoes rather than reviews.
  {
    const sameState = JSON.parse(readFileSync(statePath, "utf8"));
    sameState.panes = {
      "wS:p1": {
        agent: "codex", agent_session: { value: "s1" }, agent_status: "idle",
        cwd: "/workspace", foreground_cwd: "/workspace", pane_id: "wS:p1",
        tab_id: "wS:t1", terminal_id: "term-wS-p1", workspace_id: "wS",
      },
      "wS:p2": {
        agent: "codex", agent_session: { value: "s2" }, agent_status: "idle",
        cwd: "/workspace", foreground_cwd: "/workspace", pane_id: "wS:p2",
        tab_id: "wS:t1", terminal_id: "term-wS-p2", workspace_id: "wS",
      },
    };
    sameState.processes = {
      "wS:p1": [{ argv: ["codex"], cwd: "/workspace", name: "codex" }],
      "wS:p2": [{ argv: ["codex"], cwd: "/workspace", name: "codex" }],
    };
    writeFileSync(statePath, `${JSON.stringify(sameState, null, 2)}\n`);
    const samePin = [
      "--pane", "wS:p1", "--workspace", "wS", "--tab-id", "wS:t1",
      "--as", "codex", "--terminal-id", "term-wS-p1", "--repo-root", "/workspace",
    ];
    assert.throws(
      () => runRaw("init", ...samePin),
      /refusing to pair codex with itself/u,
    );
  }

  // A cursor lead and a grok partner is one pair like any other.
  {
    const mixedState = JSON.parse(readFileSync(statePath, "utf8"));
    mixedState.panes = {
      "wX:p1": {
        agent: "cursor", agent_session: { value: "cursor-1" }, agent_status: "idle",
        cwd: "/workspace", foreground_cwd: "/workspace", pane_id: "wX:p1",
        tab_id: "wX:t1", terminal_id: "term-wX-p1", workspace_id: "wX",
      },
      "wX:p2": {
        agent: "grok", agent_session: { value: "grok-1" }, agent_status: "idle",
        cwd: "/workspace", foreground_cwd: "/workspace", pane_id: "wX:p2",
        tab_id: "wX:t1", terminal_id: "term-wX-p2", workspace_id: "wX",
      },
    };
    mixedState.processes = {
      "wX:p1": [{ argv: ["cursor-agent"], argv0: "cursor-agent", cwd: "/workspace", name: "cursor-agent" }],
      "wX:p2": [{ argv: ["grok"], cwd: "/workspace", name: "grok" }],
    };
    mixedState.auto_ack = true;
    writeFileSync(statePath, `${JSON.stringify(mixedState, null, 2)}\n`);
    const cursorPin = [
      "--pane", "wX:p1", "--workspace", "wX", "--tab-id", "wX:t1",
      "--as", "cursor", "--terminal-id", "term-wX-p1", "--repo-root", "/workspace",
    ];
    const mixed = JSON.parse(runRaw("init", ...cursorPin, "--role", "executor"));
    assert.equal(mixed.role, "executor");
    assert.equal(mixed.initiator, "cursor");
    assert.deepEqual(Object.keys(mixed.participants).sort(), ["cursor", "grok"]);
    const mixedBody = join(root, "mixed-body.txt");
    writeFileSync(mixedBody, "own the parser scope\n");
    const mixedSent = runRaw(
      "send", ...cursorPin,
      "--sid", mixed.sid, "--kind", "task", "--body-file", mixedBody,
      "--ack-timeout-ms", "1000",
    );
    assert.match(mixedSent, /^\[agent cursor -> grok kind=task sid=/u);
    assert.match(mixedSent, /receipt=acknowledged/u);
    const mixedSession = JSON.parse(
      readFileSync(join(home, ".herdr-coworkers", "wX", "wX_t1", "pair-wX_p2.json"), "utf8"),
    );
    assert.equal(mixedSession.delivery.received.cursor, 1);
    runRaw("end", ...cursorPin, "--sid", mixed.sid);
  }

  // A fresh split can report agent_pane_busy while its shell is still coming
  // up; the spawn retries through that window instead of failing, and a spawn
  // that does fail closes its own split pane instead of orphaning it.
  {
    const busyState = JSON.parse(readFileSync(statePath, "utf8"));
    busyState.panes = {
      "wB:p1": {
        agent: "claude", agent_session: { value: "claude-b" }, agent_status: "idle",
        cwd: "/workspace", foreground_cwd: "/workspace", pane_id: "wB:p1",
        tab_id: "wB:t1", terminal_id: "term-wB-p1", workspace_id: "wB",
      },
    };
    busyState.processes = { "wB:p1": [{ argv: ["claude"], cwd: "/workspace", name: "claude" }] };
    busyState.agent_start_busy_remaining = 2;
    writeFileSync(statePath, `${JSON.stringify(busyState, null, 2)}\n`);
    const busyPin = [
      "--pane", "wB:p1", "--workspace", "wB", "--tab-id", "wB:t1",
      "--as", "claude", "--terminal-id", "term-wB-p1", "--repo-root", "/workspace",
    ];
    const spawned = JSON.parse(runRaw("spawn", ...busyPin, "--partner", "grok"));
    assert.equal(spawned.partner.agent, "grok");
    const afterBusy = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(afterBusy.agent_start_busy_remaining, 0);
    assert.equal(afterBusy.panes["wB:p1s"].agent, "grok");

    const orphanState = JSON.parse(readFileSync(statePath, "utf8"));
    orphanState.panes = {
      "wO:p1": {
        agent: "claude", agent_session: { value: "claude-o" }, agent_status: "idle",
        cwd: "/workspace", foreground_cwd: "/workspace", pane_id: "wO:p1",
        tab_id: "wO:t1", terminal_id: "term-wO-p1", workspace_id: "wO",
      },
    };
    orphanState.processes = { "wO:p1": [{ argv: ["claude"], cwd: "/workspace", name: "claude" }] };
    orphanState.fail_agent_start = true;
    orphanState.pane_tails = {
      "wO:p1s": "claude: CLI boot failed: authentication expired\n",
    };
    writeFileSync(statePath, `${JSON.stringify(orphanState, null, 2)}\n`);
    assert.throws(
      () => runRaw(
        "spawn", "--pane", "wO:p1", "--workspace", "wO", "--tab-id", "wO:t1",
        "--as", "claude", "--terminal-id", "term-wO-p1", "--repo-root", "/workspace",
        "--partner", "grok",
      ),
      /simulated agent start failure[\s\S]*CLI boot failed: authentication expired/u,
    );
    const afterOrphan = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(afterOrphan.panes["wO:p1s"], undefined, "a failed spawn must close its split pane");
    assert.deepEqual(afterOrphan.mutations.at(-1), { command: "pane close", pane: "wO:p1s" });
    delete afterOrphan.fail_agent_start;
    writeFileSync(statePath, `${JSON.stringify(afterOrphan, null, 2)}\n`);
  }

  // An established pair follows its recorded panes: a third agent joining the
  // tab later must not silence verify/send/end. Forming a NEW pair there still
  // refuses — one pair per tab.
  {
    const crowdState = JSON.parse(readFileSync(statePath, "utf8"));
    crowdState.panes = {
      "wT:p1": {
        agent: "claude", agent_session: { value: "claude-t" }, agent_status: "idle",
        cwd: "/workspace", foreground_cwd: "/workspace", pane_id: "wT:p1",
        tab_id: "wT:t1", terminal_id: "term-wT-p1", workspace_id: "wT",
      },
      "wT:p2": {
        agent: "grok", agent_session: { value: "grok-t2" }, agent_status: "idle",
        cwd: "/workspace", foreground_cwd: "/workspace", pane_id: "wT:p2",
        tab_id: "wT:t1", terminal_id: "term-wT-p2", workspace_id: "wT",
      },
    };
    crowdState.processes = {
      "wT:p1": [{ argv: ["claude"], cwd: "/workspace", name: "claude" }],
      "wT:p2": [{ argv: ["grok"], cwd: "/workspace", name: "grok" }],
    };
    writeFileSync(statePath, `${JSON.stringify(crowdState, null, 2)}\n`);
    const crowdPin = [
      "--pane", "wT:p1", "--workspace", "wT", "--tab-id", "wT:t1",
      "--as", "claude", "--terminal-id", "term-wT-p1", "--repo-root", "/workspace",
    ];
    const crowded = JSON.parse(runRaw("init", ...crowdPin));

    const withThird = JSON.parse(readFileSync(statePath, "utf8"));
    withThird.panes["wT:p3"] = {
      agent: "grok", agent_session: { value: "grok-t3" }, agent_status: "idle",
      cwd: "/workspace", foreground_cwd: "/workspace", pane_id: "wT:p3",
      tab_id: "wT:t1", terminal_id: "term-wT-p3", workspace_id: "wT",
    };
    withThird.processes["wT:p3"] = [{ argv: ["grok"], cwd: "/workspace", name: "grok" }];
    writeFileSync(statePath, `${JSON.stringify(withThird, null, 2)}\n`);

    const crowdDiscovered = JSON.parse(runRaw("discover", ...crowdPin));
    assert.deepEqual(
      crowdDiscovered.candidates,
      [
        { pane_id: "wT:p2", agent: "grok", paired: true },
        { pane_id: "wT:p3", agent: "grok", paired: false },
      ],
      "discover must mark the paired pane and still offer the free one",
    );
    assert.deepEqual(crowdDiscovered.sessions.map((entry) => entry.sid), [crowded.sid]);
    const verified = JSON.parse(runRaw("verify", ...crowdPin));
    assert.equal(verified.partner.pane_id, "wT:p2", "verify must follow the recorded partner pane");
    // init resumes through the recorded panes too: it must not re-run the
    // FORMING-only exactly-two gate on a session that already exists.
    const resumedCrowded = JSON.parse(runRaw("init", ...crowdPin));
    assert.equal(resumedCrowded.resumed, true, "init must resume with a third agent pane in the tab");
    assert.equal(resumedCrowded.sid, crowded.sid);
    const crowdBody = join(root, "crowd-body.txt");
    writeFileSync(crowdBody, "still your pair\n");
    const crowdSent = runRaw(
      "send", ...crowdPin,
      "--sid", crowded.sid, "--kind", "task", "--body-file", crowdBody,
      "--ack-timeout-ms", "1000",
    );
    assert.match(crowdSent, /^\[agent claude -> grok kind=task sid=/u);
    runRaw("end", ...crowdPin, "--sid", crowded.sid);
    assert.equal(
      existsSync(join(home, ".herdr-coworkers", "wT", "wT_t1", "pair-wT_p2.json")),
      false,
      "end must work with a third agent pane in the tab",
    );
  }

  // Multi-pair: one lead pane holds several concurrent pairs in the same tab.
  // Each pair is its own sid-scoped session file, and every command names the
  // pair it means.
  {
    const leadState = JSON.parse(readFileSync(statePath, "utf8"));
    leadState.panes = {
      "wP:p1": {
        agent: "claude", agent_session: { value: "claude-p" }, agent_status: "idle",
        cwd: "/workspace", foreground_cwd: "/workspace", pane_id: "wP:p1",
        tab_id: "wP:t1", terminal_id: "term-wP-p1", workspace_id: "wP",
      },
    };
    leadState.processes = { "wP:p1": [{ argv: ["claude"], cwd: "/workspace", name: "claude" }] };
    leadState.auto_ack = true;
    leadState.mutations = [];
    writeFileSync(statePath, `${JSON.stringify(leadState, null, 2)}\n`);
    const leadPin = [
      "--pane", "wP:p1", "--workspace", "wP", "--tab-id", "wP:t1",
      "--as", "claude", "--terminal-id", "term-wP-p1", "--repo-root", "/workspace",
    ];
    const leadDirectory = join(home, ".herdr-coworkers", "wP", "wP_t1");
    const pairFile = (paneId) => join(leadDirectory, `pair-${paneId.replaceAll(":", "_")}.json`);

    // Two partners of the SAME kind in one tab. herdr refuses a duplicate
    // agent name, so a name derived from the tab would fail the second spawn.
    const first = JSON.parse(runRaw("spawn", ...leadPin, "--partner", "grok"));
    const firstName = JSON.parse(readFileSync(statePath, "utf8")).last_agent_name;
    const second = JSON.parse(runRaw("spawn", ...leadPin, "--partner", "grok"));
    const secondName = JSON.parse(readFileSync(statePath, "utf8")).last_agent_name;
    assert.notEqual(first.partner.pane_id, second.partner.pane_id);
    assert.notEqual(firstName, secondName, "each spawned partner needs its own agent name");
    // A named pane that already runs the requested CLI is reused, never split
    // again: a retried spawn must not pile up partners.
    const paneCountBeforeReuse = Object.keys(
      JSON.parse(readFileSync(statePath, "utf8")).panes,
    ).length;
    const reused = JSON.parse(
      runRaw("spawn", ...leadPin, "--partner", "grok", "--partner-pane", first.partner.pane_id),
    );
    assert.equal(reused.partner.pane_id, first.partner.pane_id);
    assert.equal(
      Object.keys(JSON.parse(readFileSync(statePath, "utf8")).panes).length,
      paneCountBeforeReuse,
      "a spawn that reuses a named partner pane must not split a new one",
    );

    const spawnedPanes = JSON.parse(readFileSync(statePath, "utf8")).panes;
    assert.equal(spawnedPanes[first.partner.pane_id].agent, "grok");
    assert.equal(spawnedPanes[second.partner.pane_id].agent, "grok");

    // Two free candidates is an ambiguity to name, never one to guess.
    assert.throws(() => runRaw("init", ...leadPin), /name one with --partner-pane/u);
    const pairA = JSON.parse(runRaw("init", ...leadPin, "--partner-pane", first.partner.pane_id));
    const pairB = JSON.parse(runRaw("init", ...leadPin, "--partner-pane", second.partner.pane_id));
    assert.notEqual(pairA.sid, pairB.sid, "two pairs in one tab need two sids");
    assert.equal(pairA.participants.grok.pane_id, first.partner.pane_id);
    assert.equal(pairB.participants.grok.pane_id, second.partner.pane_id);
    assert.equal(existsSync(pairFile(first.partner.pane_id)), true);
    assert.equal(existsSync(pairFile(second.partner.pane_id)), true);
    const resumedA = JSON.parse(
      runRaw("init", ...leadPin, "--partner-pane", first.partner.pane_id),
    );
    assert.equal(resumedA.resumed, true, "init for an already-paired pane resumes it");
    assert.equal(resumedA.sid, pairA.sid);

    // Without a sid nothing is guessed: the refusal lists what to name.
    assert.throws(
      () => runRaw("verify", ...leadPin),
      new RegExp(`holds 2 pair sessions[\\s\\S]*${pairA.sid}[\\s\\S]*${pairB.sid}`, "u"),
    );
    assert.equal(
      JSON.parse(runRaw("verify", ...leadPin, "--sid", pairB.sid)).partner.pane_id,
      second.partner.pane_id,
    );

    // A send reaches the partner of ITS sid, and leaves the other pair alone.
    const multiBody = join(root, "multi-body.txt");
    writeFileSync(multiBody, "only for partner A\n");
    const beforeSend = JSON.parse(readFileSync(statePath, "utf8"));
    beforeSend.mutations = [];
    writeFileSync(statePath, `${JSON.stringify(beforeSend, null, 2)}\n`);
    const sentA = runRaw(
      "send", ...leadPin, "--sid", pairA.sid, "--kind", "task",
      "--body-file", multiBody, "--ack-timeout-ms", "1000",
    );
    assert.match(sentA, /receipt=acknowledged/u);
    assert.deepEqual(
      JSON.parse(readFileSync(statePath, "utf8"))
        .mutations.filter((mutation) => mutation.command === "agent prompt")
        .map((mutation) => mutation.pane),
      [first.partner.pane_id],
      "a send names its sid and reaches only that pair's partner",
    );
    assert.equal(
      JSON.parse(readFileSync(pairFile(first.partner.pane_id), "utf8")).delivery.received.claude,
      1,
    );
    assert.equal(
      JSON.parse(readFileSync(pairFile(second.partner.pane_id), "utf8")).delivery.received.claude,
      0,
      "the other pair's ledger stays untouched",
    );

    // Ending one pair ends only that one.
    runRaw("end", ...leadPin, "--sid", pairA.sid);
    assert.equal(existsSync(pairFile(first.partner.pane_id)), false);
    assert.equal(existsSync(pairFile(second.partner.pane_id)), true);
    assert.equal(
      JSON.parse(runRaw("verify", ...leadPin)).session.sid,
      pairB.sid,
      "the surviving pair resolves again without --sid",
    );
    runRaw("end", ...leadPin, "--sid", pairB.sid);
    assert.equal(existsSync(leadDirectory), false);
  }

  // Delivery proof. A `ready` was lost on 2026-08-07: the helper reported it
  // submitted in 443 ms and the partner's own session file never contained it.
  // The landing proof only asked whether the composer had STOPPED holding the
  // text, which is equally true of a paste that never arrived — and the fake
  // `pane read` returned "" so no test could ever see the difference.
  {
    const deliveryRoot = mkdtempSync(join(tmpdir(), "herdr-pair-delivery-"));
    const deliveryHome = join(deliveryRoot, "home");
    const deliveryRepo = join(deliveryRoot, "workspace");
    mkdirSync(deliveryHome, { recursive: true });
    mkdirSync(deliveryRepo, { recursive: true });
    execFileSync("git", ["init", "-q", deliveryRepo]);
    const deliveryState = join(deliveryRoot, "state.json");
    const deliveryEnv = { ...env, HOME: deliveryHome, FAKE_HERDR_STATE: deliveryState };
    const deliveryBody = join(deliveryRoot, "body.txt");
    // Multi-line on purpose: this is the shape both harnesses collapse.
    writeFileSync(deliveryBody, "line one\nline two\nline three\n");

    const panes = {
      "w1:p1": {
        agent: "codex", agent_status: "idle", cwd: deliveryRepo, foreground_cwd: deliveryRepo,
        pane_id: "w1:p1", tab_id: "w1:t1", terminal_id: "term-w1-p1", workspace_id: "w1",
      },
      "w1:p2": {
        agent: "claude", agent_status: "idle", cwd: deliveryRepo, foreground_cwd: deliveryRepo,
        pane_id: "w1:p2", tab_id: "w1:t1", terminal_id: "term-w1-p2", workspace_id: "w1",
      },
    };
    const writeDeliveryState = (extra) =>
      writeFileSync(
        deliveryState,
        `${JSON.stringify(
          {
            panes: JSON.parse(JSON.stringify(panes)),
            processes: {
              "w1:p1": [{ name: "codex", argv: ["codex"], cwd: deliveryRepo, pid: 4001 }],
              "w1:p2": [{ name: "claude", argv: ["claude"], cwd: deliveryRepo, pid: 4002 }],
            },
            ancestor_panes: ["w1:p1"],
            mutations: [],
            auto_ack: true,
            ...extra,
          },
          null,
          2,
        )}\n`,
      );
    const deliveryRun = (...args) =>
      execFileSync(process.execPath, [helper, ...args], { encoding: "utf8", env: deliveryEnv });
    const pin = [
      "--pane", "w1:p1", "--workspace", "w1", "--tab-id", "w1:t1",
      "--as", "codex", "--terminal-id", "term-w1-p1", "--repo-root", deliveryRepo,
    ];
    const startSession = (extra) => {
      writeDeliveryState(extra);
      rmSync(join(deliveryHome, ".herdr-coworkers"), { recursive: true, force: true });
      return JSON.parse(deliveryRun("init", ...pin)).sid;
    };

    // A collapsed paste still delivers. The composer shows a summary line, never
    // the message, so arrival can only be proved by the composer CHANGING.
    let sid = startSession({});
    const delivered = deliveryRun(
      "send", ...pin, "--sid", sid, "--kind", "task", "--body-file", deliveryBody,
      "--ack-timeout-ms", "2000",
    );
    assert.match(delivered, /receipt=acknowledged/u);
    const collapsed = JSON.parse(readFileSync(deliveryState, "utf8"));
    assert.equal(collapsed.enter_keys, 1, "a delivered paste still needs exactly one Enter");
    assert.equal(
      collapsed.mutations.filter((mutation) => mutation.command === "agent prompt").length,
      1,
      "an idle delivery that lands must not resend the full prompt",
    );

    // A prompt sent while the partner is already working enters Herdr's queue
    // without appearing in the composer. That unobservable queue must get one
    // prompt only: Enter or a full resend can duplicate the same sequence.
    const busyPanes = JSON.parse(JSON.stringify(panes));
    busyPanes["w1:p2"].agent_status = "working";
    sid = startSession({ panes: busyPanes, hide_composer_when_working: true });
    const queued = deliveryRun(
      "send", ...pin, "--sid", sid, "--kind", "task", "--body-file", deliveryBody,
      "--timeout-ms", "0", "--ack-timeout-ms", "2000",
    );
    assert.match(queued, /receipt=acknowledged/u);
    const hiddenQueue = JSON.parse(readFileSync(deliveryState, "utf8"));
    assert.equal(
      hiddenQueue.mutations.filter((mutation) => mutation.command === "agent prompt").length,
      1,
      "a working target must receive exactly one queued prompt",
    );
    assert.equal(hiddenQueue.enter_keys, 1, "a working target keeps the harmless Enter protection");

    // A working status is not proof that Herdr accepted the body. Model a
    // silent drop with no composer and no ACK; the helper must report the run
    // as unproven instead of claiming a queued delivery.
    sid = startSession({
      panes: busyPanes,
      drop_paste_when_working: true,
      auto_ack: false,
    });
    const droppedBusy = deliveryRun(
      "send", ...pin, "--sid", sid, "--kind", "task", "--body-file", deliveryBody,
      "--timeout-ms", "0", "--ack-timeout-ms", "200",
    );
    assert.match(droppedBusy, /receipt=unproven-working-inspect-that-pane-then-reconcile/u);
    assert.doesNotMatch(droppedBusy, /pending-partner-may-be-busy-do-not-retry/u);
    const lostBusy = JSON.parse(readFileSync(deliveryState, "utf8"));
    assert.equal(
      lostBusy.mutations.filter((mutation) => mutation.command === "agent prompt").length,
      1,
      "an unproved working delivery must not duplicate the full prompt",
    );
    assert.equal(lostBusy.enter_keys, 1, "a working delivery still gets one protective Enter");

    // A partner that was working at paste time but has settled PROVABLY idle
    // without acking did not run receive — "may be busy" would hide the loss.
    sid = startSession({
      panes: busyPanes,
      drop_paste_when_working: true,
      idle_after_prompt: true,
      auto_ack: false,
    });
    const settledIdle = deliveryRun(
      "send", ...pin, "--sid", sid, "--kind", "task", "--body-file", deliveryBody,
      "--timeout-ms", "0", "--ack-timeout-ms", "200",
    );
    assert.match(settledIdle, /receipt=lost-partner-idle-inspect-that-pane-then-reconcile/u);
    assert.doesNotMatch(settledIdle, /unproven-working/u);

    // If the composer visibly keeps the body after every Enter, the helper has
    // positive proof that it is unsubmitted. It must fail before recording a
    // submission, not downgrade that fact to an ambiguous receipt.
    sid = startSession({
      panes: busyPanes,
      show_composer_when_working: true,
      swallow_enter: true,
      auto_ack: false,
    });
    assert.throws(
      () =>
        deliveryRun(
          "send", ...pin, "--sid", sid, "--kind", "task", "--body-file", deliveryBody,
          "--timeout-ms", "0", "--ack-timeout-ms", "200",
        ),
      /never left the partner composer/u,
      "a body that survives every Enter must fail as visibly unsubmitted",
    );
    const stuckBusySession = JSON.parse(
      readFileSync(join(deliveryHome, ".herdr-coworkers", "w1", "w1_t1", "pair-w1_p2.json"), "utf8"),
    );
    assert.equal(stuckBusySession.delivery.pending.codex.seq, 1);
    assert.equal(stuckBusySession.delivery.pending.codex.submitted_at, null);
    const stuckBusy = JSON.parse(readFileSync(deliveryState, "utf8"));
    assert.equal(
      stuckBusy.mutations.filter((mutation) => mutation.command === "agent prompt").length,
      1,
      "a visibly stuck working delivery must not resend the full prompt",
    );
    assert.equal(stuckBusy.enter_keys, 3, "the working path exhausts its Enter protection before failure");

    // The regression itself: the paste never lands. This must fail loudly and
    // keep the reservation pending, not report a delivery that did not happen.
    sid = startSession({ drop_paste: true, working_on_prompt: false });
    assert.throws(
      () =>
        deliveryRun(
          "send", ...pin, "--sid", sid, "--kind", "task", "--body-file", deliveryBody,
          "--ack-timeout-ms", "200",
        ),
      /never reached the partner composer/u,
      "a paste that never arrives must not be reported as delivered",
    );
    const lostSession = JSON.parse(
      readFileSync(join(deliveryHome, ".herdr-coworkers", "w1", "w1_t1", "pair-w1_p2.json"), "utf8"),
    );
    assert.equal(lostSession.delivery.pending.codex.seq, 1);
    assert.equal(lostSession.delivery.pending.codex.submitted_at, null);
    const lostPaste = JSON.parse(readFileSync(deliveryState, "utf8"));
    assert.equal(
      lostPaste.mutations.filter((mutation) => mutation.command === "agent prompt").length,
      2,
      "an idle paste that never arrives gets exactly one full resend",
    );

    // An idle partner that never acknowledged did not receive the message.
    // Reporting "busy, do not retry" there is what hid the loss for an hour.
    sid = startSession({ auto_ack: false, working_on_prompt: false });
    const verdict = deliveryRun(
      "send", ...pin, "--sid", sid, "--kind", "task", "--body-file", deliveryBody,
      "--ack-timeout-ms", "200",
    );
    assert.match(verdict, /receipt=lost-partner-idle-inspect-that-pane-then-reconcile/u);

    // A partner that is genuinely working keeps the do-not-retry verdict: both
    // harnesses queue a submitted prompt, so that message is not lost.
    sid = startSession({ auto_ack: false });
    const busy = deliveryRun(
      "send", ...pin, "--sid", sid, "--kind", "task", "--body-file", deliveryBody,
      "--ack-timeout-ms", "200",
    );
    assert.match(busy, /receipt=pending-partner-may-be-busy-do-not-retry/u);

    // The heartbeat. A nudge reminds an idle partner of what it still owes —
    // an unacknowledged receive, or an open work cycle — and owes nothing else.
    {
      // Nothing owed: a fresh pair is left alone.
      sid = startSession({ working_on_prompt: false });
      const quiet = JSON.parse(deliveryRun("nudge", ...pin));
      assert.equal(quiet.nudged, false);
      assert.equal(quiet.reason, "no open obligation");

      // An unacknowledged delivery: the nudge names the exact receive.
      sid = startSession({ auto_ack: false, working_on_prompt: false });
      deliveryRun(
        "send", ...pin, "--sid", sid, "--kind", "task", "--body-file", deliveryBody,
        "--ack-timeout-ms", "200",
      );
      const reminded = JSON.parse(deliveryRun("nudge", ...pin));
      assert.equal(reminded.nudged, true);
      assert.equal(reminded.obligation.signature, "receive:1");
      const nudgeState = JSON.parse(readFileSync(deliveryState, "utf8"));
      assert.match(nudgeState.last_message, /^\[herdr-pair control nudge sid=/u);
      assert.match(nudgeState.last_message, /seq=1/u);

      // An open cycle after the ack: the partner still owes its status.
      sid = startSession({ working_on_prompt: false });
      const cycleSent = deliveryRun(
        "send", ...pin, "--sid", sid, "--kind", "task", "--body-file", deliveryBody,
        "--ack-timeout-ms", "2000",
      );
      assert.match(cycleSent, /receipt=acknowledged/u);
      const cycleNudge = JSON.parse(deliveryRun("nudge", ...pin));
      assert.equal(cycleNudge.nudged, true);
      assert.match(cycleNudge.obligation.signature, /^cycle:/u);
      const cycleState = JSON.parse(readFileSync(deliveryState, "utf8"));
      assert.match(cycleState.last_message, /work cycle is still open/u);

      // A working partner is never interrupted, whatever it owes.
      const busyNudgePanes = JSON.parse(JSON.stringify(panes));
      busyNudgePanes["w1:p2"].agent_status = "working";
      sid = startSession({ auto_ack: false });
      deliveryRun(
        "send", ...pin, "--sid", sid, "--kind", "task", "--body-file", deliveryBody,
        "--timeout-ms", "0", "--ack-timeout-ms", "200",
      );
      const busyNudge = JSON.parse(deliveryRun("nudge", ...pin));
      assert.equal(busyNudge.nudged, false);
      assert.equal(busyNudge.reason, "partner working");
    }

    execFileSync("trash", [deliveryRoot]);
  }

  process.stdout.write("herdr-pair tests: PASS\n");
} finally {
  if (existsSync(root)) execFileSync("trash", [root]);
}
