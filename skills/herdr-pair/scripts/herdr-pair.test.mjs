#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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
  const control = state.last_message.match(/\\[herdr-pair control seq=(\\d+): run node .*? receive .*? --seq (\\d+)/);
  const sender = state.last_message.match(/^\\[agent (claude|codex) ->/)?.[1];
  if (control && sender && state.auto_ack !== false && !droppedWhileWorking) {
    const sequence = Number(control[2]);
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
  const requestedCwd = args.includes("--cwd")
    ? args[args.indexOf("--cwd") + 1]
    : source.cwd;
  const pane = {
    agent: null, agent_status: "unknown", cwd: requestedCwd,
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
const sessionPath = join(home, ".herdr-coworkers", "w1", "w1_t1", "session.json");

const runRawWithEnv = (overrides, ...args) =>
  execFileSync(process.execPath, [helper, ...args], {
    encoding: "utf8",
    env: { ...env, ...overrides },
  });

try {
  // Caller identity is proven from live topology, two exact conversation
  // markers, and a matching foreground process. Session metadata is diagnostic.
  const markersFile = join(root, "conversation-markers.json");
  writeFileSync(
    markersFile,
    JSON.stringify({
      newest_user_request: "Newest user request: refactor Herdr identity.",
      recent_caller_output: "Caller marker: proving this exact conversation.",
    }),
  );
  const idHappy = JSON.parse(
    runRawWithEnv(
      { HERDR_PANE_ID: "stale:pane", HERDR_WORKSPACE_ID: "stale:workspace" },
      "id",
      "--as",
      "codex",
      "--repo-root",
      "/workspace",
      "--conversation-markers-file",
      markersFile,
    ),
  );
  assert.deepEqual(idHappy, {
    pane: "w1:p1",
    workspace_id: "w1",
    workspace_label: "workspace",
    tab_id: "w1:t1",
    terminal_id: "term-w1-p1",
    as: "codex",
    repo_root: "/workspace",
    proof: "conversation-markers",
    agent_session: "codex-session-w1-p1",
    session_binding_warning: null,
    args: [
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
      "/workspace",
    ],
  });
  assert.equal(
    runRaw(
      "id",
      "--as",
      "codex",
      "--repo-root",
      "/workspace",
      "--conversation-markers-file",
      markersFile,
      "--format",
      "shell",
    ).trim(),
    "'--pane' 'w1:p1' '--workspace' 'w1' '--tab-id' 'w1:t1' '--as' 'codex' '--terminal-id' 'term-w1-p1' '--repo-root' '/workspace'",
  );
  const formatShellMarker = join(root, "unexpected-format-shell-execution");
  const shellFormatRepo = `/workspace with 'quotes' $(touch ${formatShellMarker}) \`false\``;
  let quotedState = JSON.parse(readFileSync(statePath, "utf8"));
  quotedState.panes["w1:p1"].cwd = shellFormatRepo;
  quotedState.panes["w1:p1"].foreground_cwd = shellFormatRepo;
  writeFileSync(statePath, `${JSON.stringify(quotedState, null, 2)}\n`);
  const shellFormatOutput = runRaw(
    "id",
    "--as",
    "codex",
    "--repo-root",
    shellFormatRepo,
    "--conversation-markers-file",
    markersFile,
    "--format",
    "shell",
  ).trim();
  assert.equal(
    shellFormatOutput,
    `'--pane' 'w1:p1' '--workspace' 'w1' '--tab-id' 'w1:t1' '--as' 'codex' '--terminal-id' 'term-w1-p1' '--repo-root' '/workspace with '"'"'quotes'"'"' $(touch ${formatShellMarker}) \`false\`'`,
  );
  const shellFormatArgv = execFileSync(
    "/bin/sh",
    ["-c", `set -- ${shellFormatOutput}; printf '%s\\n' "$@"`],
    { encoding: "utf8" },
  ).trimEnd().split("\n");
  assert.deepEqual(shellFormatArgv, [
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
    shellFormatRepo,
  ]);
  assert.equal(existsSync(formatShellMarker), false);
  quotedState = JSON.parse(readFileSync(statePath, "utf8"));
  quotedState.panes["w1:p1"].cwd = "/workspace";
  quotedState.panes["w1:p1"].foreground_cwd = "/workspace";
  writeFileSync(statePath, `${JSON.stringify(quotedState, null, 2)}\n`);
  assert.throws(
    () => runRaw("id", "--as", "codex", "--repo-root", "/workspace"),
    /requires --conversation-markers-file/u,
  );

  // Process ancestry proves the caller with no markers at all: a parent cannot
  // be wrong about which pane its own child runs in.
  let ancestryState = JSON.parse(readFileSync(statePath, "utf8"));
  ancestryState.ancestor_panes = ["w1:p1"];
  writeFileSync(statePath, `${JSON.stringify(ancestryState, null, 2)}\n`);
  const byAncestry = JSON.parse(
    runRawWithEnv(
      { HERDR_PANE_ID: "stale:pane" },
      "id",
      "--as",
      "codex",
      "--repo-root",
      "/workspace",
    ),
  );
  assert.equal(byAncestry.pane, "w1:p1");
  assert.equal(byAncestry.proof, "process-ancestry");

  // Claiming to be the other harness is a caller mismatch, not a reason to guess.
  assert.throws(
    () => runRaw("id", "--as", "claude", "--repo-root", "/workspace"),
    /runs in a codex pane; --as claude does not match/u,
  );

  // Panes share ancestors further up, so a chain matching two panes proves
  // nothing and must fall all the way back to the marker proof.
  ancestryState = JSON.parse(readFileSync(statePath, "utf8"));
  ancestryState.ancestor_panes = ["w1:p1", "w1:p2"];
  writeFileSync(statePath, `${JSON.stringify(ancestryState, null, 2)}\n`);
  assert.equal(
    JSON.parse(
      runRaw(
        "id", "--as", "codex", "--repo-root", "/workspace",
        "--conversation-markers-file", markersFile,
      ),
    ).proof,
    "conversation-markers",
    "an ambiguous ancestry must never select a pane on its own",
  );
  assert.throws(
    () => runRaw("id", "--as", "codex", "--repo-root", "/workspace"),
    /process ancestry \(it matched zero or several panes\)/u,
  );
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
  assert.throws(
    () => runAs("w1:p2", "discover"),
    /expected exactly two agent panes/u,
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
  assert.throws(
    () => runAs("w1:p2", "discover"),
    /expected exactly two agent panes/u,
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
  assert.equal(withGatePane.partner.pane_id, "w1:p1");
  tokenState = JSON.parse(readFileSync(statePath, "utf8"));
  delete tokenState.panes["w1:p3"];
  delete tokenState.processes["w1:p3"];
  writeFileSync(statePath, `${JSON.stringify(tokenState, null, 2)}\n`);

  // One match plus one unreadable pane is not uniqueness: the unknown pane
  // could have been the real caller, so ancestry must abandon the path rather
  // than authorize the pane it happened to read.
  ancestryState = JSON.parse(readFileSync(statePath, "utf8"));
  ancestryState.ancestor_panes = ["w1:p1"];
  ancestryState.fail_process_info_pane = "w1:p2";
  writeFileSync(statePath, `${JSON.stringify(ancestryState, null, 2)}\n`);
  assert.throws(
    () => runRaw("id", "--as", "codex", "--repo-root", "/workspace"),
    /process ancestry \(it matched zero or several panes\)/u,
    "an unreadable candidate must never leave a false unique match",
  );
  ancestryState = JSON.parse(readFileSync(statePath, "utf8"));
  delete ancestryState.fail_process_info_pane;
  delete ancestryState.ancestor_panes;
  writeFileSync(statePath, `${JSON.stringify(ancestryState, null, 2)}\n`);
  assert.throws(
    () =>
      runRawWithEnv(
        { HERDR_ENV: "0" },
        "id",
        "--as",
        "codex",
        "--repo-root",
        "/workspace",
        "--conversation-markers-file",
        markersFile,
      ),
    /requires HERDR_ENV=1/u,
  );

  let identityState = JSON.parse(readFileSync(statePath, "utf8"));
  delete identityState.panes["w1:p1"].terminal_id;
  writeFileSync(statePath, `${JSON.stringify(identityState, null, 2)}\n`);
  assert.throws(
    () =>
      runRaw(
        "id",
        "--as",
        "codex",
        "--repo-root",
        "/workspace",
        "--conversation-markers-file",
        markersFile,
      ),
    /caller pane w1:p1 has no terminal_id; cannot pin identity/u,
  );
  identityState = JSON.parse(readFileSync(statePath, "utf8"));
  identityState.panes["w1:p1"].terminal_id = "term-w1-p1";
  writeFileSync(statePath, `${JSON.stringify(identityState, null, 2)}\n`);

  identityState.panes["w2:p1"] = {
    ...identityState.panes["w1:p1"],
    pane_id: "w2:p1",
    tab_id: "w2:t1",
    terminal_id: "term-w2-p1",
    workspace_id: "w2",
  };
  identityState.workspaces.w2 = { workspace_id: "w2", label: "duplicate-session" };
  identityState.transcripts["w2:p1"] = "A different Codex conversation.";
  for (const malformedProcess of [
    null,
    { argv: { 0: "codex" }, cwd: "/workspace", name: "codex" },
    { argv: null, cwd: "/workspace", name: "codex" },
    { argv: ["codex"], cwd: null, name: "codex" },
  ]) {
    identityState.processes["w2:p1"] = [malformedProcess];
    writeFileSync(statePath, `${JSON.stringify(identityState, null, 2)}\n`);
    assert.throws(
      () =>
        runRaw(
          "id",
          "--as",
          "codex",
          "--repo-root",
          "/workspace",
          "--conversation-markers-file",
          markersFile,
        ),
      /herdr returned malformed foreground process for pane w2:p1/u,
    );
    identityState = JSON.parse(readFileSync(statePath, "utf8"));
  }
  identityState.processes["w2:p1"] = [
    { argv: ["codex"], cwd: "/different-repository", name: "codex" },
  ];
  writeFileSync(statePath, `${JSON.stringify(identityState, null, 2)}\n`);

  const deadCandidateIgnored = JSON.parse(
    runRaw(
      "id",
      "--as",
      "codex",
      "--repo-root",
      "/workspace",
      "--conversation-markers-file",
      markersFile,
    ),
  );
  assert.equal(deadCandidateIgnored.pane, "w1:p1");
  identityState = JSON.parse(readFileSync(statePath, "utf8"));
  identityState.processes["w2:p1"][0].cwd = "/workspace";
  writeFileSync(statePath, `${JSON.stringify(identityState, null, 2)}\n`);

  const duplicateSession = JSON.parse(
    runRaw(
      "id",
      "--as",
      "codex",
      "--repo-root",
      "/workspace",
      "--conversation-markers-file",
      markersFile,
    ),
  );
  assert.equal(duplicateSession.pane, "w1:p1");
  assert.match(duplicateSession.session_binding_warning, /appears on 2 panes and was ignored/u);

  identityState = JSON.parse(readFileSync(statePath, "utf8"));
  identityState.transcripts["w2:p1"] = identityState.transcripts["w1:p1"];
  writeFileSync(statePath, `${JSON.stringify(identityState, null, 2)}\n`);
  assert.throws(
    () =>
      runRaw(
        "id",
        "--as",
        "codex",
        "--repo-root",
        "/workspace",
        "--conversation-markers-file",
        markersFile,
      ),
    /matched 2 candidate transcripts/u,
  );

  identityState = JSON.parse(readFileSync(statePath, "utf8"));
  identityState.transcripts["w2:p1"] = "";
  writeFileSync(statePath, `${JSON.stringify(identityState, null, 2)}\n`);
  assert.throws(
    () =>
      runRaw(
        "id",
        "--as",
        "codex",
        "--repo-root",
        "/workspace",
        "--conversation-markers-file",
        markersFile,
      ),
    /candidate transcript w2:p1 is empty/u,
  );

  identityState = JSON.parse(readFileSync(statePath, "utf8"));
  delete identityState.panes["w2:p1"];
  delete identityState.workspaces.w2;
  delete identityState.transcripts["w2:p1"];
  delete identityState.processes["w2:p1"];
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

  // Spawning derives the peer's agent name from the tab id, and herdr rejects
  // anything but 1-32 lowercase characters. Workspace ids carry uppercase
  // (wY:t1) and long ones overflow the limit — both broke the spawn outright.
  for (const [paneId, tabId, workspaceId, expected, paneCwd, repoRoot] of [
    ["wY:p1", "wY:t1", "wY", "pair-claude-wy_t1", "/workspace", "/workspace"],
    ["w655f3dd90835016:p1", "w655f3dd90835016:t123", "w655f3dd90835016", "pair-claude-f0e59f4e", "/workspace", "/workspace"],
    ["wZ:p1", "wZ:t1", "wZ", "pair-claude-wz_t1", "/shell-home", "/workspace"],
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
    );
    const named = JSON.parse(readFileSync(statePath, "utf8")).last_agent_name;
    assert.equal(named, expected, `spawn used an agent name herdr would reject: ${named}`);
    assert.match(named, /^[a-z][a-z0-9_-]{0,31}$/u);
    const spawned = JSON.parse(readFileSync(statePath, "utf8")).panes[`${paneId}s`];
    assert.equal(spawned.cwd, repoRoot);
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
      readFileSync(join(deliveryHome, ".herdr-coworkers", "w1", "w1_t1", "session.json"), "utf8"),
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
      readFileSync(join(deliveryHome, ".herdr-coworkers", "w1", "w1_t1", "session.json"), "utf8"),
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

    execFileSync("trash", [deliveryRoot]);
  }

  process.stdout.write("herdr-pair tests: PASS\n");
} finally {
  if (existsSync(root)) execFileSync("trash", [root]);
}
