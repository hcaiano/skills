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
import test from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));
const helper = join(directory, "caller-proof.mjs");
const root = mkdtempSync(join(tmpdir(), "caller-proof-test-"));
const bin = join(root, "bin");
const statePath = join(root, "herdr-state.json");
const fakeHerdr = join(bin, "herdr");

mkdirSync(bin, { recursive: true });

const agentSession = (agent, paneId) => ({
  agent,
  kind: "id",
  source: `herdr:${agent}`,
  value: `${agent}-session-${paneId.replace(":", "-")}`,
});

const baseState = () => ({
  panes: {
    "w1:p1": {
      agent: "codex",
      agent_session: agentSession("codex", "w1:p1"),
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
      agent_session: agentSession("claude", "w1:p2"),
      agent_status: "idle",
      cwd: "/workspace",
      foreground_cwd: "/workspace",
      pane_id: "w1:p2",
      tab_id: "w1:t1",
      terminal_id: "term-w1-p2",
      workspace_id: "w1",
    },
    // Herdr reports whatever kind started in the pane. A harness this proof
    // has never heard of must resolve exactly like the two it has.
    "w1:p3": {
      agent: "grok",
      agent_session: agentSession("grok", "w1:p3"),
      agent_status: "idle",
      cwd: "/workspace",
      foreground_cwd: "/workspace",
      pane_id: "w1:p3",
      tab_id: "w1:t2",
      terminal_id: "term-w1-p3",
      workspace_id: "w1",
    },
  },
  workspaces: { w1: { workspace_id: "w1", label: "workspace" } },
  transcripts: {
    "w1:p1": "Newest user request: refactor Herdr identity.\nCaller marker: proving this exact conversation.",
    "w1:p2": "Different Claude conversation.",
    "w1:p3": "Newest user request: move the caller proof.\nGrok marker: proving this exact conversation.",
  },
  processes: {},
});

const writeState = (state) =>
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
const readState = () => JSON.parse(readFileSync(statePath, "utf8"));
const mutateState = (mutate) => {
  const state = readState();
  mutate(state);
  writeState(state);
};
writeState(baseState());

writeFileSync(
  fakeHerdr,
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.FAKE_HERDR_STATE, "utf8"));
const output = (result) => process.stdout.write(JSON.stringify({ result }) + "\\n");
if (args[0] === "pane" && args[1] === "get") {
  output({ pane: state.panes[args[2]] });
} else if (args[0] === "api" && args[1] === "snapshot") {
  output({
    snapshot: {
      agents: Object.values(state.panes)
        .filter((pane) => pane.agent)
        .map((pane) => ({ ...pane, foreground_cwd: pane.foreground_cwd ?? pane.cwd })),
    },
  });
} else if (args[0] === "pane" && args[1] === "process-info") {
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
    (pane?.agent ? [{ argv: [pane.agent], cwd: pane.cwd, name: pane.agent }] : []);
  // Real herdr reports a pid on every foreground process, and the caller proves
  // itself by ancestry, so panes listed in state.ancestor_panes report a pid the
  // test process really is an ancestor of; every other pane gets an unrelated one.
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
} else if (args[0] === "agent" && args[1] === "read") {
  process.stdout.write(state.transcripts?.[args[2]] ?? "");
} else if (args[0] === "workspace" && args[1] === "get") {
  output({ workspace: state.workspaces?.[args[2]] ?? { workspace_id: args[2] } });
} else {
  process.stderr.write("unsupported fake herdr args: " + args.join(" ") + "\\n");
  process.exit(1);
}
`,
);
chmodSync(fakeHerdr, 0o755);

const env = {
  ...process.env,
  FAKE_HERDR_STATE: statePath,
  TEST_ANCESTOR_PID: String(process.pid),
  HERDR_ENV: "1",
  HERDR_PANE_ID: "stale:pane",
  HERDR_WORKSPACE_ID: "stale:workspace",
  PATH: `${bin}:${process.env.PATH}`,
};
const run = (...args) =>
  execFileSync(process.execPath, [helper, ...args], { encoding: "utf8", env });
const runWithEnv = (overrides, ...args) =>
  execFileSync(process.execPath, [helper, ...args], {
    encoding: "utf8",
    env: { ...env, ...overrides },
  });

const codexMarkers = join(root, "codex-markers.json");
writeFileSync(
  codexMarkers,
  JSON.stringify({
    newest_user_request: "Newest user request: refactor Herdr identity.",
    recent_caller_output: "Caller marker: proving this exact conversation.",
  }),
);
const grokMarkers = join(root, "grok-markers.json");
writeFileSync(
  grokMarkers,
  JSON.stringify({
    newest_user_request: "Newest user request: move the caller proof.",
    recent_caller_output: "Grok marker: proving this exact conversation.",
  }),
);

test("conversation markers resolve the exact caller and emit its pin", () => {
  writeState(baseState());
  const proof = JSON.parse(
    run(
      "--as", "codex",
      "--repo-root", "/workspace",
      "--conversation-markers-file", codexMarkers,
    ),
  );
  assert.deepEqual(proof, {
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
      "--pane", "w1:p1",
      "--workspace", "w1",
      "--tab-id", "w1:t1",
      "--as", "codex",
      "--terminal-id", "term-w1-p1",
      "--repo-root", "/workspace",
    ],
  });
});

test("--format shell quotes every pin value for direct reuse", () => {
  writeState(baseState());
  assert.equal(
    run(
      "--as", "codex",
      "--repo-root", "/workspace",
      "--conversation-markers-file", codexMarkers,
      "--format", "shell",
    ).trim(),
    "'--pane' 'w1:p1' '--workspace' 'w1' '--tab-id' 'w1:t1' '--as' 'codex' '--terminal-id' 'term-w1-p1' '--repo-root' '/workspace'",
  );

  const marker = join(root, "unexpected-format-shell-execution");
  const hostileRepo = `/workspace with 'quotes' $(touch ${marker}) \`false\``;
  mutateState((state) => {
    state.panes["w1:p1"].cwd = hostileRepo;
    state.panes["w1:p1"].foreground_cwd = hostileRepo;
  });
  const shellFormat = run(
    "--as", "codex",
    "--repo-root", hostileRepo,
    "--conversation-markers-file", codexMarkers,
    "--format", "shell",
  ).trim();
  const argv = execFileSync(
    "/bin/sh",
    ["-c", `set -- ${shellFormat}; printf '%s\\n' "$@"`],
    { encoding: "utf8" },
  ).trimEnd().split("\n");
  assert.deepEqual(argv, [
    "--pane", "w1:p1",
    "--workspace", "w1",
    "--tab-id", "w1:t1",
    "--as", "codex",
    "--terminal-id", "term-w1-p1",
    "--repo-root", hostileRepo,
  ]);
  assert.equal(existsSync(marker), false);
});

test("process ancestry resolves the caller with no markers at all", () => {
  writeState(baseState());
  mutateState((state) => {
    state.ancestor_panes = ["w1:p1"];
  });
  const proof = JSON.parse(run("--as", "codex", "--repo-root", "/workspace"));
  assert.equal(proof.pane, "w1:p1");
  assert.equal(proof.proof, "process-ancestry");

  // Claiming to be another harness is a caller mismatch, not a reason to guess.
  assert.throws(
    () => run("--as", "claude", "--repo-root", "/workspace"),
    /runs in a codex pane; --as claude does not match/u,
  );
});

test("any agent kind herdr reports resolves through both proof paths", () => {
  writeState(baseState());
  mutateState((state) => {
    state.ancestor_panes = ["w1:p3"];
  });
  const byAncestry = JSON.parse(run("--as", "grok", "--repo-root", "/workspace"));
  assert.equal(byAncestry.pane, "w1:p3");
  assert.equal(byAncestry.as, "grok");
  assert.equal(byAncestry.proof, "process-ancestry");
  assert.deepEqual(byAncestry.args.slice(6, 8), ["--as", "grok"]);

  mutateState((state) => {
    delete state.ancestor_panes;
  });
  const byMarkers = JSON.parse(
    run(
      "--as", "grok",
      "--repo-root", "/workspace",
      "--conversation-markers-file", grokMarkers,
    ),
  );
  assert.equal(byMarkers.pane, "w1:p3");
  assert.equal(byMarkers.proof, "conversation-markers");

  // A kind with no pane rooted at this repository still hard-stops.
  assert.throws(
    () =>
      run(
        "--as", "gemini",
        "--repo-root", "/workspace",
        "--conversation-markers-file", grokMarkers,
      ),
    /snapshot has no gemini agent rooted at \/workspace/u,
  );
});

test("an absent or empty --as is never guessed", () => {
  writeState(baseState());
  for (const args of [
    ["--repo-root", "/workspace"],
    ["--as", "   ", "--repo-root", "/workspace"],
  ]) {
    assert.throws(() => run(...args), /requires --as <agent-kind>/u);
  }
  assert.throws(() => run(), /usage: caller-proof\.mjs/u);
});

test("an ambiguous or unreadable ancestry never selects a pane on its own", () => {
  writeState(baseState());
  // Panes share ancestors further up, so a chain matching two panes proves
  // nothing and must fall all the way back to the marker proof.
  mutateState((state) => {
    state.ancestor_panes = ["w1:p1", "w1:p2"];
  });
  assert.equal(
    JSON.parse(
      run(
        "--as", "codex",
        "--repo-root", "/workspace",
        "--conversation-markers-file", codexMarkers,
      ),
    ).proof,
    "conversation-markers",
  );
  assert.throws(
    () => run("--as", "codex", "--repo-root", "/workspace"),
    /process ancestry \(it matched zero or several panes\)/u,
  );

  // One match plus one unreadable pane is not uniqueness: the unknown pane
  // could have been the real caller.
  mutateState((state) => {
    state.ancestor_panes = ["w1:p1"];
    state.fail_process_info_pane = "w1:p2";
  });
  assert.throws(
    () => run("--as", "codex", "--repo-root", "/workspace"),
    /process ancestry \(it matched zero or several panes\)/u,
  );
});

test("the proof refuses to run outside Herdr or without an absolute repo root", () => {
  writeState(baseState());
  assert.throws(
    () =>
      runWithEnv(
        { HERDR_ENV: "0" },
        "--as", "codex",
        "--repo-root", "/workspace",
        "--conversation-markers-file", codexMarkers,
      ),
    /requires HERDR_ENV=1/u,
  );
  assert.throws(
    () =>
      run(
        "--as", "codex",
        "--repo-root", "workspace",
        "--conversation-markers-file", codexMarkers,
      ),
    /requires an absolute --repo-root/u,
  );
  assert.throws(
    () => run("--as", "codex", "--repo-root", "/workspace"),
    /requires --conversation-markers-file/u,
  );
});

test("a pane without a terminal id cannot be pinned", () => {
  writeState(baseState());
  mutateState((state) => {
    delete state.panes["w1:p1"].terminal_id;
  });
  assert.throws(
    () =>
      run(
        "--as", "codex",
        "--repo-root", "/workspace",
        "--conversation-markers-file", codexMarkers,
      ),
    /caller pane w1:p1 has no terminal_id; cannot pin identity/u,
  );
});

test("malformed, dead, and duplicated candidates are hard-stopped or ignored", () => {
  writeState(baseState());
  mutateState((state) => {
    state.panes["w2:p1"] = {
      ...state.panes["w1:p1"],
      pane_id: "w2:p1",
      tab_id: "w2:t1",
      terminal_id: "term-w2-p1",
      workspace_id: "w2",
    };
    state.workspaces.w2 = { workspace_id: "w2", label: "duplicate-session" };
    state.transcripts["w2:p1"] = "A different Codex conversation.";
  });

  for (const malformed of [
    null,
    { argv: { 0: "codex" }, cwd: "/workspace", name: "codex" },
    { argv: null, cwd: "/workspace", name: "codex" },
    { argv: ["codex"], cwd: null, name: "codex" },
  ]) {
    mutateState((state) => {
      state.processes["w2:p1"] = [malformed];
    });
    assert.throws(
      () =>
        run(
          "--as", "codex",
          "--repo-root", "/workspace",
          "--conversation-markers-file", codexMarkers,
        ),
      /herdr returned malformed foreground process for pane w2:p1/u,
    );
  }

  // A candidate whose live process is rooted elsewhere is not this caller.
  mutateState((state) => {
    state.processes["w2:p1"] = [
      { argv: ["codex"], cwd: "/different-repository", name: "codex" },
    ];
  });
  assert.equal(
    JSON.parse(
      run(
        "--as", "codex",
        "--repo-root", "/workspace",
        "--conversation-markers-file", codexMarkers,
      ),
    ).pane,
    "w1:p1",
  );

  // A duplicated agent_session is reported, never used to select a pane.
  mutateState((state) => {
    state.processes["w2:p1"][0].cwd = "/workspace";
  });
  const duplicate = JSON.parse(
    run(
      "--as", "codex",
      "--repo-root", "/workspace",
      "--conversation-markers-file", codexMarkers,
    ),
  );
  assert.equal(duplicate.pane, "w1:p1");
  assert.match(duplicate.session_binding_warning, /appears on 2 panes and was ignored/u);

  // Two transcripts carrying the same markers prove nothing.
  mutateState((state) => {
    state.transcripts["w2:p1"] = state.transcripts["w1:p1"];
  });
  assert.throws(
    () =>
      run(
        "--as", "codex",
        "--repo-root", "/workspace",
        "--conversation-markers-file", codexMarkers,
      ),
    /matched 2 candidate transcripts/u,
  );

  mutateState((state) => {
    state.transcripts["w2:p1"] = "";
  });
  assert.throws(
    () =>
      run(
        "--as", "codex",
        "--repo-root", "/workspace",
        "--conversation-markers-file", codexMarkers,
      ),
    /candidate transcript w2:p1 is empty/u,
  );
});

test("conversation markers must be exact, distinct, and substantial", () => {
  writeState(baseState());
  const weak = join(root, "weak-markers.json");
  for (const markers of [
    { newest_user_request: "", recent_caller_output: "a long enough marker" },
    { newest_user_request: "request", recent_caller_output: "short" },
    { newest_user_request: "same marker text", recent_caller_output: "same marker text" },
  ]) {
    writeFileSync(weak, JSON.stringify(markers));
    assert.throws(
      () =>
        run(
          "--as", "codex",
          "--repo-root", "/workspace",
          "--conversation-markers-file", weak,
        ),
      /conversation markers require a nonempty newest_user_request/u,
    );
  }
  assert.throws(
    () =>
      run(
        "--as", "codex",
        "--repo-root", "/workspace",
        "--conversation-markers-file", join(root, "missing.json"),
      ),
    /cannot read conversation markers from/u,
  );
});
